/**
 * Incidents: the deterministic rule watchers and the durable incident record. Fingerprints dedupe a repeating
 * condition, occurrences count its bursts, the cooldown and daily budget govern how often a person is asked, and an
 * evidence bundle is written beside the workspace. No test makes a model call: detection is pure.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import type { DomainEvent } from '../src/core/index.ts'
import { incidentFingerprint, isOpenIncident, normalizeIncidentDetail, canTransition, transitionIncident,
  type IncidentCandidate } from '../src/core/incidents.ts'
import { Incidents } from '../src/app/incidents.ts'
import { IncidentDetector } from '../src/app/incident-detectors.ts'
import { Logs } from '../src/app/logs.ts'
import { Store } from '../src/app/store.ts'

const at = (iso: string): Date => new Date(iso)
const event = <K extends DomainEvent['type']>(type: K, data: Extract<DomainEvent, { type: K }>['data'], time: string): DomainEvent =>
  ({ type, at: time, data } as DomainEvent)
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

let directory: string
let workspace: string
let stores: Store[] = []
let extras: string[] = []
afterEach(() => {
  // Windows refuses to remove an open SQLite file, so every Store a test opened closes first.
  for (const store of stores) { try { store.close() } catch { /* an already-closed Store is fine */ } }
  stores = []
  for (const path of extras) rmSync(path, { recursive: true, force: true })
  extras = []
  if (directory) rmSync(directory, { recursive: true, force: true })
})

/** One service over a real Store, a temp workspace, a real ring and an exact clock. */
function harness(overrides: { enabled?: boolean; minimumSeverity?: 'low' | 'medium' | 'high' | 'critical'; dailyBudget?: number }
  = {}, limits: { cooldownMs?: number; openCap?: number; keepBundles?: number; workspace?: string } = {}) {
  directory = mkdtempSync(join(tmpdir(), 'incidents-'))
  workspace = limits.workspace ?? join(directory, 'workspace')
  // A test passing a workspace under a regular file leaves it uncreated, so the evidence write fails as intended.
  try { mkdirSync(workspace, { recursive: true }) } catch { /* the failed-bundle test wants this path uncreatable */ }
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  stores.push(store)
  const clock = { at: at('2026-11-11T10:00:00.000Z') }
  const logs = new Logs(() => clock.at)
  const base = SettingsSchema.parse({})
  const settings = { ...base, executor: { ...base.executor, incidents: { ...base.executor.incidents, ...overrides } } }
  const health: { state: string; detail: string }[] = []
  const recorded: string[] = []
  let next = 0
  const incidents = new Incidents({
    store: { incidents: store.incidents, settings: () => settings },
    workspace: () => workspace,
    stateDir: directory,
    logs,
    health: { set: value => { health.push(value) } },
    record: message => { recorded.push(message) },
    now: () => clock.at,
    version: '0.4.0-test',
    createId: () => `i${++next}`,
    ...(limits.cooldownMs === undefined ? {} : { cooldownMs: limits.cooldownMs }),
    ...(limits.openCap === undefined ? {} : { openCap: limits.openCap }),
    ...(limits.keepBundles === undefined ? {} : { keepBundles: limits.keepBundles }),
  })
  return { store, incidents, logs, clock, health, recorded, settings, directory, workspace }
}

const candidate = (rule: 'outbox-failures' | 'agent-error-rate' | 'health-error' | 'stalled-assignment' | 'assignment-burst'
  | 'source-poll-failures', overrides: Partial<{ title: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical'
  scope: { project?: string; ticket?: string } }> = {}) => ({
  rule, severity: overrides.severity ?? 'high' as const,
  title: overrides.title ?? `Incident for ${rule}`,
  detail: overrides.detail ?? `detail for ${rule}`,
  ...(overrides.scope === undefined ? {} : { scope: overrides.scope }),
})

describe('incident model', () => {
  it('fingerprints stably over rule, scope ids and a digit-normalized detail', () => {
    const one = incidentFingerprint({ rule: 'outbox-failures', detail: '3 reply delivery failures in 30 minutes' })
    const two = incidentFingerprint({ rule: 'outbox-failures', detail: '7 reply delivery failures in 30 minutes' })
    expect(one).toBe(two)
    expect(normalizeIncidentDetail('3 reply delivery failures in 30 minutes')).toBe('# reply delivery failures in # minutes')
    expect(incidentFingerprint({ rule: 'agent-error-rate', detail: '3 errors' })).not.toBe(incidentFingerprint({ rule: 'outbox-failures', detail: '3 errors' }))
    expect(incidentFingerprint({ rule: 'stalled-assignment', scope: { ticket: 't1' }, detail: 'idle 10 minutes' }))
      .not.toBe(incidentFingerprint({ rule: 'stalled-assignment', scope: { ticket: 't2' }, detail: 'idle 10 minutes' }))
  })

  it('validates status transitions and rejects unknown ones', () => {
    expect(canTransition('detected', 'bundled')).toBe(true)
    expect(canTransition('bundled', 'diagnosed')).toBe(true)
    expect(canTransition('diagnosed', 'resolved')).toBe(true)
    expect(canTransition('resolved', 'detected')).toBe(true)
    expect(canTransition('dismissed', 'detected')).toBe(true)
    expect(canTransition('resolved', 'bundled')).toBe(false)
    const incident = { id: 'i1', fingerprint: 'f', rule: 'outbox-failures' as const, scope: {}, severity: 'high' as const, status: 'detected' as const,
      first_at: '2026-11-11T10:00:00.000Z', last_at: '2026-11-11T10:00:00.000Z', occurrences: 1, title: 't', detail: 'd',
      evidence_dir: '', updated_at: '2026-11-11T10:00:00.000Z' }
    expect(transitionIncident(incident, 'bundled', '2026-11-11T10:01:00.000Z').status).toBe('bundled')
    expect(() => transitionIncident(incident, 'resolved', '2026-11-11T10:01:00.000Z')).not.toThrow()
    expect(isOpenIncident('detected') && isOpenIncident('bundled') && isOpenIncident('diagnosed')).toBe(true)
    expect(isOpenIncident('resolved') || isOpenIncident('dismissed')).toBe(false)
  })
})

describe('Incidents service', () => {
  it('records one bundled incident with an evidence bundle and content-addressed manifest', () => {
    const h = harness()
    const incident = h.incidents.record(candidate('outbox-failures', { detail: '3 reply delivery failures in 30 minutes' }))!
    expect(incident.status).toBe('bundled')
    expect(incident.occurrences).toBe(1)
    expect(h.store.incidents.list()).toHaveLength(1)
    const evidence = h.incidents.evidence(incident.id)!
    expect(evidence.manifest).not.toBeNull()
    const manifest = evidence.manifest!
    expect(manifest.content_sha256).toMatch(/^[0-9a-f]{64}$/)
    for (const file of manifest.files) {
      const bytes = readFileSync(join(evidence.dir, file.name))
      expect(sha256(join(evidence.dir, file.name))).toBe(file.sha256)
      expect(file.bytes).toBe(bytes.length)
    }
    expect(manifest.files.map(file => file.name)).toEqual(expect.arrayContaining(['config.json', 'health.json', 'log-window.jsonl', 'related.json']))
  })

  it('counts a repeat detection as occurrences without a second record or bundle', () => {
    const h = harness()
    const first = h.incidents.record(candidate('outbox-failures', { detail: '3 reply delivery failures in 30 minutes' }))!
    h.clock.at = at('2026-11-11T10:20:00.000Z')
    const second = h.incidents.record(candidate('outbox-failures', { detail: '6 reply delivery failures in 30 minutes' }))!
    expect(second.id).toBe(first.id)
    expect(second.occurrences).toBe(2)
    expect(second.last_at).toBe('2026-11-11T10:20:00.000Z')
    expect(second.first_at).toBe(first.first_at)
    expect(second.evidence_dir).toBe(first.evidence_dir)
    expect(h.store.incidents.list()).toHaveLength(1)
  })

  it('skips candidates below the minimum severity, disabled detection, and the daily budget', () => {
    const low = harness({ minimumSeverity: 'high' })
    expect(low.incidents.record(candidate('agent-error-rate', { severity: 'medium' }))).toBeUndefined()
    expect(low.store.incidents.list()).toHaveLength(0)

    const off = harness({ enabled: false })
    expect(off.incidents.record(candidate('outbox-failures'))).toBeUndefined()
    expect(off.store.incidents.list()).toHaveLength(0)

    const budget = harness({ dailyBudget: 1 })
    expect(budget.incidents.record(candidate('outbox-failures'))).not.toBeUndefined()
    expect(budget.incidents.record(candidate('agent-error-rate'))).toBeUndefined()
    expect(budget.store.incidents.list()).toHaveLength(1)
  })

  it('skips a new incident when the open-incident cap is reached but still counts a repeat', () => {
    const h = harness({}, { openCap: 1 })
    const first = h.incidents.record(candidate('outbox-failures'))!
    expect(h.incidents.record(candidate('agent-error-rate'))).toBeUndefined()
    expect(h.incidents.record(candidate('outbox-failures'))!.occurrences).toBe(2)
    expect(h.store.incidents.list()).toHaveLength(1)
    expect(first.id).toBe(h.store.incidents.list()[0]!.id)
  })

  it('keeps a resolved incident quiet inside the cooldown and reopens it after', () => {
    const h = harness()
    const first = h.incidents.record(candidate('outbox-failures'))!
    h.incidents.recover(first.fingerprint)
    expect(h.store.incidents.get(first.id)!.status).toBe('resolved')
    h.clock.at = at('2026-11-11T10:30:00.000Z')
    expect(h.incidents.record(candidate('outbox-failures'))).toBeUndefined()
    h.clock.at = at('2026-11-11T12:00:00.000Z')
    const reopened = h.incidents.record(candidate('outbox-failures'))!
    expect(reopened.id).toBe(first.id)
    expect(reopened.status).toBe('bundled')
    expect(reopened.occurrences).toBe(2)
    expect(reopened.resolution).toBeUndefined()
  })

  it('degrades a failed evidence bundle to health and a log line, never a throw', () => {
    const base = mkdtempSync(join(tmpdir(), 'incidents-blocked-'))
    extras.push(base)
    const blocked = join(base, 'file')
    writeFileSync(blocked, 'not a directory')
    const h = harness({}, { workspace: join(blocked, 'nested') })
    const incident = h.incidents.record(candidate('outbox-failures'))!
    expect(incident.status).toBe('detected')
    expect(incident.evidence_dir).toBe('')
    expect(h.health.some(entry => entry.state === 'error')).toBe(true)
    expect(h.recorded.some(message => message.includes('evidence'))).toBe(true)
    expect(h.store.incidents.get(incident.id)).not.toBeUndefined()
  })

  it('writes the log window from the durable JSONL files and the ring', () => {
    const h = harness()
    h.logs.record('warn', 'outbox', 'reply delivery failed reply=r1: network down')
    mkdirSync(join(h.directory, 'logs'), { recursive: true })
    const line = JSON.stringify({ at: '2026-11-11T09:59:00.000Z', level: 'warn', scope: 'outbox', message: 'reply delivery failed reply=r0: earlier down' })
    writeFileSync(join(h.directory, 'logs', '2026-11-11.jsonl'), `${line}\n`)
    const incident = h.incidents.record(candidate('outbox-failures'))!
    const evidence = h.incidents.evidence(incident.id)!
    const window = readFileSync(join(evidence.dir, 'log-window.jsonl'), 'utf8')
    expect(window).toContain('reply delivery failed reply=r0: earlier down')
    expect(window).toContain('reply delivery failed reply=r1: network down')
  })

  it('lists incidents with status, severity, scope and paging filters', () => {
    const h = harness({ dailyBudget: 10 })
    const one = h.incidents.record(candidate('outbox-failures', { scope: { project: 'p1' } }))!
    h.incidents.record(candidate('agent-error-rate', { severity: 'critical' }))!
    expect(h.incidents.list({ status: 'open' })).toHaveLength(2)
    expect(h.incidents.list({ status: 'resolved' })).toHaveLength(0)
    expect(h.incidents.list({ severity: 'critical' })).toHaveLength(1)
    expect(h.incidents.list({ scope: { project: 'p1' } }).map(item => item.id)).toEqual([one.id])
    expect(h.incidents.list({ limit: 1 })).toHaveLength(1)
    expect(h.incidents.list({ offset: 1 })).toHaveLength(1)
  })
})

describe('IncidentDetector', () => {
  const tickets = (id: string) => id.startsWith('t1') ? { project: 'p1' } : id.startsWith('t2') ? { project: 'p2' } : undefined

  it('detects four failed assignment ends in ten minutes per project, once per burst', () => {
    const detector = new IncidentDetector({ tickets })
    const signals = [0, 1, 2, 3].flatMap(minute => detector.observeEvent(event('assignment.ended',
      { ticketId: 't1-a', assignmentId: `a${minute}`, reason: 'failed' }, `2026-11-11T10:0${minute}:00.000Z`)))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: 'detect', candidate: { rule: 'assignment-burst', severity: 'high', scope: { project: 'p1' } } })
    // A second burst is a second detection for the same fingerprint, which the service counts as occurrences.
    const more = [4, 5, 6, 7].flatMap(minute => detector.observeEvent(event('assignment.ended',
      { ticketId: 't1-a', assignmentId: `a${minute}`, reason: 'stopped' }, `2026-11-11T10:0${minute}:00.000Z`)))
    expect(more).toHaveLength(1)
    expect(more[0]).toMatchObject({ type: 'detect', candidate: { rule: 'assignment-burst' } })
  })

  it('detects three agent errors and three outbox delivery failures inside their windows', () => {
    const detector = new IncidentDetector({ tickets })
    const errors = [0, 1, 2].flatMap(minute => detector.observeLog({ at: `2026-11-11T10:0${minute}:00.000Z`, level: 'warn',
      scope: 'executor', message: 'agent.error ticket=t1-a name=worker code=1 turn=2 step=3' }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ type: 'detect', candidate: { rule: 'agent-error-rate', severity: 'high' } })
    const failures = [0, 5, 10].flatMap(minute => detector.observeLog({ at: `2026-11-11T10:${String(minute).padStart(2, '0')}:00.000Z`,
      level: 'warn', scope: 'outbox', message: `reply delivery failed reply=r${minute}: timeout` }))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ type: 'detect', candidate: { rule: 'outbox-failures', severity: 'high' } })
  })

  it('detects consecutive source poll failures and recovers on the poll.recovered window', () => {
    const detector = new IncidentDetector({ tickets })
    const signals = [0, 1, 2].flatMap(minute => detector.observeLog({ at: `2026-11-11T10:0${minute}:00.000Z`, level: 'debug',
      scope: 'feishu', message: 'poll.failed thread=t1 source=feishu error=etimedout' }))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ type: 'detect', candidate: { rule: 'source-poll-failures', severity: 'high' } })
    const recovered = detector.observeLog({ at: '2026-11-11T10:05:00.000Z', level: 'debug', scope: 'feishu',
      message: 'poll.recovered thread=t1 source=feishu after=3' })
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ type: 'recover' })
    expect((recovered[0] as { fingerprint: string }).fingerprint)
      .toBe(incidentFingerprint((signals[0] as { candidate: IncidentCandidate }).candidate))
  })

  it('detects a health claim entering error and recovers through the same fingerprint', () => {
    const detector = new IncidentDetector({ tickets })
    const failure = detector.observeHealth('worker', undefined, { state: 'error', detail: 'worker stopped' })
    expect(failure).toHaveLength(1)
    expect(failure[0]).toMatchObject({ type: 'detect', candidate: { rule: 'health-error', severity: 'high' } })
    const recovered = detector.observeHealth('worker', { state: 'error', detail: '' }, { state: 'ready', detail: '' })
    expect(recovered[0]).toMatchObject({ type: 'recover' })
    // Same-state detail churn is not a new detection.
    expect(detector.observeHealth('worker', { state: 'error', detail: '' }, { state: 'error', detail: 'still down' })).toHaveLength(0)
  })

  it('dedupes repeated stalled scans of one Assignment by fingerprint', () => {
    const detector = new IncidentDetector({ tickets })
    const first = detector.stalled({ ticketId: 't1-a', project: 'p1', assignmentId: 'a1' })
    const again = detector.stalled({ ticketId: 't1-a', project: 'p1', assignmentId: 'a1' })
    expect(first).toHaveLength(1)
    expect(again).toHaveLength(1)
    expect(incidentFingerprint((first[0] as { candidate: IncidentCandidate }).candidate))
      .toBe(incidentFingerprint((again[0] as { candidate: IncidentCandidate }).candidate))
  })

  it('leaves the update-failure rule reserved for the update pipeline and never detects it here', () => {
    const detector = new IncidentDetector({ tickets })
    expect(detector.observeLog({ at: '2026-11-11T10:00:00.000Z', level: 'error', scope: 'update',
      message: 'update.failed version=0.4.0 reason=checksum' })).toHaveLength(0)
  })
})
