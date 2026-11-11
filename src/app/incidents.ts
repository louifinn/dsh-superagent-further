/**
 * The incident records service (ADR-0004): one durable record per condition, its occurrences, an evidence
 * bundle under `<workspace>/artifacts/incidents/<id>/`, fingerprint dedupe with a cooldown for closed records, a daily
 * budget for new records and an open-incident cap. Detection makes no model call and changes nothing; failures degrade
 * to the `incidents` health entry and a log line instead of breaking the caller.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HealthEntry } from '../infra/health.ts'
import type { Health } from '../sources/host.ts'
import { restrictToOwner } from '../infra/acl.ts'
import type { Settings } from '../policy.ts'
import {
  checkIncidentCandidate, higherSeverity, incidentBudgetExempt, incidentFingerprint, isOpenIncident, parseIncidentDiagnosis,
  transitionIncident, INCIDENT_COOLDOWN_MS, INCIDENT_DETAIL_LIMIT, INCIDENT_EVIDENCE_DAYS, INCIDENT_EVIDENCE_KEEP, INCIDENT_LOG_LIMIT,
  INCIDENT_LOG_WINDOW_MS, INCIDENT_TITLE_LIMIT, incidentSeverityRank, type Incident, type IncidentCandidate, type IncidentDiagnosis,
  type IncidentFilter, type IncidentRepository, type IncidentScope, type IncidentSeverity,
} from '../core/incidents.ts'
import { UserError } from '../core/errors.ts'
import { key } from '../core/ids.ts'
import type { Logs, LogEntry } from './logs.ts'
import { redactData } from './logs.ts'

/** One file in an evidence bundle, named, sized and hashed. */
export interface IncidentEvidenceFile { name: string; bytes: number; sha256: string }
/** The content-addressed manifest of one evidence bundle; `manifest.json` is not itself listed. */
export interface IncidentManifest {
  generated_at: string
  version: string
  rule: string
  fingerprint: string
  content_sha256: string
  files: IncidentEvidenceFile[]
}
/** Where one incident's evidence lives, with the manifest when it was written. */
export interface IncidentEvidence { dir: string; manifest: IncidentManifest | null }
/** The list response the panel and the HTTP API share. */
export interface IncidentListView {
  incidents: Incident[]
  total: number
  status: IncidentFilter['status']
  severity?: IncidentSeverity
  offset: number
  limit: number
}
/** One incident with its evidence summary and its parsed diagnosis (ADR-0005). */
export interface IncidentDetailView { incident: Incident; evidence: IncidentEvidence | null; diagnosis: IncidentDiagnosis | null }

/**
 * The incident table's records (schema 25). Filter columns are stored beside the JSON value so the panel's status,
 * severity and scope filters stay index-friendly; `fingerprint` is UNIQUE, which makes the dedupe invariant the
 * database's as well as the service's.
 */
export class IncidentRecords implements IncidentRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): Incident | undefined {
    const row = this.db.prepare('SELECT value FROM incident WHERE id = ?').get(id)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as Incident
  }

  byFingerprint(fingerprint: string): Incident | undefined {
    const row = this.db.prepare('SELECT value FROM incident WHERE fingerprint = ?').get(fingerprint)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as Incident
  }

  save(incident: Incident): void {
    this.db.prepare(`INSERT INTO incident (id, fingerprint, rule, project, ticket, request, session, severity, status, first_at,
      last_at, occurrences, title, detail, evidence_dir, diagnosis, resolution, updated_at, value) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint, rule=excluded.rule, project=excluded.project,
      ticket=excluded.ticket, request=excluded.request, session=excluded.session, severity=excluded.severity, status=excluded.status,
      first_at=excluded.first_at, last_at=excluded.last_at, occurrences=excluded.occurrences, title=excluded.title, detail=excluded.detail,
      evidence_dir=excluded.evidence_dir, diagnosis=excluded.diagnosis, resolution=excluded.resolution, updated_at=excluded.updated_at,
      value=excluded.value`).run(incident.id, incident.fingerprint, incident.rule, incident.scope.project ?? '', incident.scope.ticket ?? '',
      incident.scope.request ?? '', incident.scope.session ?? '', incident.severity, incident.status, incident.first_at, incident.last_at,
      incident.occurrences, incident.title, incident.detail, incident.evidence_dir, incident.diagnosis ?? null, incident.resolution ?? null,
      incident.updated_at, JSON.stringify(incident))
  }

  list(filter: IncidentFilter = {}): Incident[] {
    const where: string[] = []
    const values: (string | number)[] = []
    if (filter.status !== undefined && filter.status !== 'all') {
      if (filter.status === 'open') where.push("status IN ('detected', 'bundled', 'diagnosed')")
      else { where.push('status = ?'); values.push(filter.status) }
    }
    if (filter.severity !== undefined) { where.push('severity = ?'); values.push(filter.severity) }
    for (const name of ['project', 'ticket', 'request', 'session'] as const) {
      const value = filter.scope?.[name]
      if (value !== undefined && value !== '') { where.push(`${name} = ?`); values.push(value) }
    }
    const limit = filter.limit ?? -1
    const offset = Math.max(0, filter.offset ?? 0)
    const sql = `SELECT value FROM incident${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY last_at DESC, rowid DESC LIMIT ? OFFSET ?`
    const rows = this.db.prepare(sql).all(...values, limit, offset)
    return rows.map(row => JSON.parse(String(row.value)) as Incident)
  }

  openCount(project?: string): number {
    const row = project === undefined
      ? this.db.prepare("SELECT count(*) AS count FROM incident WHERE status IN ('detected', 'bundled', 'diagnosed')").get()
      : this.db.prepare("SELECT count(*) AS count FROM incident WHERE status IN ('detected', 'bundled', 'diagnosed') AND project = ?").get(project)
    return Number(row?.count ?? 0)
  }
}

/** The service's collaborators; the Runtime provides the real ones, a test an exact clock and a temp workspace. */
export interface IncidentsHost {
  store: { incidents: IncidentRepository; settings(): Settings }
  /** The Orchestrator workspace: evidence bundles live under `<workspace>/artifacts/incidents/<id>/`. */
  workspace(): string
  /** The state directory whose `logs/` day files hold the durable log window. */
  stateDir: string
  logs: Logs
  health?: Pick<HealthEntry, 'set'>
  /** Records one operational log line under the `incidents` scope. */
  record?(message: string): void
  now?(): Date
  version?: string | (() => string)
  createId?(): string
  /** Health snapshot for the evidence bundle; absent in unit tests. */
  healthSnapshot?(): Record<string, Health>
  cooldownMs?: number
  openCap?: number
  keepBundles?: number
  keepDays?: number
  logWindowMs?: number
}

const DAY_MS = 24 * 60 * 60_000

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'
}

/** The UTC day an ISO time belongs to, for the daily budget. */
function dayKey(at: Date): string { return at.toISOString().slice(0, 10) }

/**
 * The incident table's records and the detection pass. `record` is the only writer of new records; it never throws for
 * operational failures, and a repeat inside the cooldown stays quiet while an open record only counts occurrences.
 */
export class Incidents {
  private readonly now: () => Date
  private readonly createId: () => string
  private reads = 0
  constructor(private readonly host: IncidentsHost) {
    this.now = host.now ?? (() => new Date())
    this.createId = host.createId ?? (() => `inc-${key('incident', this.now().toISOString(), String(++this.reads)).slice(0, 16)}`)
    this.host.health?.set({ state: 'ready', detail: 'Incident detection is ready', at: this.now().toISOString() })
  }

  /** The configured gate; read per call so a settings change applies without a restart. */
  private config() { return this.host.store.settings().executor.incidents }
  private get cooldownMs(): number { return this.host.cooldownMs ?? INCIDENT_COOLDOWN_MS }
  private get openCap(): number { return this.host.openCap ?? 100 }
  private get keepBundles(): number { return this.host.keepBundles ?? INCIDENT_EVIDENCE_KEEP }
  private get keepDays(): number { return this.host.keepDays ?? INCIDENT_EVIDENCE_DAYS }

  private version(): string {
    const v = this.host.version
    return typeof v === 'function' ? v() : v ?? '0.0.0'
  }

  /**
   * Records one detection. Returns the new or updated record, or `undefined` when the gate, severity, budget, cap or a
   * closed record's cooldown keeps it quiet. The returned record is what the Store holds afterwards.
   */
  record(candidate: IncidentCandidate, options: { at?: Date } = {}): Incident | undefined {
    const at = options.at ?? this.now()
    const config = this.config()
    if (!config.enabled) return undefined
    let valid: IncidentCandidate
    try { valid = checkIncidentCandidate(candidate) } catch (error) {
      // A malformed candidate is a detector bug; degrade to health and the log instead of breaking a pass.
      this.fail('record', error)
      return undefined
    }
    if (incidentSeverityRank(valid.severity) < incidentSeverityRank(config.minimumSeverity)) return undefined
    const fingerprint = incidentFingerprint(valid)
    const existing = this.host.store.incidents.byFingerprint(fingerprint)
    if (existing !== undefined) return this.count(existing, valid, at)
    return this.create(valid, fingerprint, at, config.dailyBudget)
  }

  /** A repeat of a condition: counts inside an open record, or reopens a closed one after its cooldown. */
  private count(existing: Incident, candidate: IncidentCandidate, at: Date): Incident | undefined {
    const time = at.toISOString()
    if (isOpenIncident(existing.status)) {
      const updated: Incident = {
        ...existing,
        last_at: time,
        updated_at: time,
        occurrences: existing.occurrences + 1,
        severity: higherSeverity(existing.severity, candidate.severity),
        title: candidate.title.slice(0, INCIDENT_TITLE_LIMIT),
        detail: candidate.detail.slice(0, INCIDENT_DETAIL_LIMIT),
        scope: { ...existing.scope, ...candidate.scope },
      }
      this.host.store.incidents.save(updated)
      return updated
    }
    // A resolved or dismissed record stays quiet through its cooldown, then reopens the same record.
    const last = Date.parse(existing.last_at)
    if (Number.isFinite(last) && at.getTime() - last < this.cooldownMs) return undefined
    const updated: Incident = {
      ...existing,
      last_at: time,
      updated_at: time,
      occurrences: existing.occurrences + 1,
      severity: higherSeverity(existing.severity, candidate.severity),
      title: candidate.title.slice(0, INCIDENT_TITLE_LIMIT),
      detail: candidate.detail.slice(0, INCIDENT_DETAIL_LIMIT),
      scope: { ...existing.scope, ...candidate.scope },
      status: existing.evidence_dir === '' ? 'detected' : 'bundled',
      resolution: undefined,
    }
    delete (updated as { resolution?: string }).resolution
    if (existing.evidence_dir === '') {
      const bundle = this.writeEvidence(existing.id, candidate, at)
      if (bundle !== undefined) { updated.evidence_dir = bundle; updated.status = 'bundled' }
    }
    this.host.store.incidents.save(updated)
    this.host.record?.(`incident.reopened id=${existing.id} rule=${updated.rule} occurrences=${updated.occurrences}`)
    return updated
  }

  /**
   * A first detection: the daily budget (except for the live-outage rules `health-error` and `stalled-assignment`),
   * the open cap, the record, then its evidence bundle.
   */
  private create(candidate: IncidentCandidate, fingerprint: string, at: Date, dailyBudget: number): Incident | undefined {
    const time = at.toISOString()
    // ADR-0004: a health flip or a stalled Assignment is recorded even when the day's budget is already spent.
    if (!incidentBudgetExempt(candidate.rule)) {
      const today = dayKey(at)
      if (dailyBudget <= 0) return undefined
      const created = this.host.store.incidents.list({ status: 'all' }).filter(item => dayKey(new Date(item.first_at)) === today)
      if (created.length >= dailyBudget) return undefined
    }
    if (this.host.store.incidents.openCount() >= this.openCap) return undefined
    const id = this.createId()
    const base: Incident = {
      id, fingerprint, rule: candidate.rule, scope: candidate.scope ?? {}, severity: candidate.severity, status: 'detected',
      first_at: time, last_at: time, occurrences: 1, title: candidate.title.slice(0, INCIDENT_TITLE_LIMIT),
      detail: candidate.detail.slice(0, INCIDENT_DETAIL_LIMIT), evidence_dir: '', updated_at: time,
    }
    const bundle = this.writeEvidence(id, candidate, at)
    if (bundle !== undefined) { base.evidence_dir = bundle; base.status = 'bundled' }
    this.host.store.incidents.save(base)
    this.host.record?.(`incident.recorded id=${id} rule=${base.rule} severity=${base.severity} occurrences=${base.occurrences}`)
    return base
  }

  /** Resolves the open record with this fingerprint when the condition cleared; repeats reopen it after the cooldown. */
  recover(fingerprint: string, at: Date = this.now()): Incident | undefined {
    const existing = this.host.store.incidents.byFingerprint(fingerprint)
    if (existing === undefined || !isOpenIncident(existing.status)) return undefined
    const updated: Incident = { ...existing, status: 'resolved', resolution: 'The condition cleared.', updated_at: at.toISOString() }
    this.host.store.incidents.save(updated)
    this.host.record?.(`incident.recovered id=${existing.id} rule=${existing.rule}`)
    return updated
  }

  /** The filtered, paged list; the detail route and the panel share it. */
  list(filter: IncidentFilter = {}): Incident[] { return this.host.store.incidents.list(filter) }

  /** How many records match, before paging. */
  total(filter: IncidentFilter = {}): number { return this.host.store.incidents.list({ ...filter, offset: 0, limit: undefined }).length }

  detail(id: string): IncidentDetailView | undefined {
    const incident = this.host.store.incidents.get(id)
    if (incident === undefined) return undefined
    return { incident, evidence: incident.evidence_dir === '' ? null : this.evidence(id) ?? null,
      diagnosis: parseIncidentDiagnosis(incident.diagnosis) }
  }

  /**
   * Closes an open record with an operator's reason (ADR-0005). The record stays for the audit trail in `dismissed`;
   * a repeat inside the cooldown stays quiet, and a later repeat may reopen the same record.
   */
  dismiss(id: string, reason: string, at: Date = this.now()): Incident {
    const existing = this.host.store.incidents.get(id)
    if (existing === undefined) throw new UserError('incidentUnknown', { incident: id })
    const why = reason.replace(/\s+/g, ' ').trim()
    if (why === '') throw new UserError('incidentInvalid', { reason: 'reason' })
    const updated = transitionIncident(existing, 'dismissed', at.toISOString(), { resolution: `Dismissed: ${why.slice(0, 280)}` })
    this.host.store.incidents.save(updated)
    this.host.record?.(`incident.dismissed id=${id}`)
    return updated
  }

  /** The evidence bundle on disk for an incident, with its parsed manifest when one exists. */
  evidence(id: string): IncidentEvidence | undefined {
    const incident = this.host.store.incidents.get(id)
    const dir = incident?.evidence_dir || this.evidenceDir(id)
    if (!existsSync(dir)) return undefined
    const path = join(dir, 'manifest.json')
    let manifest: IncidentManifest | null = null
    if (existsSync(path)) {
      try { manifest = JSON.parse(readFileSync(path, 'utf8')) as IncidentManifest } catch { manifest = null }
    }
    return { dir, manifest }
  }

  /** Evidence bundles live beside the workspace, so export and backup carry them with the records they explain. */
  evidenceDir(id: string): string { return join(this.host.workspace(), 'artifacts', 'incidents', id) }

  private fail(where: string, error: unknown): void {
    const detail = `The incident ${where} failed: ${reason(error)}`
    this.host.health?.set({ state: 'error', detail, at: this.now().toISOString() })
    this.host.record?.(detail)
  }

  /**
   * Writes the bundle: redacted settings, health, a bounded log window from the durable JSONL files and the ring, and
   * the related ids. Every file is hashed into `manifest.json`; the manifest is written last. Any failure returns
   * `undefined` and reports through health and the log, so the record is still saved as `detected`.
   */
  private writeEvidence(id: string, candidate: IncidentCandidate, at: Date): string | undefined {
    let dir = ''
    try {
      const config = this.config()
      dir = this.evidenceDir(id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      restrictToOwner(dir, true)
      const scope: IncidentScope = candidate.scope ?? {}
      const files: { name: string; body: string }[] = []
      const settings = redactData(this.host.store.settings()) as Record<string, unknown>
      files.push({ name: 'config.json', body: JSON.stringify({ schema: 25, version: this.version(), generated_at: at.toISOString(),
        rule: candidate.rule, scope, severity: candidate.severity, incidents: config, settings }, null, 2) })
      const snapshot = this.host.healthSnapshot?.() ?? {}
      files.push({ name: 'health.json', body: JSON.stringify(snapshot, null, 2) })
      files.push({ name: 'related.json', body: JSON.stringify({ rule: candidate.rule, scope, ticket: scope.ticket ?? null,
        request: scope.request ?? null, session: scope.session ?? null, project: scope.project ?? null }, null, 2) })
      files.push({ name: 'log-window.jsonl', body: this.logWindow(at) })
      const entries: IncidentEvidenceFile[] = []
      for (const file of files) {
        const path = join(dir, file.name)
        writeFileSync(path, file.body, { mode: 0o600 })
        restrictToOwner(path, false)
        entries.push({ name: file.name, bytes: Buffer.byteLength(file.body), sha256: createHash('sha256').update(file.body).digest('hex') })
      }
      const manifest: IncidentManifest = {
        generated_at: at.toISOString(), version: this.version(), rule: candidate.rule, fingerprint: incidentFingerprint(candidate),
        content_sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), files: entries,
      }
      const manifestPath = join(dir, 'manifest.json')
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
      restrictToOwner(manifestPath, false)
      this.prune()
      return dir
    } catch (error) {
      if (dir !== '') { try { rmSync(dir, { recursive: true, force: true }) } catch { /* Best effort. */ } }
      this.fail('evidence bundle', error)
      return undefined
    }
  }

  /** The bounded log window ending at the detection, from the durable day files and the in-memory ring. */
  private logWindow(at: Date): string {
    const since = at.getTime() - (this.host.logWindowMs ?? INCIDENT_LOG_WINDOW_MS)
    const lines: { at: string; line: string }[] = []
    const seen = new Set<string>()
    const add = (entry: LogEntry): void => {
      const time = Date.parse(entry.at)
      if (!Number.isFinite(time) || time < since || time > at.getTime()) return
      const line = JSON.stringify(entry)
      if (seen.has(line)) return
      seen.add(line)
      lines.push({ at: entry.at, line })
    }
    for (const entry of this.host.logs.list({ limit: 2000 })) add(entry)
    const logsDir = join(this.host.stateDir, 'logs')
    if (existsSync(logsDir)) {
      for (const name of readdirSync(logsDir).filter(name => name.endsWith('.jsonl')).sort()) {
        let body = ''
        try { body = readFileSync(join(logsDir, name), 'utf8') } catch { continue }
        for (const line of body.split('\n')) {
          if (line.trim() === '') continue
          try { add(JSON.parse(line) as LogEntry) } catch { /* A torn line is skipped. */ }
        }
      }
    }
    lines.sort((a, b) => a.at.localeCompare(b.at))
    return lines.slice(-INCIDENT_LOG_LIMIT).map(item => item.line).join('\n').concat(lines.length === 0 ? '' : '\n')
  }

  /** Keeps the newest `keepBundles` and drops anything older than `keepDays`, so bundles cannot grow without bound. */
  private prune(): void {
    const root = join(this.host.workspace(), 'artifacts', 'incidents')
    if (!existsSync(root)) return
    const cutoff = this.now().getTime() - this.keepDays * DAY_MS
    const bundles: { path: string; at: number }[] = []
    for (const name of readdirSync(root)) {
      const path = join(root, name)
      try {
        const stat = statSync(path)
        if (!stat.isDirectory()) continue
        const manifest = join(path, 'manifest.json')
        const at = existsSync(manifest) ? statSync(manifest).mtimeMs : stat.mtimeMs
        if (at < cutoff) { rmSync(path, { recursive: true, force: true }); continue }
        bundles.push({ path, at })
      } catch { /* A bundle that cannot be read is left alone. */ }
    }
    bundles.sort((a, b) => b.at - a.at)
    for (const stale of bundles.slice(Math.max(0, this.keepBundles))) {
      try { rmSync(stale.path, { recursive: true, force: true }) } catch { /* Best effort. */ }
    }
  }
}

/** The `incidents` health entry's detail on a fresh host, also used by the Runtime's startup summary. */
export const INCIDENTS_HEALTH_NAME = 'incidents'
/** A thrown `UserError` for an unknown record, so HTTP and tools answer 404 consistently. */
export function requireIncident(records: IncidentRepository, id: string): Incident {
  const incident = records.get(id)
  if (incident === undefined) throw new UserError('incidentUnknown', { incident: id })
  return incident
}
