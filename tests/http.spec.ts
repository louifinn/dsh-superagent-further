import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { AutomationLimitError, AutomationRunRefusedError, UnknownAutomationError, UnknownProjectError } from '../src/app/automations.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SelfReports } from '../src/app/self-reports.ts'
import { SettingsConflict, SettingsRevisionNotFound } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { Logs } from '../src/app/logs.ts'
import { MemoryConfigSchema, SettingsSchema } from '../src/policy.ts'
import { SELF_REPOSITORY, type SelfReport, type SelfReportRepository, type SelfReportStatus } from '../src/core/index.ts'
import { SetupError } from '../src/setup.ts'
import type { UpdateSnapshot } from '../src/supervisor/update-state.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), logs: new Logs(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('decides an escalated project request from the panel through one runtime path', async () => {
  const decisions: unknown[] = []
  const call = serve({
    store: { settings: () => ({ executor: { projects: [{ id: 'app', name: 'App', workspace: '/w/app', repository: 'acme/app', branch: '' }] } }) },
    decideEscalation: async (input: unknown) => { decisions.push(input); return { id: 'pr-1', project: 'app', status: 'rejected',
      replies: [{ by: 'orchestrator', at: '2026-11-10T00:00:00.000Z', text: 'No.' }], tickets: [], reply_delivered: true } },
  })
  const done = await call('POST', 'escalations/pr-1/decide', { decision: 'reject', reply: 'No.' })
  expect(done).toMatchObject({ status: 200, body: { id: 'pr-1', status: 'rejected', reply_delivered: true } })
  expect(decisions).toEqual([{ decision: 'reject', reply: 'No.', id: 'pr-1' }])
  // The boundary rules hold where the panel enters: accept needs units, every unit names a registered project, and a reply is required.
  expect(await call('POST', 'escalations/pr-1/decide', { decision: 'accept', reply: 'Yes.' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'escalations/pr-1/decide', { decision: 'accept', reply: 'Yes.', units: [{ project: 'other' }] })).toMatchObject({ status: 400 })
  expect(await call('POST', 'escalations/pr-1/decide', { decision: 'reject', reply: '' })).toMatchObject({ status: 400 })
})

it('lists each open Ticket worker with its Assignment state and shell jobs for the panel', async () => {
  const jobs = new Map([['t7', [{ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', preview: '2 failed', total: 9,
    startedAt: '2026-11-11T00:00:00.000Z' }]]])
  const call = serve({
    store: { tickets: { open: () => [{ id: 't7', title: 'Fix login', assignments: [{ id: 'a7', state: 'running' }] },
      { id: 't8', title: 'Already ended', assignments: [{ id: 'a8b', state: 'ended' }] }] } },
    executor: { activeCount: () => 1, jobsSnapshot: () => jobs },
  })
  expect(await call('GET', 'workers')).toEqual({ status: 200, body: { items: [
    { ticket: 't7', title: 'Fix login', session: 'worker-t7', assignment: 'running', assignmentId: 'a7',
      jobs: [{ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', preview: '2 failed', total: 9,
        startedAt: '2026-11-11T00:00:00.000Z' }] },
    { ticket: 't8', title: 'Already ended', session: 'worker-t8', assignment: 'ended', assignmentId: 'a8b', jobs: [] },
  ] } })
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  // The management API saves with the panel's permissions, never the tool origin the tier refusals apply to.
  expect(saves.map(args => (args as unknown[])[3])).toEqual(['panel', 'panel', 'panel', 'panel'])
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('restores a settings block from a retained revision, and reports an unknown revision or a no-op restore', async () => {
  const restores: unknown[] = []
  const call = serve({
    sources: { instances: () => [{ id: 'github' }] },
    settings: { restore: async (...args: unknown[]) => {
      restores.push(args)
      if (args[1] === 99) throw new SettingsRevisionNotFound('No settings revision 99 is retained')
      if (args[1] === 98) throw new SettingsConflict('Settings already match revision 98; nothing to restore')
      return { saved: true, revision: 5, policy_changed: false, restarting: false, context_delivery: 'injected', restoredFrom: args[1] }
    } },
  })
  expect(await call('POST', 'settings/eval/restore', { revision: 3 })).toEqual({ status: 200,
    body: { revision: 5, restarting: false, restoredFrom: 3 } })
  expect(restores).toEqual([['eval', 3, {}]])
  expect(await call('POST', 'settings/eval/restore', { revision: 3, reason: 'Put it back' })).toMatchObject({ status: 200 })
  expect(restores[1]).toEqual(['eval', 3, { reason: 'Put it back' }])
  expect(await call('POST', 'settings/eval/restore', { revision: 99 })).toEqual({ status: 404,
    body: { error: 'No settings revision 99 is retained' } })
  expect(await call('POST', 'settings/eval/restore', { revision: 98 })).toEqual({ status: 409,
    body: { error: 'Settings already match revision 98; nothing to restore' } })
  // The block name is validated before the restore, and the revision must be a non-negative integer.
  expect(await call('POST', 'settings/pause/restore', { revision: 1 })).toMatchObject({ status: 400 })
  expect(await call('POST', 'settings/source:feishu/restore', { revision: 1 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(await call('POST', 'settings/eval/restore', { revision: -1 })).toMatchObject({ status: 400 })
  expect(restores).toHaveLength(4)
})

it('lists pending settings proposals and applies or rejects one for the panel', async () => {
  const applied: string[] = []
  const rejected: string[] = []
  const pending = { id: 'pr-1234abcd', block: 'eval', base_revision: 0, value: {}, diff: [], reason: 'The person asked',
    actor: 'master', status: 'pending', created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-08T00:00:00.000Z' }
  const call = serve({
    settings: {
      proposals: () => ({ items: [pending] }),
      applyProposal: async (id: string) => {
        applied.push(id)
        if (id === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
        return id === pending.id ? { revision: 1, restarting: false,
          proposal: { ...pending, status: 'applied', decided_by: 'panel', applied_revision: 1 } } : undefined
      },
      rejectProposal: (id: string) => {
        rejected.push(id)
        return id === pending.id ? { ...pending, status: 'rejected', decided_by: 'panel' } : undefined
      },
    },
  })
  expect(await call('GET', 'settings/proposals')).toEqual({ status: 200, body: { items: [pending] } })
  expect(await call('POST', `settings/proposals/${pending.id}/apply`)).toMatchObject({ status: 200,
    body: { revision: 1, proposal: { status: 'applied', decided_by: 'panel' } } })
  expect(await call('POST', `settings/proposals/${pending.id}/reject`)).toMatchObject({ status: 200,
    body: { proposal: { status: 'rejected', decided_by: 'panel' } } })
  expect(await call('POST', 'settings/proposals/pr-none/apply')).toEqual({ status: 404, body: { error: 'Settings proposal not found' } })
  expect(await call('POST', 'settings/proposals/pr-none/reject')).toEqual({ status: 404, body: { error: 'Settings proposal not found' } })
  expect(await call('POST', 'settings/proposals/stale/apply')).toEqual({ status: 409, body: { error: 'Settings changed. Reload before saving.' } })
  expect(await call('POST', `settings/proposals/${pending.id}/apply`, undefined, { 'x-orchestrator-request': undefined }))
    .toEqual({ status: 403, body: { error: 'Same-origin management request required' } })
  expect(applied).toEqual([pending.id, 'pr-none', 'stale'])
  expect(rejected).toEqual([pending.id, 'pr-none'])
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('acknowledges a shutdown before stopping the runtime, since the process ends after the response', async () => {
  const stops: string[] = []
  const call = serve({ requestShutdown: () => { stops.push('shutdown') } })
  // A shutdown without the panel's same-origin header is refused like every other management request.
  expect(await call('POST', 'shutdown', undefined, { 'x-orchestrator-request': undefined }))
    .toEqual({ status: 403, body: { error: 'Same-origin management request required' } })
  expect(await call('POST', 'shutdown')).toEqual({ status: 200, body: { stopping: true } })
  // The acknowledgement is written in the route's own tick; stopping starts on the next one so it cannot cut the response off.
  expect(stops).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(stops).toEqual(['shutdown'])
})

it('searches, orders, pins and forgets stored memories for the Memory page', async () => {
  const browsed: unknown[] = []
  const pinned: boolean[] = []
  const forgotten: string[] = []
  const rows = [{ id: 'm1', scope: 'global' as const, project: '', ticket: '', kind: 'fact' as const, text: 'A stored fact.',
    tags: [], source: {}, pinned: false, at: '2026-01-01T00:00:00.000Z' }]
  const call = serve({ store: {
    settings: () => ({ memory: MemoryConfigSchema.parse({}) }),
    memories: {
      browse: (options: unknown) => { browsed.push(options); return rows.map(row => ({ ...row, source: {} })) },
      total: () => 3, countMatching: () => 2, pinnedTotal: () => 1,
      forget: (id: string) => { forgotten.push(id); return true },
      setPinned: (id: string, next: boolean) => { pinned.push(next); return { ...rows[0], id, pinned: next } },
    },
  } })
  // The page's keyword, project, order and page reach the store; the response carries both counts the hint names.
  const listed = await call('GET', 'memories?q=fact&project=app&sort=oldest&offset=20&limit=25')
  expect(listed.status).toBe(200)
  expect(listed.body).toMatchObject({ total: 3, matched: 2, pinned: 1, offset: 20, limit: 25,
    config: { enabled: false, inject: false }, items: [{ id: 'm1' }] })
  expect(browsed).toEqual([{ query: 'fact', project: 'app', sort: 'oldest', offset: 20, limit: 25 }])
  // An unknown order falls back to the newest; omitted filters are empty and paging starts at the first page.
  expect((await call('GET', 'memories?sort=nonsense')).status).toBe(200)
  expect(browsed).toHaveLength(2)
  expect(browsed[1]).toMatchObject({ query: '', project: '', sort: 'newest', offset: 0, limit: 20 })
  expect(await call('POST', 'memory/pin', { id: 'm1', pinned: true })).toEqual({ status: 200, body: { pinned: true } })
  expect(pinned).toEqual([true])
  expect(await call('POST', 'memory/forget', { id: 'm1' })).toEqual({ status: 200, body: { forgotten: true } })
  expect(forgotten).toEqual(['m1'])
  // Empty ids are rejected before reaching the store.
  expect((await call('POST', 'memory/forget', { id: '' })).status).toBe(400)
  expect((await call('POST', 'memory/pin', { id: '', pinned: true })).status).toBe(400)
})

it('answers 404 for a memory that is not stored', async () => {
  const call = serve({ store: {
    settings: () => ({ memory: MemoryConfigSchema.parse({}) }),
    memories: { setPinned: () => undefined },
  } })
  expect(await call('POST', 'memory/pin', { id: 'gone', pinned: true }))
    .toEqual({ status: 404, body: { error: 'Memory not found' } })
})

it('opens the setup wizard, refuses to skip it before a workspace is selected, and records the answer after one is', async () => {
  let saved: { at: string; skipped: boolean } | undefined
  const workspace = { path: '/srv/agent-home' }
  const base = {
    store: {
      settings: () => SettingsSchema.parse({ workspace }),
      tickets: { open: () => [] },
      get: () => saved,
      set: (_key: string, value: { at: string; skipped: boolean }) => { saved = value },
    },
    executor: { activeCount: () => 0 },
    configured: () => false,
    masterId: 'master',
    health: {},
    machine: { stateDir: '/srv/dsh-superagent-further', promptMaxChars: { get: () => 100_000 },
      admissionContextMaxPages: { get: () => 20 }, admissionContextTimeoutMs: { get: () => 60_000 } },
  }
  const call = serve(base)
  expect(await call('GET', 'state')).toMatchObject({ status: 200, body: { wizard: { firstRun: true, skipped: false } } })
  // Without a workspace, the wizard cannot record an answer: the host is paused in setupPending, and the next reload must
  // still present the workspace step as unanswered.
  const unset = serve({ ...base, store: { ...base.store, settings: () => SettingsSchema.parse({}) } })
  expect(await unset('PUT', 'wizard', { skipped: true })).toMatchObject({ status: 400,
    body: { setup: { place: 'execution', code: 'workspaceRequired' } } })
  expect(saved).toBeUndefined()
  // With a workspace selected, the skip is recorded and closes the wizard once no project is registered.
  expect(await call('PUT', 'wizard', { skipped: true })).toEqual({ status: 200, body: { firstRun: false, skipped: true } })
  expect(saved?.skipped).toBe(true)
  expect(Number.isNaN(Date.parse(saved!.at))).toBe(false)
  // Once answered, the wizard stays closed even though no project is registered.
  expect(await call('GET', 'state')).toMatchObject({ body: { wizard: { firstRun: false, skipped: true } } })
  // Registering a project also ends the first run before any answer is recorded.
  const registered = serve({ ...base, store: { ...base.store, get: () => undefined,
    settings: () => SettingsSchema.parse({ workspace, executor: { projects: [{ id: 'app', name: 'App', workspace: '/srv/app',
      repository: 'acme/app' }] } }) } })
  expect(await registered('GET', 'state')).toMatchObject({ body: { wizard: { firstRun: false, skipped: false } } })
  // The answer must be a boolean; a malformed body is refused before it reaches the store.
  const kept = saved
  expect(await call('PUT', 'wizard', { skipped: 'yes' })).toMatchObject({ status: 400 })
  expect(saved).toBe(kept)
})

it('serves the Automations page from one service path, with same-origin, validation and 503 states', async () => {
  const summary = { id: 'auto-1', scope: 'project' as const, project: 'default', report_only: true, title: 'Check the queue',
    instruction: 'Report what waits.', rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY', enabled: true, orphaned: false,
    host_status: 'active' as const, next_at: null, last_delivery_at: null, last_error: null, revision: 0,
    created_at: '2026-11-09T12:00:00.000Z', updated_at: '2026-11-09T12:00:00.000Z', dsh_task: 'schedule-1',
    target_session: 'lead-default' }
  const flagged = { ...summary, id: 'auto-2', dsh_task: 'schedule-2', orphaned: true, enabled: false,
    last_error: 'The Host task is missing' }
  const deliveries: Record<string, unknown[]> = {
    'auto-1': [{ at: '2026-11-09T09:01:00.000Z', kind: 'delivered', scheduled_at: '2026-11-09T09:00:00.000Z',
      delivered_at: '2026-11-09T09:00:00.000Z', message_id: 'm1', error: null }],
    'auto-2': [{ at: '2026-11-09T12:00:00.000Z', kind: 'orphaned', scheduled_at: null, delivered_at: null,
      message_id: null, error: 'The Host task is missing' }],
  }
  let refreshed = false
  const creates: unknown[][] = [], edits: unknown[][] = [], runs: unknown[][] = [], removals: unknown[][] = []
  const automations = {
    refresh: async () => { refreshed = true; return { checked: 2, observed: 1 } },
    list: async () => ({ items: [summary, flagged], unrecorded: [] }),
    history: (id: string) => deliveries[id] ?? [],
    create: async (input: Record<string, unknown>, actor: string) => {
      if (input.project === 'missing') throw new UnknownProjectError('missing')
      if (input.title === 'limit') throw new AutomationLimitError('Automation tasks are limited to 20; disable or edit an existing one first')
      creates.push([input, actor])
      return summary
    },
    edit: async (input: Record<string, unknown>, actor: string) => {
      if (input.id === 'gone') throw new UnknownAutomationError('gone')
      if (input.id === 'conflict') return { ...summary, conflict: true as const,
        warning: 'The Host task changed outside this plugin; review its schedule before editing again' }
      edits.push([input, actor])
      return summary
    },
    run: async (id: string, actor: string) => {
      if (id === 'gone') throw new UnknownAutomationError('gone')
      if (id === 'busy') throw new AutomationRunRefusedError('Automation busy is already queued or running on the Host; try again shortly',
        'schedule_execution_pending')
      runs.push([id, actor])
      return summary
    },
    remove: async (id: string, actor: string) => {
      if (id === 'gone') throw new UnknownAutomationError('gone')
      removals.push([id, actor])
      return { id, deleted: true as const }
    },
  }
  const store = { settings: () => ({ executor: { projects: [{ id: 'default', name: 'Default' }] } }) }
  const call = serve({ store, automations })
  expect(await call('GET', 'automations')).toEqual({ status: 200, body: { service: true,
    items: [{ ...summary, history: deliveries['auto-1'] }, { ...flagged, history: deliveries['auto-2'] }],
    unrecorded: [], projects: [{ id: 'default', name: 'Default' }], attention: 1 } })
  expect(refreshed).toBe(true)
  const body = { title: 'New task', instruction: 'Report it.', rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY', project: 'default' }
  expect(await call('POST', 'automations', body)).toMatchObject({ status: 200, body: { id: 'auto-1' } })
  expect(creates[0]).toEqual([{ ...body, enabled: true }, 'panel'])
  expect(await call('POST', 'automations', { ...body, project: 'missing' })).toEqual({ status: 400,
    body: { error: 'Project missing is not registered', code: 'projectNotRegistered' } })
  expect(await call('POST', 'automations', { ...body, title: 'limit' })).toMatchObject({ status: 400,
    body: { error: expect.stringContaining('limited to 20') } })
  expect(await call('PUT', 'automations/auto-1', { expected_revision: 0, title: 'Changed', enabled: false }))
    .toMatchObject({ status: 200, body: { id: 'auto-1' } })
  expect(edits[0]).toEqual([{ id: 'auto-1', action: 'update', expected_revision: 0, title: 'Changed', enabled: false }, 'panel'])
  expect(await call('PUT', 'automations/conflict', { enabled: false })).toEqual({ status: 409,
    body: { error: 'The Host task changed outside this plugin; review its schedule before editing again' } })
  expect(await call('PUT', 'automations/gone', { enabled: false })).toEqual({ status: 404, body: { error: 'Unknown automation gone' } })
  expect((await call('PUT', 'automations/auto-1', {})).status).toBe(400)
  // A manual run answers with the refreshed record; a Host refusal is a 409, not a server error.
  expect(await call('POST', 'automations/auto-1/run')).toEqual({ status: 200, body: { ran: true, automation: summary } })
  expect(runs[0]).toEqual(['auto-1', 'panel'])
  expect(await call('POST', 'automations/busy/run')).toEqual({ status: 409, body: {
    error: 'Automation busy is already queued or running on the Host; try again shortly', code: 'schedule_execution_pending' } })
  expect(await call('POST', 'automations/gone/run')).toEqual({ status: 404, body: { error: 'Unknown automation gone' } })
  expect(await call('DELETE', 'automations/auto-1')).toEqual({ status: 200, body: { id: 'auto-1', deleted: true } })
  expect(removals[0]).toEqual(['auto-1', 'panel'])
  expect(await call('DELETE', 'automations/gone')).toEqual({ status: 404, body: { error: 'Unknown automation gone' } })
  // Only the panel's same-origin header reaches the route.
  expect(await call('GET', 'automations', undefined, { 'x-orchestrator-request': undefined }))
    .toEqual({ status: 403, body: { error: 'Same-origin management request required' } })
  // Without the Host schedule service the routes say so instead of failing.
  const unavailable = serve({ store })
  expect(await unavailable('GET', 'automations')).toEqual({ status: 503,
    body: { error: 'The Host schedule service is not installed' } })
  expect((await unavailable('POST', 'automations', body)).status).toBe(503)
  expect((await unavailable('PUT', 'automations/auto-1', { enabled: false })).status).toBe(503)
  expect((await unavailable('POST', 'automations/auto-1/run')).status).toBe(503)
  expect((await unavailable('DELETE', 'automations/auto-1')).status).toBe(503)
})

it('serves the Host log page with level and scope filtering', async () => {
  const entries = [
    { at: '2026-11-10T01:00:00.000Z', level: 'info' as const, scope: 'github', message: 'polled' },
    { at: '2026-11-10T01:00:05.000Z', level: 'error' as const, scope: 'feishu', message: 'failed' },
  ]
  const asked: unknown[] = []
  const logs = { list: (query: unknown) => { asked.push(query); return entries } }
  const call = serve({ logs })
  expect(await call('GET', 'logs')).toEqual({ status: 200, body: { entries, level: 'all', scope: '', q: '' } })
  expect(asked[0]).toEqual({ level: 'all', scope: '', limit: 200, q: '' })
  expect(await call('GET', 'logs?level=warn&scope=feishu&limit=5&q=FAILED'))
    .toEqual({ status: 200, body: { entries, level: 'warn', scope: 'feishu', q: 'FAILED' } })
  expect(asked[1]).toEqual({ level: 'warn', scope: 'feishu', limit: 5, q: 'FAILED' })
  // An unknown level falls back to all instead of failing the page.
  expect((await call('GET', 'logs?level=nonsense')).body).toMatchObject({ level: 'all' })
  // Only the panel's same-origin header reaches the route.
  expect(await call('GET', 'logs', undefined, { 'x-orchestrator-request': undefined }))
    .toEqual({ status: 403, body: { error: 'Same-origin management request required' } })
})

it('filters the Host log API by keyword across message, scope and data, case-insensitively', async () => {
  const logs = new Logs(() => new Date(Date.UTC(2026, 10, 10)), 20)
  logs.record('info', 'assignment', 'assignment.launched ticket=t1')
  logs.record('warn', 'feishu', 'poll failed: timeout')
  logs.record('info', 'runtime', 'decision.recorded', { ticket: 'ticket-42', kind: 'Policy' })
  const call = serve({ logs })

  const entries = async (path: string) => (await call('GET', path)).body.entries as { message: string }[]
  expect((await entries('logs?q=LAUNCHED')).map(entry => entry.message)).toEqual(['assignment.launched ticket=t1'])
  expect((await entries('logs?q=feishu')).map(entry => entry.message)).toEqual(['poll failed: timeout'])
  expect((await entries('logs?q=POLICY')).map(entry => entry.message)).toEqual(['decision.recorded'])
  expect((await entries('logs?q=ticket-42')).map(entry => entry.message)).toEqual(['decision.recorded'])
  expect(await entries('logs')).toHaveLength(3)
  expect(await entries('logs?q=missing')).toHaveLength(0)
})

it('audits human-triggered domain actions with metadata only, never values or message text', async () => {
  const logs = new Logs(() => new Date('2026-11-11T00:00:00.000Z'))
  const call = serve({
    logs,
    store: {
      settings: () => SettingsSchema.parse({ executor: { projects: [{ id: 'default', name: 'Default', workspace: '/w', repository: 'acme/app' }] } }),
      tickets: { get: (id: string) => id === 't1' ? { id: 't1', title: 'Fix login' } : undefined },
    },
    sources: { instances: () => [{ id: 'github' }] },
    settings: {
      save: async () => ({ saved: true, revision: 7, restarting: false }),
      restore: async (...args: unknown[]) => ({ saved: true, revision: 8, policy_changed: false, restarting: false,
        context_delivery: 'injected', restoredFrom: args[1] }),
    },
    engine: { retryTicket: () => {}, stopTicket: () => {} },
    decideEscalation: async () => ({ id: 'pr-1', project: 'default', status: 'rejected',
      replies: [{ by: 'orchestrator', at: '2026-11-11T00:00:00.000Z', text: 'SECRET reply' }], tickets: [], reply_delivered: true }),
    automations: {
      create: async () => ({ id: 'auto-1' }), edit: async () => ({ id: 'auto-1' }),
      run: async () => ({ id: 'auto-1' }), remove: async () => ({ id: 'auto-1', deleted: true }),
    },
  })
  const settingsValue = { blockedCommands: ['gh-personal'], secretToken: 'SECRET setting value' }
  expect((await call('PUT', 'settings/executor', { value: settingsValue, revision: 0 })).status).toBe(200)
  expect((await call('POST', 'settings/eval/restore', { revision: 3, reason: 'SECRET reason' })).status).toBe(200)
  expect((await call('POST', 'tickets/t1/retry')).status).toBe(200)
  expect((await call('POST', 'tickets/t1/stop')).status).toBe(200)
  expect((await call('POST', 'escalations/pr-1/decide', { decision: 'reject', reply: 'SECRET reply' })).status).toBe(200)
  const automation = { title: 'SECRET automation title', instruction: 'SECRET instruction',
    rrule: 'DTSTART:20261111T090000Z\nRRULE:FREQ=DAILY', project: 'default' }
  expect((await call('POST', 'automations', automation)).status).toBe(200)
  expect((await call('PUT', 'automations/auto-1', { title: 'SECRET changed' })).status).toBe(200)
  expect((await call('POST', 'automations/auto-1/run')).status).toBe(200)
  expect((await call('DELETE', 'automations/auto-1')).status).toBe(200)

  const { body } = await call('GET', 'logs?scope=audit')
  const audit = body.entries as { at: string; level: string; scope: string; message: string; data?: Record<string, unknown> }[]
  expect(audit.map(entry => entry.message.split(' ')[0])).toEqual(['settings.save', 'settings.restore', 'ticket.retry',
    'ticket.stop', 'escalation.decide', 'automation.create', 'automation.edit', 'automation.run', 'automation.delete'])
  for (const entry of audit) {
    expect(entry.level).toBe('info')
    expect(entry.scope).toBe('audit')
    expect(entry.message).toContain('actor=operator')
    expect(entry.data?.actor).toBe('operator')
  }
  expect(audit[0]!.message).toContain('block=executor')
  expect(audit[0]!.message).toContain('revision=7')
  expect(audit[1]!.message).toContain('block=eval')
  expect(audit[1]!.message).toContain('restoredFrom=3')
  expect(audit[2]!.message).toContain('ticket=t1')
  expect(audit[4]!.message).toContain('request=pr-1')
  // Settings values, the restore reason, the reply text and an automation's instruction never reach the audit log.
  const text = JSON.stringify(audit)
  for (const secret of ['SECRET setting value', 'secretToken', 'gh-personal', 'SECRET reason', 'SECRET reply',
    'SECRET automation title', 'SECRET instruction', 'SECRET changed']) expect(text).not.toContain(secret)
})

it('does not audit automatic system events or human actions that fail', async () => {
  const logs = new Logs(() => new Date('2026-11-11T00:00:00.000Z'))
  logs.record('info', 'runtime', 'decision.recorded', { ticket: 't1' })
  const call = serve({
    logs,
    store: { settings: () => SettingsSchema.parse({}), blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async () => { throw new SettingsConflict('Settings changed. Reload before saving.') } },
  })
  expect((await call('GET', 'logs')).status).toBe(200)
  expect((await call('PUT', 'settings/executor', { value: {}, revision: 0 })).status).toBe(409)
  const { body } = await call('GET', 'logs?scope=audit')
  expect(body.entries).toEqual([])
})

/** The self-report table the real `SelfReports` service reads, without SQLite. */
class HttpSelfReportRecords implements SelfReportRepository {
  readonly rows = new Map<string, SelfReport>()
  get(id: string): SelfReport | undefined { return this.rows.get(id) }
  save(report: SelfReport): void { this.rows.set(report.id, report) }
  list(status?: SelfReportStatus): SelfReport[] {
    return [...this.rows.values()].filter(report => status === undefined || report.status === status)
  }
}

/** The two GitHub calls the outlet makes, asserting the fixed target and the create-only Issue write. */
class HttpSelfReportCommands {
  readonly writes: { path: string; body?: unknown }[] = []
  fail: Error | undefined
  async gh<T>(args: string[]): Promise<T> {
    if (args[1]?.includes('/issues?state=open') === true) return [] as T
    if (args[1]?.includes('/labels?per_page=') === true) return [] as T
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  async apiWrite(repository: string, method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<string> {
    expect([repository, method, path]).toEqual([SELF_REPOSITORY, 'POST', 'issues'])
    if (this.fail !== undefined) throw this.fail
    this.writes.push({ path, body })
    return JSON.stringify({ number: 70 + this.writes.length })
  }
}

/** A real outlet service in observe mode over in-memory records and the fake GitHub calls. */
function httpOutlet() {
  const records = new HttpSelfReportRecords()
  const commands = new HttpSelfReportCommands()
  const service = new SelfReports({
    store: { selfReports: records, settings: () => SettingsSchema.parse({}) },
    commands, projects: () => [], now: () => '2026-11-10T12:00:00.000Z', version: () => '0.3.0',
  })
  return { service, records, commands }
}

const draftFinding = (title: string) => ({ title, evidence: 'The watcher exits with ENOENT in state/watcher.json.',
  reproduction: 'Run the watcher, then stop polling.', session: 'master' })

async function draft(service: SelfReports, title: string): Promise<SelfReport> {
  const raised = await service.raise(draftFinding(title))
  if (raised.status !== 'draft') throw new Error(`expected a draft, got ${raised.status}`)
  return raised.report
}

it('files an approved self report over HTTP and audits both review actions with identifiers only', async () => {
  const logs = new Logs(() => new Date('2026-11-11T00:00:00.000Z'))
  const h = httpOutlet()
  const call = serve({ logs, selfReports: h.service })
  const first = await draft(h.service, 'Watcher crashes after a failed poll')
  expect(await call('POST', `self-reports/${first.id}/approve`)).toEqual({ status: 200,
    body: { status: 'filed', report_id: first.id, issue_number: 71 } })
  expect(h.commands.writes).toHaveLength(1)
  expect(h.commands.writes[0]!.body).toMatchObject({ title: 'Watcher crashes after a failed poll',
    body: expect.stringContaining('automated agent') })

  const second = await draft(h.service, 'Label refresh misses a closed pull request')
  expect(await call('POST', `self-reports/${second.id}/dismiss`)).toEqual({ status: 200,
    body: { status: 'dismissed', id: second.id } })

  const audit = (await call('GET', 'logs?scope=audit')).body.entries as { level: string; scope: string; message: string;
    data?: Record<string, unknown> }[]
  expect(audit.map(entry => entry.message)).toEqual([
    `self-report.approve report=${first.id} issue=71 status=filed actor=operator`,
    `self-report.dismiss report=${second.id} actor=operator`,
  ])
  for (const entry of audit) {
    expect(entry.level).toBe('info')
    expect(entry.scope).toBe('audit')
    expect(entry.data).toMatchObject({ actor: 'operator' })
  }
  expect(audit[0]!.data).toMatchObject({ action: 'self-report.approve', report: first.id, issue: 71, status: 'filed' })
  expect(audit[1]!.data).toMatchObject({ action: 'self-report.dismiss', report: second.id })
  // The finding's evidence never reaches the audit log, only its identifiers do.
  expect(JSON.stringify(audit)).not.toContain('ENOENT')
})

it('answers a failed, unfiled or unknown self-report action with its status and audits nothing', async () => {
  const logs = new Logs(() => new Date('2026-11-11T00:00:00.000Z'))
  const h = httpOutlet()
  const call = serve({ logs, selfReports: h.service })
  expect(await call('POST', 'self-reports/srep-unknown/approve')).toMatchObject({ status: 404,
    body: { code: 'selfReportUnknown' } })
  expect(await call('POST', 'self-reports/srep-unknown/dismiss')).toMatchObject({ status: 404,
    body: { code: 'selfReportUnknown' } })

  const pending = await draft(h.service, 'Watcher crashes after a failed poll')
  h.commands.fail = new Error('api unavailable')
  expect(await call('POST', `self-reports/${pending.id}/approve`)).toMatchObject({ status: 400,
    body: { code: 'selfReportFileFailed', values: { error: 'api unavailable' } } })
  expect(h.service.drafts().map(report => report.id)).toEqual([pending.id])
  expect((await call('GET', 'logs?scope=audit')).body.entries).toEqual([])

  // A service answer that leaves the report unfiled is a conflict, not a filed Issue, and records nothing either.
  const unfiled = serve({ logs, selfReports: { approve: async () => ({ status: 'draft', report: pending, reason: 'observe' }) } })
  expect(await unfiled('POST', `self-reports/${pending.id}/approve`)).toEqual({ status: 409,
    body: { error: 'Self report could not be filed' } })
  expect((await unfiled('GET', 'logs?scope=audit')).body.entries).toEqual([])
})


it('serves the update pipeline read-only and queues one confirmed rollback, refusing pending work with 409', async () => {
  let snapshot: UpdateSnapshot = {
    api: 1 as const, stateDir: '/srv/dsh-superagent-further',
    current: { version: '0.4.0', entry: 'runtime-entry.js', hostApi: 1, sha256: 'a'.repeat(64), schema: 25 },
    previous: { version: '0.3.0', entry: 'runtime-entry.js', hostApi: 1, sha256: 'b'.repeat(64), schema: 25 },
    journal: null, pending: null, busy: false,
    rollback: { eligible: true, version: '0.3.0', reason: '' },
    deploy: { command: 'node deploy', status: 'node deploy status', apply: 'node deploy apply --version <version>',
      rollback: 'node deploy rollback', watch: 'node deploy watch' },
    history: [], databaseSchema: 25,
  }
  const rollbacks: string[] = []
  const call = serve({ updates: {
    status: () => snapshot,
    attention: () => ({ pending: false, failed: false, version: null, phase: null, reason: null }),
    rollback: () => {
      if (snapshot.busy) return { ok: false, reason: 'An update is already in progress; wait for it to finish before rolling back.' }
      if (snapshot.pending !== null) return { ok: false, reason: 'An update request is already pending; wait for it to be claimed before rolling back.' }
      if (!snapshot.rollback.eligible) return { ok: false, reason: snapshot.rollback.reason || 'There is no previous runtime to roll back to.' }
      const request = { api: 1 as const, id: 'rb-1', action: 'rollback' as const, at: '2026-11-11T00:00:00.000Z', by: 'operator' as const }
      rollbacks.push(request.id)
      snapshot = { ...snapshot, pending: request, rollback: { eligible: false, version: '0.3.0', reason: 'An update request is pending' } }
      return { ok: true as const, request, status: snapshot }
    },
  } })
  expect((await call('GET', 'updates')).body).toMatchObject({ api: 1, current: { version: '0.4.0' }, previous: { version: '0.3.0' },
    rollback: { eligible: true } })
  // The confirmation token is literal: a missing, false or different token never queues anything.
  expect(await call('POST', 'updates/rollback', {})).toMatchObject({ status: 400 })
  expect(await call('POST', 'updates/rollback', { confirm: true })).toMatchObject({ status: 400 })
  expect(await call('POST', 'updates/rollback', { confirm: 'rollback' })).toMatchObject({ status: 400 })
  expect(rollbacks).toEqual([])
  const queued = await call('POST', 'updates/rollback', { confirm: 'ROLLBACK' })
  expect(queued).toMatchObject({ status: 200, body: { requested: true, request: { action: 'rollback', by: 'operator' },
    status: { pending: { action: 'rollback' } } } })
  expect(rollbacks).toEqual(['rb-1'])
  // A second request while one is pending is a conflict; the route writes nothing.
  expect(await call('POST', 'updates/rollback', { confirm: 'ROLLBACK' })).toMatchObject({ status: 409 })
  expect(rollbacks).toEqual(['rb-1'])
  // Busy and ineligible states are conflicts with the engine's own reason, never a queued request.
  snapshot = { ...snapshot, pending: null, busy: true, rollback: { eligible: true, version: '0.3.0', reason: '' } }
  expect(await call('POST', 'updates/rollback', { confirm: 'ROLLBACK' })).toMatchObject({ status: 409,
    body: { error: 'An update is already in progress; wait for it to finish before rolling back.' } })
  snapshot = { ...snapshot, busy: false, rollback: { eligible: false, version: null, reason: 'No previous runtime is recorded' } }
  expect(await call('POST', 'updates/rollback', { confirm: 'ROLLBACK' })).toMatchObject({ status: 409,
    body: { error: 'No previous runtime is recorded' } })
  // The rollback action is in the operator audit trail, naming the request only.
  const audit = (await call('GET', 'logs?scope=audit')).body.entries as { message: string; data?: Record<string, unknown> }[]
  expect(audit.map(entry => entry.message)).toEqual(['updates.rollback request=rb-1 actor=operator'])
  expect(audit[0]!.data).toMatchObject({ action: 'updates.rollback', request: 'rb-1' })
})
