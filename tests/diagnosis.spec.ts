/**
 * Read-only incident diagnosis (ADR-0005): one bounded dispatch of the diagnostician preset through DSH's subagent
 * service, a durable two-a-day budget keyed by UTC day, one run at a time, strict-JSON parsing with a raw-text
 * fallback, and routing through the existing self-evolution outlets. No test runs a model: a fake subagent service
 * answers with a diagnosis document, never answers, or refuses to start.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SettingsSchema, type Settings } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { Logs } from '../src/app/logs.ts'
import { Incidents } from '../src/app/incidents.ts'
import { Diagnosis, DIAGNOSIS_TIMEOUT_MS, withoutDiagnosisSignals, type DiagnosisHost } from '../src/app/diagnosis.ts'
import { DIAGNOSTICIAN_PRESET } from '../src/app/sessions.ts'
import { SELF_REPOSITORY } from '../src/core/self-reports.ts'
import { UserError } from '../src/core/errors.ts'
import type { IncidentCandidate, IncidentSeverity } from '../src/core/incidents.ts'
import type { Activation, ActivationSpec, SubagentService } from '../src/executor/lead-dispatch.ts'
import type { Health } from '../src/sources/host.ts'

const stores: Store[] = []
const directories: string[] = []
afterEach(() => {
  for (const store of stores) { try { store.close() } catch { /* an already-closed Store is fine */ } }
  stores.length = 0
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

type Project = Settings['executor']['projects'][number]
interface Start { spec: ActivationSpec; resolve: (value: unknown) => void; dispose: Mock }

/**
 * One Diagnosis over a real Store, a temp workspace and an exact clock, with a fake subagent service, Engine and
 * Issue outlet. `restart()` builds a second service over the same database, as a new host process would.
 */
function harness(options: {
  incidents?: Partial<{ enabled: boolean; autoDiagnose: boolean; minimumSeverity: IncidentSeverity; dailyBudget: number; diagnoseDailyBudget: number }>
  projects?: Project[]
  timeoutMs?: number
  /** How long `startActivation` itself takes, to exercise the start-phase deadline. */
  startDelayMs?: number
  startFails?: boolean
  subagents?: boolean
  /** Hold every `SelfReports.raise` until `releaseRaise()`, so a test can overlap a route with an operator action. */
  slowRaise?: boolean
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'diagnosis-'))
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  stores.push(store); directories.push(directory)
  const clock = { at: new Date('2026-11-11T10:00:00.000Z') }
  const logs = new Logs(() => clock.at)
  const base = SettingsSchema.parse({})
  const save = (patch: Partial<{ incidents: Partial<Settings['executor']['incidents']>; projects: Project[] }> = {}) => {
    const current = store.settings()
    store.saveSettings({ ...current, workspace: { path: workspace }, executor: { ...current.executor,
      incidents: { ...current.executor.incidents, ...options.incidents, ...patch.incidents },
      projects: patch.projects ?? options.projects ?? current.executor.projects } })
  }
  save()
  let nextIncident = 0
  const incidents = new Incidents({ store: { incidents: store.incidents, settings: () => store.settings() },
    workspace: () => workspace, stateDir: directory, logs, now: () => clock.at, version: '0.4.0-test',
    createId: () => `inc-${++nextIncident}` })

  const starts: Start[] = []
  const failed = { start: options.startFails === true }
  const service: SubagentService = {
    startActivation: vi.fn(async (spec: ActivationSpec): Promise<Activation> => {
      if (failed.start) throw new Error('the host refused the child')
      const result = Promise.withResolvers<unknown>()
      const dispose = vi.fn(async () => { result.resolve(undefined) })
      starts.push({ spec, resolve: result.resolve, dispose })
      // A slow start keeps the dispatch promise pending past the deadline, so the service must abort it and dispose the
      // late activation itself.
      if (options.startDelayMs !== undefined) await new Promise(resolve => { setTimeout(resolve, options.startDelayMs) })
      return { childId: spec.childId, result: result.promise, dispose }
    }),
    sendMessage: vi.fn(async () => undefined),
  }
  const requests: { title: string; instruction: string; units: { project?: string; title?: string }[] }[] = []
  let nextRequest = 0
  const engine = { raiseDiscoveryRequest: vi.fn((input: { title: string; instruction: string; units: { project?: string }[] }) => {
    requests.push(input)
    return { id: `req-${++nextRequest}` }
  }) } as unknown as DiagnosisHost['engine']
  const raises: { title: string; evidence: string; reproduction: string; session: string }[] = []
  let nextReport = 0
  let raisesFail = 0
  const raiseWaiters: (() => void)[] = []
  const selfReports = { raise: vi.fn(async (input: { title: string; evidence: string; reproduction: string; session: string }) => {
    raises.push(input)
    if (options.slowRaise === true) await new Promise<void>(resolve => { raiseWaiters.push(resolve) })
    if (raisesFail > 0) { raisesFail--; throw new UserError('selfReportJurisdiction', { repository: SELF_REPOSITORY }) }
    return { status: 'draft', report: { id: `sr-${++nextReport}` }, reason: 'observe' } as never
  }) } as unknown as DiagnosisHost['selfReports']
  const releaseRaise = (): void => { for (const resolve of raiseWaiters.splice(0)) resolve() }
  const readOnly = vi.fn((_agent: Agent) => {})
  const parent = { id: 'master-1' } as unknown as Agent
  const health: { value: Health | undefined } = { value: { state: 'ready', detail: 'Incident detection is ready', at: '' } }
  const lifetime = new AbortController()
  const host: DiagnosisHost = {
    store,
    engine,
    selfReports,
    workspace: () => workspace,
    masterId: 'master-1',
    parent: () => parent,
    subagents: () => options.subagents === false ? undefined : service,
    child: id => ({ id } as unknown as Agent),
    readOnly,
    lifetime: lifetime.signal,
    logs,
    health: { get: () => health.value, set: value => { health.value = value } },
    now: () => clock.at,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }
  const diagnosis = new Diagnosis(host)
  const restart = () => new Diagnosis(host)
  return { store, incidents, diagnosis, restart, logs, clock, workspace, directory, service, starts, requests, raises, readOnly, health,
    parent, save, releaseRaise, failure: (times = 1) => { raisesFail = times } }
}

const candidate = (overrides: Partial<IncidentCandidate> = {}): IncidentCandidate => ({ rule: 'outbox-failures', severity: 'high',
  title: 'Reply deliveries are failing', detail: '3 reply delivery failures in 30 minutes', ...overrides })

/** The strict diagnosis document a competent diagnostician returns. */
const document = (overrides: Record<string, unknown> = {}) => ({
  rootCause: 'Reply delivery times out because the outbox retries without a bound.',
  evidence: ['3 reply delivery failures in 30 minutes', 'artifacts/incidents/inc-1/log-window.jsonl'],
  hypotheses: ['The Feishu client hangs on a stale socket'],
  fixPlan: 'Bound each outbox send, report a failed one to health, and retry once with backoff.',
  confidence: 'high',
  target: { kind: 'operational' },
  ...overrides,
})

/** Answer the n-th started activation with a diagnosis document (or raw text), ending it as DSH would. */
const answer = (h: ReturnType<typeof harness>, index: number, value: unknown): void => {
  h.starts[index]!.resolve({ output: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], stopReason: 'endTurn' })
}
/** Let fire-and-forget paths run a few turns so a negative assertion is meaningful. */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 20) })

describe('diagnosis dispatch', () => {
  it('starts the read-only diagnostician preset once, with the incident, its evidence and the workspace in the prompt', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    const { spec } = h.starts[0]!
    const text = spec.request.prompt[0]!.text
    expect(DIAGNOSIS_TIMEOUT_MS).toBe(600_000)
    expect(spec.provider).toBe('spawn')
    expect(spec.delivery).toBe('caller')
    expect(spec.label).toContain(incident.id)
    expect(spec.childId).toMatch(new RegExp(`^diag-${incident.id}-[0-9a-f]{8}$`))
    expect(spec.request.agentPreset).toBe(DIAGNOSTICIAN_PRESET)
    expect(spec.request.maxDepth).toBe(1)
    expect(spec.request.cwd).toBe(h.workspace)
    expect(spec.request.parent.id).toBe('master-1')
    expect(spec.signal).toBeInstanceOf(AbortSignal)
    for (const fragment of [incident.id, incident.title, incident.rule, incident.severity, join(h.workspace, 'artifacts', 'incidents'),
      h.workspace, 'STRICT JSON', 'rootCause', 'evidence', 'hypotheses', 'fixPlan', 'confidence', 'target', 'Do not write'])
      expect(text).toContain(fragment)
    // Mechanism-enforced read-only: the child Session is put under the read-only permission preset as defense in depth.
    answer(h, 0, document())
    const result = await pending
    expect(h.readOnly).toHaveBeenCalledWith(expect.objectContaining({ id: spec.childId }))
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(result.incident.status).toBe('diagnosed')
    expect(result.incident.diagnosis).toBeTypeOf('string')
    expect(JSON.parse(result.incident.diagnosis!)).toMatchObject({ rootCause: document().rootCause, confidence: 'high', parsed: true })
    expect(h.health.value?.state).toBe('ready')
    expect(h.logs.list({ scope: 'diagnosis' }).some(entry => entry.message.includes(incident.id))).toBe(true)
  })

  it('keeps an unparseable answer as the record\'s low-confidence diagnosis instead of failing the run', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, 'I could not read the workspace; the evidence window suggests a stuck Feishu client.')
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    const stored = JSON.parse(result.incident.diagnosis!) as Record<string, unknown>
    expect(stored.parsed).toBe(false)
    expect(stored.confidence).toBe('low')
    expect(stored.rootCause).toContain('stuck Feishu client')
    expect(stored.target).toEqual({ kind: 'none' })
    expect(result.incident.resolution).toBe('operational')
    expect(h.requests).toHaveLength(0)
    expect(h.raises).toHaveLength(0)
  })

  it('bounds the wait, disposes the activation, reports health and leaves the record bundled', async () => {
    const h = harness({ timeoutMs: 25 })
    const incident = h.incidents.record(candidate())!
    const result = await h.diagnosis.diagnose(incident.id)
    expect(result).toEqual({ status: 'refused', reason: 'timeout' })
    expect(h.starts).toHaveLength(1)
    expect(h.starts[0]!.dispose).toHaveBeenCalled()
    expect(h.store.incidents.get(incident.id)!.status).toBe('bundled')
    expect(h.store.incidents.get(incident.id)!.diagnosis).toBeUndefined()
    expect(h.health.value?.state).toBe('error')
    expect(h.health.value?.detail).toMatch(/timed out/i)
    expect(h.logs.list({ scope: 'diagnosis' }).some(entry => entry.level === 'warn' && entry.message.includes(incident.id))).toBe(true)
  })

  it('reports a refused start and an empty answer as failures, leaving the record bundled', async () => {
    const refused = harness({ startFails: true })
    const first = refused.incidents.record(candidate())!
    expect(await refused.diagnosis.diagnose(first.id)).toEqual({ status: 'refused', reason: 'failed' })
    expect(refused.health.value?.state).toBe('error')
    expect(refused.store.incidents.get(first.id)!.status).toBe('bundled')

    const empty = harness()
    const second = empty.incidents.record(candidate())!
    const pending = empty.diagnosis.diagnose(second.id)
    await vi.waitFor(() => expect(empty.starts).toHaveLength(1))
    empty.starts[0]!.resolve({ output: [], stopReason: 'endTurn' })
    expect(await pending).toEqual({ status: 'refused', reason: 'failed' })
    expect(empty.store.incidents.get(second.id)!.status).toBe('bundled')
    expect(empty.health.value?.state).toBe('error')
  })

  it('aborts a start that outlives the deadline and disposes the activation it still returns, exactly once', async () => {
    const h = harness({ timeoutMs: 25, startDelayMs: 80 })
    const incident = h.incidents.record(candidate())!
    const result = await h.diagnosis.diagnose(incident.id)
    expect(result).toEqual({ status: 'refused', reason: 'timeout' })
    expect(h.starts).toHaveLength(1)
    // The start-phase deadline aborts the dispatch instead of leaving the child to appear behind a returned timeout.
    expect(h.starts[0]!.spec.signal.aborted).toBe(true)
    await vi.waitFor(() => expect(h.starts[0]!.dispose).toHaveBeenCalledTimes(1))
    expect(h.store.incidents.get(incident.id)!.status).toBe('bundled')
    expect(h.health.value?.state).toBe('error')
  })

  it('refuses a completion that finished after an operator dismissed the record and never resurrects it', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    h.incidents.dismiss(incident.id, 'duplicate of a known outage')
    answer(h, 0, document({ target: { kind: 'project', project: 'Default' } }))
    expect(await pending).toEqual({ status: 'refused', reason: 'stale' })
    const stored = h.store.incidents.get(incident.id)!
    expect(stored.status).toBe('dismissed')
    expect(stored.resolution).toBe('Dismissed: duplicate of a known outage')
    expect(stored.diagnosis).toBeUndefined()
    expect(h.requests).toHaveLength(0)
    expect(h.raises).toHaveLength(0)
    // A stale completion is routine, not an incidents health failure.
    expect(h.health.value?.state).toBe('ready')
    expect(h.logs.list({ scope: 'diagnosis' }).some(entry => entry.level === 'warn' && entry.message.includes('diagnosis.stale'))).toBe(true)
  })

  it('refuses a completion that finished after a repeat updated the record and keeps the newer counts', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    h.clock.at = new Date('2026-11-11T10:20:00.000Z')
    const repeated = h.incidents.record(candidate({ severity: 'critical' }))!
    expect(repeated.occurrences).toBe(2)
    answer(h, 0, document())
    expect(await pending).toEqual({ status: 'refused', reason: 'stale' })
    const stored = h.store.incidents.get(incident.id)!
    expect(stored.status).toBe('bundled')
    expect(stored.occurrences).toBe(2)
    expect(stored.severity).toBe('critical')
    expect(stored.diagnosis).toBeUndefined()
  })

  it('drops detector signals scoped to a diagnosis child Session, so no diagnosis run can feed detection', () => {
    const scoped = { type: 'detect' as const, candidate: candidate({ scope: { session: 'diag-inc-1-deadbeef' } }) }
    const normal = { type: 'detect' as const, candidate: candidate({ scope: { session: 'sess-1' } }) }
    const recover = { type: 'recover' as const, fingerprint: 'fp-1' }
    expect(withoutDiagnosisSignals([scoped, normal, recover])).toEqual([normal, recover])
  })

  it('refuses an unknown record, a closed record, a missing subagent service and a disabled feature', async () => {
    const h = harness()
    expect(await h.diagnosis.diagnose('nope')).toEqual({ status: 'refused', reason: 'unknown' })
    const incident = h.incidents.record(candidate())!
    h.incidents.dismiss(incident.id, 'duplicate of a known outage')
    expect(await h.diagnosis.diagnose(incident.id)).toEqual({ status: 'refused', reason: 'status' })
    const missing = harness({ subagents: false })
    const another = missing.incidents.record(candidate())!
    expect(await missing.diagnosis.diagnose(another.id)).toEqual({ status: 'refused', reason: 'failed' })
    const disabled = harness({ incidents: { enabled: false } })
    expect(disabled.incidents.record(candidate())).toBeUndefined()
  })
})

describe('automatic diagnosis gates', () => {
  it('diagnoses a high incident after detection without starting the child inside the detection pass', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const before = h.starts.length
    h.diagnosis.consider(incident)
    // Dispatch is scheduled off the detection pass: the record is returned before the child starts.
    expect(h.starts).toHaveLength(before)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document())
    await vi.waitFor(() => expect(h.store.incidents.get(incident.id)!.status).toBe('diagnosed'))
  })

  it('auto-diagnoses only high or critical incidents at or above the configured floor, and only when autoDiagnose is on', async () => {
    const medium = harness({ incidents: { minimumSeverity: 'low' } })
    const mediumIncident = medium.incidents.record(candidate({ severity: 'medium' }))!
    medium.diagnosis.consider(mediumIncident)
    await flush()
    expect(medium.starts).toHaveLength(0)

    const floor = harness({ incidents: { minimumSeverity: 'high' } })
    const high = floor.incidents.record(candidate({ severity: 'high' }))!
    // The record gate drops anything under the floor, so raise the floor after the record exists to test the diagnosis gate.
    floor.save({ incidents: { minimumSeverity: 'critical' } })
    floor.diagnosis.consider(high)
    await flush()
    expect(floor.starts).toHaveLength(0)

    const off = harness({ incidents: { autoDiagnose: false } })
    const ignored = off.incidents.record(candidate())!
    off.diagnosis.consider(ignored)
    await flush()
    expect(off.starts).toHaveLength(0)
    expect(off.store.incidents.get(ignored.id)!.status).toBe('bundled')

    const low = harness({ incidents: { minimumSeverity: 'low' } })
    const critical = low.incidents.record(candidate({ severity: 'critical' }))!
    low.diagnosis.consider(critical)
    await vi.waitFor(() => expect(low.starts).toHaveLength(1))
    answer(low, 0, document())
  })

  it('lets an operator diagnose below the automatic threshold', async () => {
    const h = harness({ incidents: { minimumSeverity: 'low' } })
    const incident = h.incidents.record(candidate({ severity: 'medium' }))!
    h.save({ incidents: { minimumSeverity: 'high' } })
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document())
    expect((await pending).status).toBe('diagnosed')
  })
})

describe('diagnosis budget and concurrency', () => {
  it('spends a durable two-a-day budget that survives a restart and resets on the next UTC day', async () => {
    // Three records are needed, so raise the detection budget; the diagnosis budget stays at the default two.
    const h = harness({ incidents: { dailyBudget: 10 } })
    const first = h.incidents.record(candidate())!
    const second = h.incidents.record(candidate({ detail: 'reply delivery retries are exhausted' }))!
    for (const incident of [first, second]) {
      const pending = h.diagnosis.diagnose(incident.id)
      await vi.waitFor(() => expect(h.starts).toHaveLength(1), { timeout: 1000 })
      answer(h, 0, document())
      expect((await pending).status).toBe('diagnosed')
      h.starts.length = 0
    }
    const third = h.incidents.record(candidate({ detail: 'the delivery worker stopped responding' }))!
    // The same UTC day still has no budget left, in a fresh service over the same database.
    expect(await h.restart().diagnose(third.id)).toEqual({ status: 'refused', reason: 'budget' })
    expect(h.starts).toHaveLength(0)
    // The next UTC day resets it.
    h.clock.at = new Date('2026-11-12T00:30:00.000Z')
    const next = h.restart().diagnose(third.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document())
    expect((await next).status).toBe('diagnosed')
  })

  it('runs one diagnosis at a time without spending budget on the refused run', async () => {
    const h = harness()
    const first = h.incidents.record(candidate())!
    const second = h.incidents.record(candidate({ detail: 'reply delivery retries are exhausted' }))!
    const running = h.diagnosis.diagnose(first.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    expect(await h.diagnosis.diagnose(second.id)).toEqual({ status: 'refused', reason: 'concurrent' })
    answer(h, 0, document())
    expect((await running).status).toBe('diagnosed')
    const next = h.diagnosis.diagnose(second.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(2))
    answer(h, 1, document())
    expect((await next).status).toBe('diagnosed')
  })
})

describe('routing a diagnosis through the self-evolution outlets', () => {
  it('raises one discovery Request for a registered project and stores its id as the resolution', async () => {
    const project: Project = { id: 'default', name: 'Default', workspace: join(tmpdir(), 'default'), repository: 'acme/widgets', branch: '' }
    const h = harness({ projects: [project] })
    const incident = h.incidents.record(candidate({ scope: { project: 'default' } }))!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'project', project: 'Default' } }))
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.title.length).toBeLessThanOrEqual(120)
    expect(h.requests[0]!.instruction).toContain(document().rootCause)
    expect(h.requests[0]!.instruction).toContain(document().fixPlan)
    expect(h.requests[0]!.units).toEqual([{ project: 'default', title: expect.stringContaining(incident.id) }])
    expect(result.incident.resolution).toBe('request:req-1')
    expect(result.incident.status).toBe('diagnosed')
    // Never route the same incident twice.
    expect(await h.diagnosis.route(incident.id)).toEqual({ status: 'refused', reason: 'alreadyRouted' })
    expect(h.requests).toHaveLength(1)
    const stored = h.store.incidents.get(incident.id)!
    expect(stored.resolution).toBe('request:req-1')
  })

  it('raises a self-report draft for a self target without a registered self project', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'self' } }))
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(h.raises).toHaveLength(1)
    expect(h.raises[0]!.session).toBe('master-1')
    expect(h.raises[0]!.title).toContain(incident.id)
    expect(h.raises[0]!.evidence).toContain(document().rootCause)
    expect(h.raises[0]!.evidence).toContain(`artifacts/incidents/${incident.id}`)
    // The self-report outlet rejects absolute paths, so the bundle is named relative to the workspace.
    expect(h.raises[0]!.evidence).not.toContain(h.workspace)
    expect(h.raises[0]!.reproduction).toBeTypeOf('string')
    expect(h.requests).toHaveLength(0)
    expect(result.incident.resolution).toBe('self-report:sr-1')
  })

  it('falls back to a discovery Request under the self project when it is registered', async () => {
    const project: Project = { id: 'self', name: 'Self', workspace: join(tmpdir(), 'self'), repository: SELF_REPOSITORY, branch: '' }
    const h = harness({ projects: [project] })
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'self' } }))
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(h.raises).toHaveLength(0)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.units[0]!.project).toBe('self')
    expect(result.incident.resolution).toBe('request:req-1')
  })

  it('routes an unregistered project target to a self report instead', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'project', project: 'acme/not-registered' } }))
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(h.requests).toHaveLength(0)
    expect(h.raises).toHaveLength(1)
    expect(result.incident.resolution).toBe('self-report:sr-1')
  })

  it('routes an unregistered project target to the registered self project instead of a jurisdiction-refused self report', async () => {
    const project: Project = { id: 'self', name: 'Self', workspace: join(tmpdir(), 'self'), repository: SELF_REPOSITORY, branch: '' }
    const h = harness({ projects: [project] })
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'project', project: 'acme/not-registered' } }))
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    // A self-report would refuse jurisdiction here; the registered self project carries the discovery Request instead.
    expect(h.raises).toHaveLength(0)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.units[0]!.project).toBe('self')
    expect(result.incident.resolution).toBe('request:req-1')
  })

  it('keeps an operational diagnosis on the record and creates neither a Request nor an Issue', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'operational' } }))
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(h.requests).toHaveLength(0)
    expect(h.raises).toHaveLength(0)
    expect(result.incident.resolution).toBe('operational')
    expect(await h.diagnosis.route(incident.id)).toEqual({ status: 'refused', reason: 'alreadyRouted' })
    expect(h.store.incidents.get(incident.id)!.diagnosis).toBeTypeOf('string')
  })

  it('leaves the resolution empty after a failed automatic route so an operator can retry once', async () => {
    const h = harness()
    h.failure(1)
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'self' } }))
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(result.incident.resolution).toBeUndefined()
    expect(h.logs.list({ scope: 'diagnosis' }).some(entry => entry.level === 'warn' && entry.message.includes('route'))).toBe(true)
    const routed = await h.diagnosis.route(incident.id, { manual: true })
    expect(routed.status).toBe('routed')
    if (routed.status !== 'routed') throw new Error('unreachable')
    expect(routed.resolution).toBe('self-report:sr-1')
    expect(routed.incident.resolution).toBe('self-report:sr-1')
    expect(await h.diagnosis.route(incident.id, { manual: true })).toEqual({ status: 'refused', reason: 'alreadyRouted' })
  })

  it('refuses a route for a reopened record even though it kept its old diagnosis', async () => {
    const project: Project = { id: 'default', name: 'Default', workspace: join(tmpdir(), 'default'), repository: 'acme/widgets', branch: '' }
    const h = harness({ projects: [project] })
    const incident = h.incidents.record(candidate({ scope: { project: 'default' } }))!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'project', project: 'Default' } }))
    expect((await pending).status).toBe('diagnosed')
    expect(h.requests).toHaveLength(1)
    h.incidents.dismiss(incident.id, 'not actionable now')
    h.clock.at = new Date('2026-11-11T12:30:00.000Z')
    const reopened = h.incidents.record(candidate({ scope: { project: 'default' } }))!
    expect(reopened.status).toBe('bundled')
    expect(reopened.diagnosis).toBeTypeOf('string')
    expect(reopened.resolution).toBeUndefined()
    // The old diagnosis is kept for a person to read, but only a diagnosed record may create work.
    expect(await h.diagnosis.route(incident.id, { manual: true })).toEqual({ status: 'refused', reason: 'notDiagnosed' })
    expect(h.requests).toHaveLength(1)
  })

  it('refuses a manual route before a diagnosis and for a target that routes nowhere', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    expect(await h.diagnosis.route(incident.id, { manual: true })).toEqual({ status: 'refused', reason: 'notDiagnosed' })
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, 'raw text without a routable target')
    await pending
    expect(await h.diagnosis.route(incident.id, { manual: true })).toEqual({ status: 'refused', reason: 'notRoutable' })
    expect(await h.diagnosis.route('nope', { manual: true })).toEqual({ status: 'refused', reason: 'unknown' })
  })
})

describe('route concurrency and settlement', () => {
  it('refuses a second overlapping route as concurrent and creates at most one work item', async () => {
    const h = harness({ slowRaise: true })
    // The automatic route fails once, leaving a diagnosed record with no resolution to retry by hand.
    h.failure(1)
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'self' } }))
    await vi.waitFor(() => expect(h.raises).toHaveLength(1))
    h.releaseRaise()
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(result.incident.resolution).toBeUndefined()

    // The manual route blocks inside SelfReports.raise; a second call for the same record is refused and creates nothing.
    const first = h.diagnosis.route(incident.id, { manual: true })
    await vi.waitFor(() => expect(h.raises).toHaveLength(2))
    expect(await h.diagnosis.route(incident.id, { manual: true })).toEqual({ status: 'refused', reason: 'concurrent' })
    h.releaseRaise()
    expect(await first).toMatchObject({ status: 'routed', resolution: 'self-report:sr-1' })
    expect(h.raises).toHaveLength(2)
    expect(h.store.incidents.get(incident.id)!.resolution).toBe('self-report:sr-1')
  })

  it('lets a dismissal during a slow resolve win: the route is refused as conflict and the reason survives', async () => {
    const h = harness({ slowRaise: true })
    const incident = h.incidents.record(candidate())!
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'self' } }))
    await vi.waitFor(() => expect(h.raises).toHaveLength(1))
    h.incidents.dismiss(incident.id, 'duplicate of a known outage')
    h.releaseRaise()
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(result.incident.status).toBe('dismissed')
    expect(result.incident.resolution).toBe('Dismissed: duplicate of a known outage')
    const stored = h.store.incidents.get(incident.id)!
    expect(stored.status).toBe('dismissed')
    expect(stored.resolution).toBe('Dismissed: duplicate of a known outage')
    // The draft was already created before the compare-and-swap failed; it is logged, never recorded as the resolution.
    expect(h.raises).toHaveLength(1)
    const conflict = h.logs.list({ scope: 'diagnosis' }).find(entry => entry.message.includes('diagnosis.route-conflict'))
    expect(conflict?.level).toBe('warn')
    expect(conflict?.message).toContain('created=self-report:sr-1')
  })

  it('releases the route reservation after a refusal, a failure and a success', async () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    // A refusal on an undiagnosed record releases the reservation before the diagnosis starts.
    expect(await h.diagnosis.route(incident.id, { manual: true })).toEqual({ status: 'refused', reason: 'notDiagnosed' })
    h.failure(1)
    const pending = h.diagnosis.diagnose(incident.id)
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    answer(h, 0, document({ target: { kind: 'self' } }))
    const result = await pending
    expect(result.status).toBe('diagnosed')
    if (result.status !== 'diagnosed') throw new Error('unreachable')
    expect(result.incident.resolution).toBeUndefined()
    // The failed automatic route (a thrown resolve) released the reservation, so a manual retry succeeds.
    expect(await h.diagnosis.route(incident.id, { manual: true })).toMatchObject({ status: 'routed', resolution: 'self-report:sr-1' })
    // A success releases it too: the next call is the idempotence refusal, not stuck behind a stale reservation.
    expect(await h.diagnosis.route(incident.id, { manual: true })).toEqual({ status: 'refused', reason: 'alreadyRouted' })
  })
})

describe('dismissing an incident', () => {
  it('records the reason, transitions to dismissed and refuses a second dismissal', () => {
    const h = harness()
    const incident = h.incidents.record(candidate())!
    const dismissed = h.incidents.dismiss(incident.id, 'duplicate of a known outage')
    expect(dismissed.status).toBe('dismissed')
    expect(dismissed.resolution).toBe('Dismissed: duplicate of a known outage')
    try { h.incidents.dismiss(incident.id, 'again'); expect.unreachable() }
    catch (error) { expect((error as UserError).code).toBe('incidentTransition') }
    try { h.incidents.dismiss('nope', 'again'); expect.unreachable() }
    catch (error) { expect((error as UserError).code).toBe('incidentUnknown') }
  })
})
