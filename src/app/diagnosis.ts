/**
 * Read-only incident diagnosis (ADR-0005). A deterministic detector only records an incident; this service turns a
 * high or critical bundle into one bounded, asynchronous dispatch of the `diagnostician` preset through DSH's subagent
 * service, parses the strict-JSON answer, stores it on the record and routes the finding through the existing
 * self-evolution outlets: a discovery Request for a registered project, a self-report draft for this repository, and
 * nothing at all for an operational conclusion.
 *
 * Bounds are programmatic: the preset has no mutating tool (cordis.patch.yml), the child Session is put under the
 * read-only permission preset, one run happens at a time, and a durable UTC-day budget caps the runs. Errors and timeouts
 * never escape into the detector pass: the record stays `bundled`, the `incidents` health entry says why, and a person
 * can retry from the panel.
 */
import { randomBytes } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EngineForMainSession } from '../core/engine.ts'
import type { Incident, IncidentDiagnosis, DiagnosisTarget } from '../core/incidents.ts'
import { incidentSeverityRank, parseIncidentDiagnosis, transitionIncident } from '../core/incidents.ts'
import { PROJECT_REQUEST_INSTRUCTION_LIMIT, PROJECT_REQUEST_TITLE_LIMIT } from '../core/model.ts'
import { SELF_REPORT_TITLE_LIMIT, SELF_REPOSITORY } from '../core/self-reports.ts'
import type { Activation, ActivationSpec, SubagentService } from '../executor/lead-dispatch.ts'
import type { HealthEntry } from '../infra/health.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import type { Health } from '../sources/host.ts'
import type { IncidentSignal } from './incident-detectors.ts'
import { DIAGNOSTICIAN_PRESET } from './sessions.ts'
import type { Logs } from './logs.ts'
import type { SelfReports } from './self-reports.ts'
import type { Store } from './store.ts'

/** ADR-0005: one diagnosis may hold a dispatch for at most ten minutes before it is disposed and retried later. */
export const DIAGNOSIS_TIMEOUT_MS = 600_000
/** The log scope of the diagnosis service; detectors skip it so a diagnosis can never feed itself. */
export const DIAGNOSIS_SCOPE = 'diagnosis'
/** The child Session id prefix of a diagnosis dispatch; excluded from incident detection and from Session decoration. */
export const DIAGNOSIS_SESSION_PREFIX = 'diag-'

/** The diagnosis document the model was asked for; a parse failure keeps the raw text at low confidence instead. */
export interface DiagnoseRefused { status: 'refused'
  /** `stale` means the record changed while the run was in flight; the newer state was kept, never overwritten. */
  reason: 'unknown' | 'status' | 'budget' | 'concurrent' | 'timeout' | 'failed' | 'stale' }
export type DiagnoseResult =
  | { status: 'diagnosed'; incident: Incident; diagnosis: IncidentDiagnosis
    /** The routing outcome of this run (`request:<id>`, `self-report:<id>`, `operational`), when it created one. */
    resolution?: string }
  | DiagnoseRefused
/** `concurrent` means another route already holds this record; `conflict` means an operator action won the settle. */
export type RouteRefusal = 'unknown' | 'notDiagnosed' | 'notRoutable' | 'alreadyRouted' | 'concurrent' | 'conflict' | 'failed'
export type RouteResult =
  | { status: 'routed'; incident: Incident; resolution: string }
  | { status: 'refused'; reason: RouteRefusal }

/** Everything the service needs; the Runtime supplies DSH services, a test an exact clock and a fake subagent service. */
export interface DiagnosisHost {
  store: Store
  engine: Pick<EngineForMainSession, 'raiseDiscoveryRequest'>
  selfReports: Pick<SelfReports, 'raise'>
  /** The selected Orchestrator workspace; never the state directory (ADR-0003). */
  workspace(): string
  /** The main Session's Agent id, which the diagnosis child is parented to and which raises a self-report. */
  masterId: string
  parent(): Agent | undefined
  subagents(): SubagentService | undefined
  child(id: string): Agent | undefined
  /** Puts the child Session under DSH's read-only permission preset (defense in depth beside the preset's tool list). */
  readOnly(agent: Agent): void
  lifetime: AbortSignal
  logs: Pick<Logs, 'record'>
  health?: Pick<HealthEntry, 'get' | 'set'>
  now?(): Date
  timeoutMs?: number
}

/** The sentinel a bounded wait resolves to when its deadline or the Runtime's lifetime passes. */
const TIMED_OUT = Symbol('diagnosis timed out')

/**
 * A wait bounded by a deadline and by the Runtime's lifetime. The timer is unref'd so a pending diagnosis never keeps
 * the process alive on its own.
 */
function bounded<T>(work: Promise<T>, signal: AbortSignal, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (run: () => void) => { if (!settled) { settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); run() } }
    const timer = setTimeout(() => finish(() => { resolve(TIMED_OUT) }), Math.max(1, ms))
    timer.unref?.()
    const abort = () => finish(() => { resolve(TIMED_OUT) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    work.then(value => finish(() => { resolve(value) }), error => finish(() => { reject(error) }))
  })
}

/** One short line for a log or a health detail; never the diagnosis text, ids and conclusions only. */
function short(value: unknown, max = 200): string {
  const line = (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`
}

/** The first text answer in a SubagentResult, or undefined when it carried none. */
function answerText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map(answerText).filter((part): part is string => part !== undefined)
    return parts.length === 0 ? undefined : parts.join('')
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as { output?: unknown; text?: unknown }
    if (record.output !== undefined) return answerText(record.output)
    if (typeof record.text === 'string') return record.text
  }
  return undefined
}

/**
 * The diagnosis in a model answer: the first `{...}` object that parses as one, tolerating a Markdown fence. An answer
 * that holds none is kept verbatim at low confidence with no target, so a person still reads what the model said.
 */
function readDiagnosis(answer: string): IncidentDiagnosis {
  let body = answer.trim()
  const fenced = /```(?:json)?\s*(?<body>[\s\S]*?)```/i.exec(body)
  if (fenced?.groups?.body !== undefined) body = fenced.groups.body.trim()
  const start = body.indexOf('{'), end = body.lastIndexOf('}')
  const document = start >= 0 && end > start ? body.slice(start, end + 1) : body
  const parsed = parseIncidentDiagnosis(document) ?? parseIncidentDiagnosis(body)
  if (parsed !== null) return parsed
  const raw = answer.trim()
  return { rootCause: raw.slice(0, 4000), evidence: [], hypotheses: [], fixPlan: '', confidence: 'low',
    target: { kind: 'none' }, parsed: false, raw }
}

/** The workspace-relative evidence path; a self-report refuses absolute paths, so the bundle is named this way. */
function evidencePath(incidentId: string): string { return `artifacts/incidents/${incidentId}/` }

/** The UTC day a time belongs to, for the diagnosis budget. */
function dayKey(at: Date): string { return at.toISOString().slice(0, 10) }

/**
 * The bounded diagnosis dispatcher (ADR-0005). `consider` is the detector's entry point and never throws; `diagnose`
 * is the operator's and returns a value. `route` is idempotent per incident through `incident.resolution`, single-flight
 * per incident while it awaits a work item, and settle compares-and-swaps so a dismissal or recovery that lands during
 * that await is never overwritten (ADR-0005 §7).
 */
export class Diagnosis {
  private readonly now: () => Date
  private readonly timeoutMs: number
  /** The incident whose diagnosis is running; DSH's subagent dispatch is serialized by ADR-0005. */
  private active: string | undefined
  private busy: Promise<unknown> | undefined
  /** Records whose route is currently awaiting a work item; a second overlapping route is refused, never duplicated. */
  private readonly routing = new Set<string>()
  constructor(private readonly host: DiagnosisHost) {
    this.now = host.now ?? (() => new Date())
    this.timeoutMs = host.timeoutMs ?? DIAGNOSIS_TIMEOUT_MS
  }

  /** The configured gate; read per call so a settings change applies without a restart. */
  private config(): Settings['executor']['incidents'] { return this.host.store.settings().executor.incidents }

  /**
   * The detector's hook: a new high or critical record may start one diagnosis on a later turn. It never throws and
   * never awaits — the detection pass records the incident and returns before any model call starts.
   */
  consider(incident: Incident): void {
    const config = this.config()
    if (!config.enabled || !config.autoDiagnose) return
    if (incident.severity !== 'high' && incident.severity !== 'critical') return
    if (incidentSeverityRank(incident.severity) < incidentSeverityRank(config.minimumSeverity)) return
    if (incident.status !== 'bundled' && incident.status !== 'detected') return
    if (this.active === incident.id) return
    const id = incident.id
    setTimeout(() => { void this.diagnose(id).catch(() => undefined) }, 0).unref?.()
  }

  /** Resolves when no diagnosis is waiting or running; the Runtime uses it to stop cleanly. */
  idle(): Promise<void> { return this.busy === undefined ? Promise.resolve() : this.busy.then(() => undefined, () => undefined) }

  /**
   * Diagnoses one record and, on success, routes it once. Returns a refusal instead of throwing for every expected
   * stop: unknown record, closed record, budget, another run, timeout and failure.
   */
  async diagnose(id: string): Promise<DiagnoseResult> {
    const incident = this.host.store.incidents.get(id)
    if (incident === undefined) return { status: 'refused', reason: 'unknown' }
    if (incident.status !== 'bundled' && incident.status !== 'detected') return { status: 'refused', reason: 'status' }
    if (!this.config().enabled) return { status: 'refused', reason: 'status' }
    if (this.active !== undefined) return { status: 'refused', reason: 'concurrent' }
    const parent = this.host.parent()
    const service = this.host.subagents()
    if (parent === undefined || service === undefined) return this.failed(id, 'the subagent service or main Session is unavailable')
    if (!this.claimBudget()) return { status: 'refused', reason: 'budget' }
    this.active = id
    const run = this.execute(incident, parent, service)
    const busy = run.then(() => undefined, () => undefined)
    this.busy = busy
    try { return await run } finally {
      this.active = undefined
      if (this.busy === busy) this.busy = undefined
    }
  }

  /** Claims one of the day's runs from the Store, atomically, so a restart cannot spend the budget twice. */
  private claimBudget(): boolean {
    const limit = this.config().diagnoseDailyBudget
    if (limit <= 0) return false
    const day = dayKey(this.now())
    return this.host.store.atomic(() => {
      const spent = this.host.store.get(KV.incidents.diagnoses(day)) ?? 0
      if (spent >= limit) return false
      this.host.store.set(KV.incidents.diagnoses(day), spent + 1)
      return true
    })
  }

  /** One dispatch, bounded end to end: start the child, put it under read-only, wait for its answer, then route. */
  private async execute(incident: Incident, parent: Agent, service: SubagentService): Promise<DiagnoseResult> {
    const at = this.now()
    const workspace = this.host.workspace()
    if (workspace === '') return this.failed(incident.id, 'the Orchestrator workspace is not selected')
    const childId = `${DIAGNOSIS_SESSION_PREFIX}${incident.id}-${randomBytes(4).toString('hex')}`
    const controller = new AbortController()
    const lifetime = () => { controller.abort() }
    this.host.lifetime.addEventListener('abort', lifetime, { once: true })
    const deadline = Date.now() + this.timeoutMs
    const spec: ActivationSpec = { provider: 'spawn', label: `diagnose incident ${incident.id}`, childId,
      request: { cwd: workspace, agentPreset: DIAGNOSTICIAN_PRESET, prompt: [{ type: 'text', text: this.prompt(incident, workspace) }],
        parent, maxDepth: 1 },
      signal: controller.signal, delivery: 'caller' }
    let activation: Activation | undefined
    try {
      const start = service.startActivation(spec)
      const started = await bounded(start, controller.signal, deadline - Date.now())
      if (started === TIMED_OUT) {
        // The start itself outlived the budget: abort it, and dispose the activation if it still arrives later so the
        // child Session is never left unobserved (ADR-0005 §5).
        controller.abort()
        void start.then(late => { void Promise.resolve(late.dispose()).catch(() => undefined) }, () => undefined)
        return this.timeout(incident.id)
      }
      activation = started
      const child = this.host.child(childId)
      if (child !== undefined) this.host.readOnly(child)
      let answer: unknown
      try { answer = await bounded(activation.result, controller.signal, deadline - Date.now()) } catch (error) {
        void Promise.resolve(activation.dispose()).catch(() => undefined)
        return this.failed(incident.id, error)
      }
      if (answer === TIMED_OUT) { void Promise.resolve(activation.dispose()).catch(() => undefined); return this.timeout(incident.id) }
      const text = answerText(answer)
      if (text === undefined || text.trim() === '') { void Promise.resolve(activation.dispose()).catch(() => undefined)
        return this.failed(incident.id, 'the diagnosis returned no text') }
      const diagnosis = readDiagnosis(text)
      // Compare-and-swap (ADR-0005 §5): reread the live record, merge only the diagnosis, and refuse if a dismissal,
      // resolution or repeat changed the row while the child ran. The newer state always wins.
      const current = this.host.store.incidents.get(incident.id)
      if (current === undefined) {
        void Promise.resolve(activation.dispose()).catch(() => undefined)
        return this.stale(incident.id, 'the record no longer exists')
      }
      if ((current.status !== 'bundled' && current.status !== 'detected') || current.updated_at !== incident.updated_at) {
        void Promise.resolve(activation.dispose()).catch(() => undefined)
        return this.stale(incident.id, `status=${current.status} updated_at=${current.updated_at}`)
      }
      const updated = transitionIncident(current, 'diagnosed', this.now().toISOString(), { diagnosis: JSON.stringify(diagnosis) })
      if (!this.host.store.incidents.swap(updated, { status: incident.status, updated_at: incident.updated_at })) {
        void Promise.resolve(activation.dispose()).catch(() => undefined)
        return this.stale(incident.id, 'the record changed during the write')
      }
      this.host.health?.set({ state: 'ready', detail: 'Incident diagnosis is ready', at: this.now().toISOString() })
      this.host.logs.record('info', DIAGNOSIS_SCOPE, `diagnosis.diagnosed id=${incident.id} confidence=${diagnosis.confidence} target=${diagnosis.target.kind}`)
      const routed = await this.route(incident.id)
      const stored = this.host.store.incidents.get(incident.id) ?? updated
      void Promise.resolve(activation.dispose()).catch(() => undefined)
      return { status: 'diagnosed', incident: routed.status === 'routed' ? routed.incident : stored, diagnosis,
        ...(routed.status === 'routed' ? { resolution: routed.resolution } : {}) }
    } catch (error) {
      void Promise.resolve(activation?.dispose()).catch(() => undefined)
      return this.failed(incident.id, error)
    } finally {
      this.host.lifetime.removeEventListener('abort', lifetime)
    }
  }

  /** The exact instruction the diagnostician preset reads; it carries the incident and its evidence, nothing secret. */
  private prompt(incident: Incident, workspace: string): string {
    const json = JSON.stringify({ id: incident.id, rule: incident.rule, severity: incident.severity, title: incident.title,
      detail: incident.detail, scope: incident.scope, occurrences: incident.occurrences, first_at: incident.first_at,
      last_at: incident.last_at }, null, 2)
    const evidence = this.host.store.incidents.get(incident.id)?.evidence_dir || `${workspace}/artifacts/incidents/${incident.id}`
    return [
      'You are diagnosing one operational incident of the dsh-superagent-further Orchestrator. You have read-only tools only.',
      `Incident JSON:\n${json}`,
      `Evidence directory: ${evidence}\nWorkspace: ${workspace}`,
      'Read the evidence files (config.json, health.json, related.json, log-window.jsonl, manifest.json) before concluding.',
      'Return one STRICT JSON object and nothing else, with exactly these keys: '
        + '{ "rootCause": string, "evidence": string[], "hypotheses": string[], "fixPlan": string, '
        + '"confidence": "low" | "medium" | "high", '
        + '"target": { "kind": "project", "project": "<registered project id, name or repository>" } | { "kind": "self" } '
        + '| { "kind": "operational" } | { "kind": "none" } }.',
      'A code or architecture defect belongs to a registered project; a defect in the Orchestrator itself is self. '
        + 'An operational or environment failure is operational, and none means you could not tell. '
        + 'Cite the evidence files you read and keep the fix plan concrete.',
      'Do not write, edit, or run anything. Your Session has no tool that changes a file or starts work.',
    ].join('\n\n')
  }

  /**
   * Routes one diagnosed record through the existing self-evolution outlets, at most once: `incident.resolution` is the
   * guard. A registered project (or the self repository when a project registers it) raises a discovery Request that the
   * Lead turns into Tickets; a finding about this repository's own code becomes a self-report when the self repository is
   * not registered; an operational conclusion creates neither. The await path holds a per-incident reservation, and
   * settlement is a compare-and-swap, so overlapping calls create at most one work item and a dismissal/recovery that
   * lands meanwhile wins.
   */
  async route(id: string, options: { manual?: boolean } = {}): Promise<RouteResult> {
    if (this.routing.has(id)) return { status: 'refused', reason: 'concurrent' }
    this.routing.add(id)
    try {
      return await this.routeOnce(id, options)
    } finally {
      this.routing.delete(id)
    }
  }

  private async routeOnce(id: string, options: { manual?: boolean }): Promise<RouteResult> {
    const incident = this.host.store.incidents.get(id)
    if (incident === undefined) return { status: 'refused', reason: 'unknown' }
    // The compare-and-swap snapshot for every settlement on this route: a newer write during `resolve` wins.
    const expected = { status: incident.status, updated_at: incident.updated_at }
    // Only a diagnosed record may create work (ADR-0005 §7). Reopening a dismissed record keeps its old diagnosis for a
    // person to read but clears the resolution, so the status guard is what stops that stale text from routing again.
    if (incident.status !== 'diagnosed') return { status: 'refused', reason: 'notDiagnosed' }
    const diagnosis = parseIncidentDiagnosis(incident.diagnosis)
    // An unreadable answer names no target: the automatic route records that as operational, while a person asking to
    // create work explicitly is told there is nowhere to route it.
    if (diagnosis === null) return options.manual === true ? { status: 'refused', reason: 'notDiagnosed' } : this.settle(incident, 'operational', expected)
    if (diagnosis.target.kind === 'none') return options.manual === true ? { status: 'refused', reason: 'notRoutable' } : this.settle(incident, 'operational', expected)
    if (incident.resolution !== undefined && incident.resolution !== '') return { status: 'refused', reason: 'alreadyRouted' }
    try {
      const resolution = await this.resolve(incident, diagnosis)
      return this.settle(incident, resolution, expected)
    } catch (error) {
      this.host.logs.record('warn', DIAGNOSIS_SCOPE, `diagnosis.route-failed id=${id} reason=${short(error)}`)
      return { status: 'refused', reason: 'failed' }
    }
  }

  /**
   * Stores one routing outcome, which is also the guard that keeps an incident from routing twice. The save is a
   * compare-and-swap on the status and `updated_at` captured when the route started: a dismissal, recovery or repeat that
   * landed during `resolve` is newer state and must survive. Work already created before the swap lost is logged (with
   * the resolution id when there is one) so it stays observable; it is never recorded on the record or deleted.
   */
  private settle(incident: Incident, resolution: string, expected: Pick<Incident, 'status' | 'updated_at'>): RouteResult {
    const current = this.host.store.incidents.get(incident.id)
    if (current === undefined || current.status !== 'diagnosed' || current.updated_at !== expected.updated_at
      || (current.resolution !== undefined && current.resolution !== '')) {
      this.conflict(incident.id, resolution, current)
      return { status: 'refused', reason: 'conflict' }
    }
    const updated: Incident = { ...current, resolution, updated_at: this.now().toISOString() }
    if (!this.host.store.incidents.swap(updated, expected)) {
      this.conflict(incident.id, resolution, this.host.store.incidents.get(incident.id))
      return { status: 'refused', reason: 'conflict' }
    }
    this.host.logs.record('info', DIAGNOSIS_SCOPE, `diagnosis.routed id=${incident.id} resolution=${resolution}`)
    return { status: 'routed', incident: updated, resolution }
  }

  private conflict(id: string, created: string, current: Incident | undefined): void {
    this.host.logs.record('warn', DIAGNOSIS_SCOPE,
      `diagnosis.route-conflict id=${id} created=${created} status=${current?.status ?? 'missing'}`)
  }

  /** The one routing decision: a destination id for a Request, or `operational` for a conclusion with no work item. */
  private async resolve(incident: Incident, diagnosis: IncidentDiagnosis): Promise<string> {
    if (diagnosis.target.kind === 'project') {
      const project = this.projectFor(diagnosis.target) ?? this.namedProject(diagnosis)
      if (project !== undefined) return `request:${this.raiseRequest(incident, diagnosis, project.id).id}`
      // A defect in a repository this installation does not manage becomes work on this repository: the Issue outlet
      // refuses jurisdiction exactly when a project registers the self repository, so that case uses the Request outlet.
      const self = this.selfProject()
      if (self !== undefined) return `request:${this.raiseRequest(incident, diagnosis, self.id).id}`
      return this.raiseSelfReport(incident, diagnosis)
    }
    if (diagnosis.target.kind === 'self') {
      const self = this.selfProject()
      if (self !== undefined) return `request:${this.raiseRequest(incident, diagnosis, self.id).id}`
      return this.raiseSelfReport(incident, diagnosis)
    }
    // Operational or none: the record keeps the diagnosis; no Request and no Issue are created.
    return 'operational'
  }

  private raiseRequest(incident: Incident, diagnosis: IncidentDiagnosis, project: string) {
    const title = `Fix incident ${incident.id}: ${incident.title}`.slice(0, PROJECT_REQUEST_TITLE_LIMIT)
    const instruction = [
      `Incident ${incident.id} (${incident.rule}, ${incident.severity}) was diagnosed read-only.`,
      `Root cause: ${diagnosis.rootCause}`,
      ...diagnosis.hypotheses.length === 0 ? [] : [`Hypotheses: ${diagnosis.hypotheses.join('; ')}`],
      `Fix plan: ${diagnosis.fixPlan}`,
      `Evidence bundle: ${evidencePath(incident.id)} (config.json, health.json, related.json, log-window.jsonl).`,
    ].join('\n\n').slice(0, PROJECT_REQUEST_INSTRUCTION_LIMIT)
    return this.host.engine.raiseDiscoveryRequest({ title, instruction, units: [{ project, title: `Fix incident ${incident.id}` }] })
  }

  /** The self-evolution Issue outlet: it owns the three-state gate, the jurisdiction check and the dedupe. */
  private async raiseSelfReport(incident: Incident, diagnosis: IncidentDiagnosis): Promise<string> {
    const title = `Incident ${incident.id}: ${incident.title}`.slice(0, SELF_REPORT_TITLE_LIMIT)
    const evidence = [
      `Root cause: ${diagnosis.rootCause}`,
      `Hypotheses: ${diagnosis.hypotheses.join('; ') || 'none recorded'}`,
      `Fix plan: ${diagnosis.fixPlan || 'none recorded'}`,
      `Confidence: ${diagnosis.confidence}`,
      `Evidence bundle: ${evidencePath(incident.id)}`,
    ].join('\n\n')
    const reproduction = `The ${incident.rule} detector recorded this condition ${incident.occurrences} time(s), `
      + `most recently at ${incident.last_at}, and bundled its evidence without a model call.`
    const outcome = await this.host.selfReports.raise({ title, evidence, reproduction, session: this.host.masterId })
    if (outcome.status === 'off') return 'self-report:off'
    return `self-report:${outcome.report.id}`
  }

  private selfProject() {
    return this.host.store.settings().executor.projects.find(project =>
      project.repository !== undefined && sameName(project.repository, SELF_REPOSITORY))
  }

  private projectFor(target: Extract<DiagnosisTarget, { kind: 'project' }>) {
    const name = target.project.trim()
    if (name === '') return undefined
    return this.host.store.settings().executor.projects.find(project =>
      sameName(project.id, name) || sameName(project.name, name)
      || (project.repository !== undefined && sameName(project.repository, name)))
  }

  /** A registered project the diagnosis text names, for a model that filled `target` only loosely. */
  private namedProject(diagnosis: IncidentDiagnosis) {
    const text = [diagnosis.rootCause, diagnosis.fixPlan, ...diagnosis.hypotheses, diagnosis.raw ?? ''].join('\n').toLowerCase()
    return this.host.store.settings().executor.projects.find(project =>
      [project.id, project.name, project.repository ?? ''].some(value => value !== '' && text.includes(value.toLowerCase())))
  }

  /** A run that finished after the record moved on: the newer state wins, and health is not turned into an error. */
  private stale(id: string, why: string): DiagnoseRefused {
    this.host.logs.record('warn', DIAGNOSIS_SCOPE, `diagnosis.stale id=${id} reason=${short(why)}`)
    return { status: 'refused', reason: 'stale' }
  }

  private timeout(id: string): DiagnoseRefused {
    const seconds = Math.round(this.timeoutMs / 1000)
    this.host.health?.set({ state: 'error', detail: `The diagnosis of incident ${id} timed out after ${seconds} seconds`,
      at: this.now().toISOString() })
    this.host.logs.record('warn', DIAGNOSIS_SCOPE, `diagnosis.timeout id=${id} after=${seconds}s`)
    return { status: 'refused', reason: 'timeout' }
  }

  private failed(id: string, error: unknown): DiagnoseRefused {
    const detail = `The diagnosis of incident ${id} failed: ${short(error)}`
    this.host.health?.set({ state: 'error', detail, at: this.now().toISOString() })
    this.host.logs.record('warn', DIAGNOSIS_SCOPE, `diagnosis.failed id=${id} reason=${short(error)}`)
    return { status: 'refused', reason: 'failed' }
  }
}

/** True for a diagnosis child Session, which no incident detector may read as a worker. */
export function isDiagnosisSession(id: string): boolean { return id.startsWith(DIAGNOSIS_SESSION_PREFIX) }

/**
 * The ingestion guard both detector paths share (ADR-0005 §10): a candidate scoped to a diagnosis child Session is never
 * detector input. The event path carries no Session today, so this is defense in depth there rather than a live filter.
 */
export function withoutDiagnosisSignals(signals: readonly IncidentSignal[]): IncidentSignal[] {
  return signals.filter(signal => signal.type !== 'detect' || !isDiagnosisSession(signal.candidate.scope?.session ?? ''))
}
