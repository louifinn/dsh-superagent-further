import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { AutomationLimitError, AutomationRunRefusedError, UnknownAutomationError, UnknownProjectError } from '../src/app/automations.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict, SettingsRevisionNotFound } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { MemoryConfigSchema, SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
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
    config: { enabled: true, inject: true }, items: [{ id: 'm1' }] })
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

it('opens the setup wizard on a first run and records the answer in the key-value store', async () => {
  let saved: { at: string; skipped: boolean } | undefined
  const base = {
    store: {
      settings: () => SettingsSchema.parse({}),
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
  expect(await call('PUT', 'wizard', { skipped: true })).toEqual({ status: 200, body: { firstRun: false, skipped: true } })
  expect(saved?.skipped).toBe(true)
  expect(Number.isNaN(Date.parse(saved!.at))).toBe(false)
  // Once answered, the wizard stays closed even though no project is registered.
  expect(await call('GET', 'state')).toMatchObject({ body: { wizard: { firstRun: false, skipped: true } } })
  // Registering a project also ends the first run before any answer is recorded.
  const registered = serve({ ...base, store: { ...base.store, get: () => undefined,
    settings: () => SettingsSchema.parse({ executor: { projects: [{ id: 'app', name: 'App', workspace: '/srv/app',
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
