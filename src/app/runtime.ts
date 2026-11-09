/** Application composition root and lifecycle manager for dsh-superagent-further. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { restrictToOwner } from '../infra/acl.ts'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth, type LeadRow } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { requestResultNotices } from './request-notices.ts'
import { HealthBoard } from '../infra/health.ts'
import { Automations, type ScheduleService } from './automations.ts'
import { localFile } from './files.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import type { SourceLabelChange, SourceLabelResult } from '../sources/kind.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { reclaimWorktrees } from './worktrees.ts'
import { setTimeout as delay } from 'node:timers/promises'

// Source plugins interact with dsh-superagent-further exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * DSH's session-ownership failure, said as the operator's action: which state directory another host holds, and how to
 * switch. DSH keeps a Session's write handle until that host process exits, so quitting the host — not only disabling
 * the plugin — is what releases it.
 */
export function hostedElsewhere(error: unknown, stateDir: string, masterId: string): unknown {
  if ((error as { code?: string } | undefined)?.code !== 'session/writer-held') return error
  return new Error(`dsh-superagent-further is already hosted for ${stateDir}: another DeepSeek Harness process still holds the orchestrator Session (${masterId}). Stop the other host: scripts/dsh-superagent-further stop for the service, or quit and reopen the DeepSeek Harness application, then start this one.`, { cause: error })
}

/**
 * Composition root of dsh-superagent-further that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  /** Installation automation tasks, present only when the Host's `schedule` service is installed. */
  readonly automations?: Automations
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void,
    /** Ends the host process once a management shutdown has stopped the runtime (injected so tests can observe it). */
    private readonly exit: (code: number) => void = code => { process.exit(code) }) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    // Windows ignores the mode above: an owner-only ACL takes its place, and a failure is reported rather than fatal.
    try { restrictToOwner(machine.stateDir, true) } catch (error) { ctx.logger.warn('dsh-superagent-further: %s', String(error)) }
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    let release: (() => unknown) | undefined
    try {
      release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    } catch (error) {
      throw new Error(`dsh-superagent-further is already hosted for ${machine.stateDir}. Stop the other host: scripts/dsh-superagent-further stop for the service, or disable the dsh-superagent-further plugin in the profile that runs it, then start this one.`, { cause: error })
    }
    this.releaseLock = async () => { await release?.() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent-further: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      // The schedule service is optional: without it the main Session has no automation tools and the rest of the runtime is
      // unchanged. Installations that mount it let the plugin create Host tasks that deliver turns to this main Session.
      const schedule = ctx.get('schedule') as ScheduleService | undefined
      this.automations = schedule === undefined ? undefined : new Automations({ schedule, store: store.automations, masterId,
        logger: ctx.logger, projects: () => store.settings().executor.projects.map(project => project.id),
        project: id => store.settings().executor.projects.find(project => project.id === id),
        // The Lead Session must exist before the Host task targets it; the closure runs after Sessions is constructed.
        lead: async project => (await runtime.sessions.ensureLead(project.id, project.workspace, `Lead · ${project.name}`)).id })
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime, automations: this.automations,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Report a Request whose Tickets all ended once, instead of once per Ticket.
          if (event.type === 'request.ended') {
            const request = store.requests.get(event.data.requestId)
            const first = request ? store.tickets.get(request.ticketIds[0] ?? '') : undefined
            const text = first ? store.triggers.get(first.origin.triggerId)?.text ?? '' : ''
            if (request) for (const message of requestResultNotices(request, text, id => store.tickets.get(id), setup.deployment.repository)) outbox.send(message)
          }
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            const requestRecord = ended.requestId ? store.requests.get(ended.requestId) : undefined
            // A Request delivered by several Tickets reports once, when the Request ends (see the request.ended branch below).
            if (!requestRecord || requestRecord.ticketIds.length === 1) {
              for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
            }
            // A worktree past its retention no longer needs to exist; a fresh one is kept so a person can inspect it.
            void runtime.reclaimFinishedWorktrees()
          }
          // Remember what ended, deterministically and without a model call, so a later Session can recall it with a tool or
          // see the pinned and most recent items in its prompt instead of replaying the conversation that produced them.
          try {
            // The Memory page's switches decide whether anything is remembered at all and whether it is automatic; both
            // are read on every event so a panel change applies immediately.
            const memory = store.settings().memory
            if (memory.enabled && memory.autoWrite && event.type === 'ticket.ended') {
              const done = store.tickets.get(event.data.ticketId)
              if (done?.ended) store.memories.save({
                kind: 'decision',
                ticket: done.id,
                ...done.project === undefined || done.project === '' ? {} : { project: done.project },
                text: `Ticket "${done.title}"${done.project === undefined || done.project === '' ? '' : ` in project ${done.project}`} ended ${done.ended.outcome} at ${done.ended.at}.`,
                source: { ticket: done.id, ...done.requestId === undefined ? {} : { request: done.requestId } },
                tags: [done.ended.outcome],
              }, done.ended.at)
            }
            if (memory.enabled && memory.autoWrite && event.type === 'request.ended') {
              const request = store.requests.get(event.data.requestId)
              if (request?.ended) store.memories.save({
                kind: 'decision',
                text: `Request "${request.title.slice(0, 200)}" (${request.ticketIds.length} Ticket${request.ticketIds.length === 1 ? '' : 's'}) ended ${request.ended.outcome} at ${request.ended.at}.`,
                source: { request: request.id },
                tags: [request.ended.outcome],
              }, request.ended.at)
            }
          } catch (error) {
            ctx.logger.warn('dsh-superagent-further could not remember a finished item: %s', String(error))
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        automations: this.automations,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        projects: () => store.settings().executor.projects,
        label: (triggerId, change) => this.label(triggerId, change),
        sendFile: request => this.sendFile(request),
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { void release?.() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent-further stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /**
   * Applies existing labels to the Issue or pull request `triggerId` names, through that Source kind's label adapter.
   * Throws for an unknown Trigger or a Source kind that cannot label work.
   */
  async label(triggerId: string, change: SourceLabelChange): Promise<SourceLabelResult> {
    const trigger = this.store.triggers.get(triggerId)
    if (trigger === undefined) throw new Error(`Unknown trigger ${triggerId}`)
    const kind = this.sources.kind(trigger.source)
    if (kind?.labels === undefined) throw new Error(`The ${trigger.source} Source cannot label work`)
    return kind.labels(this, trigger, change)
  }
  /**
   * Deliver one file from a project workspace to a chat through the Source kind that supports file messages. The Trigger
   * names both the chat and the Source; a bare chat ID uses the installed file-capable Source (Feishu). The file path is
   * resolved inside the project workspace and cannot leave it.
   */
  async sendFile(request: { triggerId?: string; chatId?: string; project: string; path: string }):
  Promise<{ source: string; chatId: string; messageId: string | null }> {
    const project = this.store.settings().executor.projects.find(item => item.id === request.project)
    if (project === undefined) throw new Error(`Unknown project ${request.project}`)
    let source: string
    let chatId: string
    if (request.triggerId !== undefined) {
      const trigger = this.store.triggers.get(request.triggerId)
      if (trigger === undefined) throw new Error(`Unknown trigger ${request.triggerId}`)
      source = trigger.source
      const address = trigger.channel?.address ?? {}
      const meta = trigger.meta as { chatId?: unknown }
      const named = typeof address.chatId === 'string' ? address.chatId : typeof meta.chatId === 'string' ? meta.chatId : undefined
      if (named === undefined) throw new Error(`The ${trigger.source} Trigger does not name a chat to deliver the file to`)
      chatId = named
    } else if (request.chatId !== undefined) {
      const candidates = this.sources.instances().filter(instance => instance.enabled && this.sources.kind(instance.kind)?.sendFile !== undefined)
      const preferred = candidates.find(instance => instance.id === 'feishu') ?? candidates[0]
      if (preferred === undefined) throw new Error('No installed Source can deliver files')
      source = preferred.id
      chatId = request.chatId
    } else throw new Error('Name a Trigger or a chat to deliver the file to')
    const kind = this.sources.kind(source)
    if (kind?.sendFile === undefined) throw new Error(`The ${source} Source cannot deliver files`)
    const file = await localFile(project.workspace, request.path)
    const idempotencyKey = `dsh-file-${key(chatId, file.directory, file.name, String(file.size), String(file.mtimeMs))}`
    const result = await kind.sendFile(this, { chatId, directory: file.directory, name: file.name, idempotencyKey })
    return { source, chatId, messageId: result.messageId }
  }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    try {
      await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent-further orchestrator', 'orchestrator')
    } catch (error) {
      throw hostedElsewhere(error, this.machine.stateDir, this.masterId)
    }
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    // Reconcile only after the main Session exists, because every Host target names it. A missing or changed Host task is
    // recorded as orphaned or drifted; it is never recreated silently (docs/011 B4).
    try {
      const reconciled = await this.automations?.reconcile()
      if (reconciled && (reconciled.orphaned || reconciled.drifted || reconciled.unrecorded)) {
        this.ctx.logger.warn('dsh-superagent-further automation reconciliation: %d checked, %d orphaned, %d drifted, %d unrecorded',
          reconciled.checked, reconciled.orphaned, reconciled.drifted, reconciled.unrecorded)
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-superagent-further automation reconciliation failed: %s', String(error))
    }
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    void this.cleanupLoop()
  }
  /** Removes the worktrees and `agent/` branches of Tickets that ended past the retention; failures are logged, never fatal. */
  private async reclaimFinishedWorktrees(): Promise<void> {
    try {
      const done = await reclaimWorktrees({ store: this.store, settings: this.store.settings(), stateDir: this.machine.stateDir })
      for (const item of done) if (item.removed) this.ctx.logger.info('dsh-superagent-further: removed the worktree of Ticket %s at %s', item.ticketId, item.directory)
    } catch (error) { this.ctx.logger.warn('dsh-superagent-further: worktree cleanup failed: %s', String(error)) }
  }
  private async cleanupLoop(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      await this.reclaimFinishedWorktrees()
      // Memory retention runs on the same schedule, so a changed retention applies without a restart.
      try { this.store.memories.prune() } catch (error) { this.ctx.logger.warn('dsh-superagent-further: memory cleanup failed: %s', String(error)) }
      try { await delay(6 * 60 * 60_000, undefined, { signal: this.stopped.signal }) } catch { break }
    }
  }
  /**
   * One row per registered project for the panel: its Lead Session, whether that Session runs, and how many executors and
   * undelivered messages the project holds. A project whose Lead was never started has no session and reports `absent`.
   */
  leadOverview(): LeadRow[] {
    const open = this.store.tickets.open()
    return this.store.settings().executor.projects.map(project => {
      const session = this.store.get(KV.lead.sessions(project.id))
      const agent = session === undefined ? undefined : this.ctx.agents.get(session as SessionId)
      return { project: project.id, name: project.name, session: session ?? '', status: agent?.status ?? 'absent',
        running: open.filter(ticket => ticket.project === project.id && ticket.assignments.at(-1)?.state === 'running').length,
        waiting: this.store.leads.waiting('lead', project.id).length }
    })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      automations: this.automations,
      leadOverview: () => runtime.leadOverview(),
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog(),
      requestShutdown: () => { runtime.requestShutdown() } }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  /**
   * Stops the runtime and then ends the host process. `scripts/dsh-superagent-further stop` requests this over the management API
   * because Windows cannot deliver a graceful signal to a detached process; POSIX stops send SIGINT and never take this path.
   */
  requestShutdown(): void {
    if (this.stopping) return
    void this.stop().then(() => { this.exit(0) }, (error: unknown) => {
      this.ctx.logger.error('dsh-superagent-further shutdown failed: %s', String(error))
      this.exit(1)
    })
  }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent-further could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
