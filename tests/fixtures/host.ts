/**
 * In-memory DSH host fixture (as in tests/runtime.spec.ts) running a configured Runtime with GitHub and Feishu sources,
 * allowed member Alice (`ou_alice`), listened chat `oc_team`, and `auto` eval mode. Stop it with `stop()`.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Runtime, type RuntimeOptions } from '../../src/app/runtime.ts'
import { Logs } from '../../src/app/logs.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import { Commands } from '../../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'
import type { Trigger } from '../../src/core/index.ts'
import type { Machine } from '../../src/deployment.ts'
import type { JobEvent, JobView } from '../../src/executor/background.ts'
import { buildRuntimeHost } from '../../src/supervisor/host.ts'
import { VERSION } from '../../src/version.ts'
import { testMachine } from './deployment.ts'
import { fakeWorkspaces, workspaceDirectory, type FakeWorkspaces } from './workspaces.ts'

export const MEMBER = 'ou_alice'
export const CHAT = 'oc_team'
/** The shell the Executor runs a prepare command with: PowerShell on Windows and the POSIX shell elsewhere. */
export const SHELL = process.platform === 'win32' ? 'pwsh' : 'sh'

/** Build a Feishu mention trigger from Alice in `oc_team`, using the digits in `id` as the timestamp offset in seconds. */
export function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  const at = String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000)
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: at,
    mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}

type RegisteredTool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
export type FakeAgent = {
  id: string; status: string; inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  cancel: Mock; inject: Mock<(message: UserMessage) => void>; steer: Mock<(message: UserMessage) => void>; followup: Mock<(message: UserMessage) => void>
  /** Resolves when the turn ends, which a test controls by setting `status = 'idle'`, as DSH's idle does. */
  whenIdle: () => Promise<void>
}
/** A text message, as DSH's job tools and subagents send their notices. */
const notice = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'tool-jobs', form: 'notice' } }) as unknown as UserMessage
type HttpHandler = (req: unknown, res: unknown) => Promise<void>
type Delivery = { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }

/**
 * DSH's job registry as the Executor uses it, with DSH's job tools: the jobs a Session can see, their events, a wait and a
 * kill. `run` starts a job a Session owns, `output` has one print, and `end` ends one, as its process does; an end no wait
 * collected reaches its owner, which it wakes when idle, as the job tools deliver it. `released` counts the waits ends
 * released.
 * @param owner - the agent of a Session, which an end reaches.
 */
export function jobRegistry(owner: (sessionId: string) => FakeAgent | undefined = () => undefined) {
  type Chunk = { at: number; text: string }
  type Job = { id: string; kind: string; owner: string; status: string; label?: string; startedAt: number; finishedAt?: number
    chunks: Chunk[]; total: number }
  const jobs = new Map<string, Job>()
  const listeners = new Set<{ owner: string; listener: (event: JobEvent) => void }>()
  const waits = new Map<string, ((job: JobView) => void)[]>()
  let released = 0
  const view = (job: Job): JobView => ({ id: job.id, kind: job.kind, label: job.label ?? job.id, owner: job.owner, status: job.status,
    startedAt: job.startedAt, ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    output: { total: job.total, earliest: 0 } })
  const emit = (job: Job, type: string, extra: { awaited?: boolean; cause?: string } = {}) => {
    for (const listener of [...listeners]) if (listener.owner === job.owner) listener.listener({ type, job: view(job), ...extra })
  }
  const end = (id: string, status = 'completed') => {
    const job = jobs.get(id)!
    job.status = status
    job.finishedAt = Date.now()
    const waiting = waits.get(id) ?? []
    waits.delete(id); released += waiting.length
    for (const wake of waiting) wake(view(job))
    emit(job, 'settled', { awaited: waiting.length > 0, cause: 'producer' })
    const agent = waiting.length ? undefined : owner(job.owner)
    const ended = notice(`notice-${id}`, `Job ${id} ended: ${status}`)
    if (agent?.status === 'idle') agent.followup(ended)
    else agent?.inject(ended)
  }
  const service = {
    list: vi.fn((caller: string) => [...jobs.values()].filter(job => job.owner === caller).map(view)),
    get: vi.fn((id: string, caller: string) => {
      const job = jobs.get(id)
      if (!job || job.owner !== caller) throw new Error(`Unknown job ${id}`)
      return view(job)
    }),
    readAt: vi.fn((id: string, from: number, caller: string) => {
      if (!Number.isSafeInteger(from) || from < 0) throw new Error(`Invalid job output offset ${from}`)
      const job = jobs.get(id)
      if (!job || job.owner !== caller) throw new Error(`Unknown job ${id}`)
      const chunks = job.chunks.filter(chunk => chunk.at + chunk.text.length > from)
      return { chunks, next: job.total, lossy: false }
    }),
    // A wait ends with the job, or fails once its signal aborts, which leaves the job's end uncollected.
    wait: vi.fn((id: string, _timeoutMs: number, _caller: string, signal?: AbortSignal) => new Promise<JobView>((resolve, reject) => {
      const wake = (job: JobView) => { signal?.removeEventListener('abort', abort); resolve(job) }
      const abort = () => { waits.set(id, (waits.get(id) ?? []).filter(item => item !== wake)); reject(new Error('wait aborted')) }
      waits.set(id, [...waits.get(id) ?? [], wake])
      signal?.addEventListener('abort', abort, { once: true })
    })),
    // A killed job ends a moment later, as its process does, also under a test's fake timers.
    kill: vi.fn((id: string) => { queueMicrotask(() => { end(id, 'killed') }); return 'requested' }) as Mock<(id: string) => string>,
    events: { subscribe: (filter: { owner: string }, listener: (event: JobEvent) => void) => {
      const entry = { owner: filter.owner, listener }
      listeners.add(entry)
      return () => { listeners.delete(entry) }
    } },
  }
  return { service, end, settle: (id: string) => { emit(jobs.get(id)!, 'settled') },
    output: (id: string, text = '') => {
      const job = jobs.get(id)!
      job.chunks.push({ at: job.total, text }); job.total += text.length
      emit(job, 'output')
    },
    get released() { return released },
    run: (owner: string, label?: string) => {
      const id = `bash-${jobs.size + 1}`
      jobs.set(id, { id, kind: 'bash', owner, status: 'running', label, startedAt: Date.now(), chunks: [], total: 0 })
      return id
    } }
}

/**
 * DSH's subagents as the Executor uses them. `spawn` starts a child of a Session, an agent while it lives, which a drain of
 * the Session's descendants refuses from then on; `settle` ends one, whose end wakes its idle parent or steers a running one
 * before a wait for the parent's children returns. Releasing or interrupting a child settles it; a drain of descendants
 * injects their ends. The catalog lists every child a Session had.
 */
export function subagentRuntime(agents: Map<string, FakeAgent>, options: {
  open?: (id: string, parent: string) => Promise<void>
  deliver?: (id: string, content: unknown) => void
} = {}) {
  const children = new Map<string, { parent: string; delivery: 'parent' | 'caller'; preset: string; live: boolean; settled: PromiseWithResolvers<unknown> }>()
  const closed = new Set<string>()
  /** Settle one child, optionally with the result its caller reads (a diagnosis document, or nothing). */
  const settle = (id: string, wake = true, result?: unknown) => {
    const child = children.get(id)
    if (!child?.live) return
    child.live = false
    agents.delete(id)
    const parent = agents.get(child.parent), ended = notice(`settled-${id}`, `Subagent ${id} settled`)
    if (!wake) parent?.inject(ended)
    else if (parent?.status === 'idle') parent.followup(ended)
    else parent?.steer(ended)
    child.settled.resolve(result)
  }
  const service = {
    waitForChildren: vi.fn(async (parent: { id: string }) => {
      const live = [...children.values()].filter(child => child.parent === parent.id && child.live)
      await Promise.all(live.map(child => child.settled.promise))
      return live.length > 0
    }),
    listChildren: vi.fn(async (id: string) => [...children].filter(([, child]) => child.parent === id).map(([childId]) => ({ id: childId }))),
    drainChildren: vi.fn(async (_parent: { id: string }, ids: readonly string[]) => { for (const id of ids) settle(id) }),
    drainDescendants: vi.fn(async (parents: readonly { id: string }[]) => {
      for (const parent of parents) {
        closed.add(parent.id)
        for (const [id, child] of children) if (child.parent === parent.id) settle(id, false)
      }
    }),
    interrupt: vi.fn((id: string) => { settle(id) }),
    // DSH's spawn provider starts a durable child with the reserved id and reports the same shape the Executor expects.
    startActivation: vi.fn(async (spec: { childId: string; delivery: 'parent' | 'caller'; request: { parent: { id: string }; agentPreset: string } }) => {
      const parent = spec.request.parent.id
      const id = spec.childId
      // A host with a real subagent service creates the child Session, decorates it and then delivers the activation prompt.
      if (options.open) await options.open(id, parent)
      if (agents.has(id) && !options.open) throw new Error(`subagent "${id}" already exists`)
      children.set(id, { parent, delivery: spec.delivery, preset: spec.request.agentPreset, live: true, settled: Promise.withResolvers<unknown>() })
      if (!agents.has(id)) agents.set(id, { id, status: 'running', session: { header: { parentSession: parent } }, whenIdle: async () => {} } as never)
      options.deliver?.(id, (spec.request as { prompt?: unknown }).prompt)
      // A Lead-hosted child is a durable Session: ending its Assignment disposes the activation, not the child. As DSH's spawn
      // provider does, disposing a live activation cancels a running child turn with the canonical `parent` kind; an idle child
      // has no turn to cancel, which is what the Executor's graceful retirement relies on. The child's inbox is the Session's,
      // so an in-process restart keeps it for the next Assignment.
      return { childId: id, result: children.get(id)!.settled.promise, dispose: async () => {
        const child = children.get(id)
        if (!child?.live) return
        const agent = agents.get(id)
        if (agent && agent.status !== 'idle') agent.cancel({ kind: 'parent' }, { keepInbox: true })
        child.live = false
      } }
    }),
    // The Lead's message reaches the child, which this fake records as a follow-up step.
    sendMessage: vi.fn(async (_sender: { id: string }, targetId: string, content: unknown[]) => {
      // The Lead's message reaches the child as a follow-up step, as DSH delivers it; a deleted child refuses it.
      const child = agents.get(targetId)
      if (!child) throw new Error(`Session ${targetId} not found`)
      // A message for a running turn is taken by its next step; an idle worker is woken by a follow-up that starts one.
      const message = { id: `message-${targetId}`, role: 'user', content, source: { kind: 'dsh-superagent-further', form: 'relay' } } as never
      if (child.status === 'idle') child.followup(message)
      else child.steer(message)
      return `message-${targetId}`
    }),
  }
  const spawn = (parent: string) => {
    if (closed.has(parent)) throw new Error('DRAINING: the Session admits no new subagents')
    const id = `child-${children.size + 1}`
    children.set(id, { parent, delivery: 'caller', preset: '', live: true, settled: Promise.withResolvers<unknown>() })
    agents.set(id, { id, status: 'running', session: { header: { parentSession: parent } }, whenIdle: async () => {} } as never)
    return id
  }
  return { service, settle, spawn, live: (id: string) => !!children.get(id)?.live,
    /** The request the fixture started a child with: its Lead, the delivery DSH was asked for, and its preset. */
    started: (id: string) => {
      const child = children.get(id)
      return child === undefined ? undefined : { parent: child.parent, delivery: child.delivery, preset: child.preset }
    } }
}

/** State a restart test hands from one start to the next, so a second Runtime opens the first one's database, registry and Sessions. */
export interface HostOptions {
  /** The state directory to reopen; a fresh temporary one is created when omitted. */
  directory?: string
  /** The workspace this start's settings select; a fresh temporary one is created when omitted. */
  workspace?: string
  /** The workspace registry shared across starts, so its registrations and archive set persist. */
  workspaces?: FakeWorkspaces
  /** The Session map shared across starts, so a Session an earlier start created resolves instead of being recreated. */
  agents?: Map<string, FakeAgent>
  /** Session ids that already exist before the Runtime starts, as an upgrade finds a previous build's master Session. */
  existingSessions?: readonly string[]
  /** Keep the state and workspace directories on `stop()`, so a test can start again on the same state. */
  keep?: boolean
}

/** @param seed - writes to the database before the Runtime opens it, such as records an earlier version stored. */
export async function startRuntime(seed?: (store: Store) => void, options: HostOptions = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'orchestrator-host-'))
  // An operator's workspace is a directory of its own, never the state directory; the fake registry also holds the state
  // directory's registration an earlier build would have created, so retirement is exercised on every start.
  const workspaceRoot = options.workspace ?? workspaceDirectory()
  const workspaces = options.workspaces ?? fakeWorkspaces(directory)
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const scoped = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'
  const answers: Record<string, string> = {
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(AGENT)}\0`,
    [scoped]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
  }
  /** A prepare command (`sh -c` on POSIX, `pwsh -NoProfile -NonInteractive -Command` on Windows) waits for this while it is set. */
  const hooks: { prepare?: Promise<void> } = {}
  const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const exited = { exitCode: 0, signal: null }
    const done = argv[0] === SHELL && hooks.prepare ? hooks.prepare.then(() => exited) : Promise.resolve(exited)
    return { done, collected: { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') } }
  }) }
  const agents = options.agents ?? new Map<string, FakeAgent>()
  /** Each Session's next step, which takes the messages that wait for one. */
  const steps = new Map<string, () => void>(), claims = new Map<string, () => void>()
  const tools = new Map<string, Map<string, RegisteredTool>>()
  const deliveries = vi.fn<(request: Delivery) => void>()
  let http!: HttpHandler
  const resolveDefault = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const controller = {
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const sessionTools = new Map<string, RegisteredTool>()
      tools.set(sessionId, sessionTools)
      const register = (tool: RegisteredTool) => { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) }
      agentCtx.reflect.provide('tools', { register, get: () => undefined, restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      // Runtime-context contributions (memory) register like prompt sections and are disposed the same way.
      const contexts = new Map<string, { name: string; order: number; text: unknown }>()
      agentCtx.reflect.provide('systemPrompt', {
        section: () => () => {},
        context: (entry: { name: string; order: number; text: unknown }) => {
          contexts.set(entry.name, entry)
          return () => { contexts.delete(entry.name) }
        },
      })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        // A pending message taken out, as DSH's inbox does by its id.
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      // A step claims each message once, all that wait for a step and, as a turn starts, the next queued one, and takes them into
      // the Session's history, unless it is `cut` off before, as a cancel in its pre-step does; DSH says each.
      const taken = new Set<string>()
      let turn = 0
      const take = (starts: boolean, cut = false) => {
        const agent = agents.get(sessionId)!
        const queued = starts ? inbox.nextTurn.filter(message => !taken.has(message.id)).slice(0, 1) : []
        for (const message of [...inbox.nextStep.filter(item => !taken.has(item.id)), ...queued]) {
          taken.add(message.id)
          ctx.emit('agent/inbox/claimed', { agent, message, turn } as never)
          if (!cut) ctx.emit('session/event', session as never, { type: 'user/message', data: message } as never)
        }
      }
      steps.set(sessionId, () => { take(false) })
      claims.set(sessionId, () => { take(false, true) })
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        // A message wakes an idle agent: its turn starts at once, and DSH says so, and its first step takes what waits.
        const agent = agents.get(sessionId)!
        if (agent.status !== 'idle') return
        agent.status = 'running'
        ctx.emit('agent/status', { agent, status: 'running' } as never)
        turn++
        take(true)
      })
      // Every Session has a header; an independent child has no parent Session here.
      const session = { id: sessionId, header: {} as Record<string, unknown>, snapshotEvents: () => [], requestHeader: () => undefined, append: vi.fn() }
      let status = 'idle'
      const idle: (() => void)[] = []
      // A cancel drops the inbox unless kept, and the turn it stops ends a moment later, which DSH says.
      const cancel = vi.fn((_cause: unknown, options?: { keepInbox?: boolean }) => {
        if (!options?.keepInbox) { inbox.nextTurn.length = 0; inbox.nextStep.length = 0 }
        if (status === 'idle') return
        queueMicrotask(() => {
          const agent = agents.get(sessionId)!
          if (agent.status === 'idle') return
          agent.status = 'idle'
          ctx.emit('agent/status', { agent, status: 'idle' } as never)
        })
      })
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), inject: vi.fn(), session, cancel,
        get status() { return status }, set status(next: string) { status = next; if (next === 'idle') for (const wake of idle.splice(0)) wake() },
        // Once its turn ended, as DSH's does.
        whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise<void>(resolve => { idle.push(resolve) }) } as never)
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(resolveDefault), rename: vi.fn(async () => {}),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }),
    inspect: vi.fn(async () => ({ events: [] })),
  }
  // Sessions that predate this start, as a migration finds an earlier build's master: they resolve, so retirement can archive
  // them, even though no code decorated them yet.
  for (const sessionId of options.existingSessions ?? []) {
    await (controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId })
  }
  const reader = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
  const persistence = { flush: vi.fn(async () => {}), open: vi.fn(async () => reader) }
  const webServer = { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return () => {} } }
  const jobs = jobRegistry(id => agents.get(id))
  const hostCtx: { ctx?: Context } = {}
  const subagents = subagentRuntime(agents, {
    open: async (id, parent) => {
      await (controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: id })
      // DSH's spawn provider records the parent in the child's header before the Session is decorated.
      const child = agents.get(id)! as unknown as { session: { header: Record<string, unknown> } }
      child.session.header = { parentSession: parent, agentPreset: 'dsh-superagent-further-worker' }
      await hostCtx.ctx!.parallel('agent/created', { agent: agents.get(id)! } as never)
    },
    deliver: (id, content) => (agents.get(id) as unknown as { followup(message: unknown): void } | undefined)
      ?.followup({ id: 'activation-' + id, role: 'user', content, source: { kind: 'dsh-superagent-further', form: 'relay' } }),
  })
  // DSH's permission presets, spied so a test can observe a Session put under read-only (ADR-0005).
  const permissionPresets = { set: vi.fn((_session: unknown, _preset: string) => {}) }
  const services = { agents, llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) }, sessionController: controller,
    sessionPersistence: persistence, workspaceRegistry: workspaces.registry, permissionPresets, subprocess, webServer,
    jobs: jobs.service, subagents: subagents.service }
  const ctx = new Context()
  hostCtx.ctx = ctx
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }, feishu: { enabled: true, config: { cli: BOT } } }
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), workspace: { path: workspaceRoot }, sources }))
  seed?.(seeded)
  // Every Ticket runs under a registered project's Lead, so a fixture starts with the deployment repository registered as one.
  const settled = seeded.settings()
  if (settled.executor.projects.length === 0) {
    seeded.saveSettings({ ...settled, executor: { ...settled.executor,
      projects: [{ id: 'default', name: 'Default', workspace: join(directory, 'default'), repository: 'acme/widgets', branch: '' }] } })
  }
  // An answer ticket reads an existing live checkout, so every seeded project needs its workspace directory.
  for (const project of seeded.settings().executor.projects) mkdirSync(project.workspace, { recursive: true })
  seeded.close()
  const runtime = startTestRuntime(ctx, testMachine({ stateDir: directory }), vi.fn())
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { ...sources, feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
  deliveries.mockClear()

  /** Parsed JSON payloads delivered to `sessionId`. */
  const relays = (sessionId: string) => deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
    .map(call => JSON.parse(call.text) as Record<string, unknown>)
  const candidates = () => relays(runtime.masterId).filter(item => item.kind === 'candidate').map(item => item.trigger_id)
  const runTool = async (sessionId: string, name: string, args: unknown) => {
    const tool = tools.get(sessionId)?.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
    return await tool.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
  }
  /** Route one decision with the main Session's orchestrator_route, answering its result; a refused one throws its reason. */
  async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    // The fixture registers one project; an accept that names none uses it, as a request routed by the model would.
    const named = item.kind === 'accept' && !item.project && !item.deliverables ? { ...item, project: 'default' } : item
    const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [named] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    return results[0]!
  }
  async function acceptedTicket(trigger: Trigger, deliverable: 'change' | 'answer' = 'change') {
    runtime.receive(trigger)
    await runtime.idle()
    const result = await route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: 'fix-regression',
      deliverable, acknowledgement: '收到，修复回归。' })
    await runtime.idle()
    const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    return { trigger, ticket, sessionId: `worker-${ticket.id}` }
  }
  /** Ends a change Ticket the way its own merged pull request does, so its ready report may finish it. */
  function mergeWithPull(ticketId: string) {
    const thread = { source: 'github', id: `pull-${ticketId}` }
    runtime.engine.bindThread(ticketId, thread, true)
    runtime.engine.threadClosed(thread, 'merged', new Date().toISOString())
  }
  async function api(method: string, path: string, json?: unknown) {
    let status = 0, text = ''
    const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  async function stop() {
    await runtime.stop(); vi.restoreAllMocks()
    if (options.keep) return
    rmSync(directory, { recursive: true, force: true })
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
  /** The Session's model takes its next step, which takes the messages steered in since its last. */
  const step = (sessionId: string) => { steps.get(sessionId)!() }
  /** A step of the worker claims what waits for it, and is cut off before the Session took it. */
  const claim = (sessionId: string) => { claims.get(sessionId)!() }
  return { runtime, ctx, directory, workspaceRoot, registry: workspaces.registry, workspaces, agents, tools, deliveries, relays, candidates, runTool, route, acceptedTicket, mergeWithPull, api, controller, subprocess, hooks, resolveDefault, stop,
    jobs, subagents, step, claim, permissionPresets }
}
export type Host = Awaited<ReturnType<typeof startRuntime>>

/**
 * Start a Runtime over a test host without the supervisor's directory lock, for the unit suites that do not test hosting.
 * The supervisor's own specs construct a Supervisor; this helper only gives the runtime its frozen host, a no-op restart,
 * and a sink that closes when the runtime drains.
 */
export function startTestRuntime(ctx: Context, machine: Machine, restart: () => void = () => {}, options: RuntimeOptions = {}): Runtime {
  let built: ReturnType<typeof buildRuntimeHost> | undefined
  built = buildRuntimeHost({
    context: ctx, machine, restart, exit: () => {}, version: VERSION, logger: ctx.logger,
    lifetime: new AbortController().signal,
    logs: new Logs(),
    flushLogs: async () => { await built!.logSink.close() },
    releaseStateLock: async () => {},
  })
  return new Runtime(built.host, options)
}
