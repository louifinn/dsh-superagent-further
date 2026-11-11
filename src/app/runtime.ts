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
import { Engine, key, projectRequestOpen, reasonText, runningAssignment, threadKey,
  type DomainEvent, type EngineForSettings, type ProjectRequest, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
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
import { evalsHealth, type DeliveryFailure, type LeadRow } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { captureLogs, captureScopes, Logs, type CaptureLogs, type HostLogger } from './logs.ts'
import { LogFileSink } from './log-files.ts'
import { decideEscalation, type EscalationDecisionInput, type EscalationDecisionResult } from './escalations.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices, pullEndReceipt } from '../sources/github-pull.ts'
import { projectApprovalChannels, projectApprovalNotices, projectResultChannels, projectResultNotices, requestResultNotices }
  from './request-notices.ts'
import { HealthBoard } from '../infra/health.ts'
import { Automations, type ScheduleService } from './automations.ts'
import { localFile } from './files.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import type { SourceLabelChange, SourceLabelResult } from '../sources/kind.ts'
import { SOURCE as SESSION_SOURCE, sessionDecisionText, sessionKind, sessionSubmitTool } from '../sources/session.ts'
import { Sessions, leadSessionId } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { bindLeadApprovals } from './tools/lead.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { reclaimWorktrees } from './worktrees.ts'
import { setTimeout as delay } from 'node:timers/promises'

// Source plugins interact with dsh-superagent-further exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
/** How often the Runtime looks for a running Assignment whose worker Session has stalled. */
const WATCHDOG_MS = 60_000
/** How long a worker Session may stay idle on a running Assignment before the watchdog raises the Ticket's attention. */
const STALLED_MS = 10 * 60_000
/** How many recent file-delivery failures Overview keeps, newest last, until the ring drops them. */
const DELIVERY_FAILURES = 20

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
  /** True until the startup summary is written, so the first ready of each claim is not logged one by one. */
  private starting = true
  private readonly board = new HealthBoard((name, previous, next) => this.healthChanged(name, previous, next))
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  /** Installation automation tasks, present only when the Host's `schedule` service is installed. */
  readonly automations?: Automations
  private readonly sourceLinks = new TextCache(200_000)
  /** Bounded in-memory log of the plugin host's own messages; the panel reads it through `GET logs`. */
  readonly logs = new Logs()
  /** The durable JSONL files' health: a failed write reports here once, and its recovery reports ready. */
  private readonly logsHealth = this.board.claim('logs', { state: 'ready', detail: '' })
  private logsSink?: LogFileSink
  private readonly log: CaptureLogs
  /** Creates a capture logger per scope over the same ring and Host logger. */
  private readonly capture: (scope: string) => CaptureLogs
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** The stalled Assignments the watchdog reported, by Ticket: the Assignment, its attention, and the Report that raised it. */
  private readonly stalled = new Map<string, { assignmentId: string; attentionId?: string; reportAt: string }>()
  /** Recent file-delivery failures, newest last and bounded, shown by Overview until the ring drops them. */
  private readonly deliveries: DeliveryFailure[] = []
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void,
    /** Ends the host process once a management shutdown has stopped the runtime (injected so tests can observe it). */
    private readonly exit: (code: number) => void = code => { process.exit(code) }) {
    super(ctx, 'orchestrator')
    const host = ctx.logger as unknown as HostLogger
    this.log = captureLogs(this.logs, host, 'host')
    this.capture = captureScopes(this.logs, host)
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    // Windows ignores the mode above: an owner-only ACL takes its place, and a failure is reported rather than fatal.
    try { restrictToOwner(machine.stateDir, true) } catch (error) { this.log.warn('dsh-superagent-further: %s', String(error)) }
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
      const report = (error: unknown) => { this.log.warn('dsh-superagent-further: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart, log: this.capture('setup') })
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
        logger: this.capture('automation'), projects: () => store.settings().executor.projects.map(project => project.id),
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
        lifetime: this.lifetime, automations: this.automations, log: this.capture('session'),
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      // The durable sink is attached once settings exist, so its retention and the ring's minimum level apply from the first
      // entry the panel would show. Entries recorded before this point stay in the ring only.
      this.logsSink = new LogFileSink({
        stateDir: machine.stateDir,
        retentionDays: () => store.settings().executor.logRetentionDays,
        onState: (state, detail) => { this.logsHealth.set({ state, detail }) },
      })
      this.logs.attach(this.logsSink)
      this.logs.setMinLevel(() => store.settings().executor.logLevel)
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger), log: this.capture('executor') })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused(), log: this.capture('outbox') })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          this.recordLifecycle(event)
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
          // Always answer a Session submission: an independent DSH Session sees every outcome, including the ones that
          // start no work, and an accept promises the final result in the same Session (docs/012 D9). Filtered triggers
          // never reach a Decision, so nothing is queued for them.
          if (event.type === 'decision.recorded') {
            const decision = store.decisions.get(event.data.decisionId)
            if (decision) for (const triggerId of new Set(decision.triggerIds)) {
              const trigger = store.triggers.get(triggerId)
              if (trigger?.source !== SESSION_SOURCE || !trigger.channel) continue
              outbox.send({ id: key('session-reply', decision.id, trigger.id), channel: trigger.channel, kind: 'notice',
                text: sessionDecisionText(decision, trigger) })
            }
          }
          // Report a completed project request's whole derived chain once, through the Channels it started in (docs/012 D6).
          if (event.type === 'project-request.completed') {
            const root = store.projectRequests.get(event.data.projectRequestId)
            // A derived request completes into its root's aggregate report; only a root sends one.
            if (root && !root.root?.project_request_id) {
              const channels = projectResultChannels(root, id => store.requests.get(id), id => store.triggers.get(id))
              const report = projectResultNotices(root, channels, id => store.tickets.get(id), id => store.projectRequests.get(id), setup.deployment.repository)
              for (const message of report) outbox.send(message)
            }
          }
          // Ask the root Channel to approve an architecture request's design once its design Ticket ended (docs/012 D7).
          if (event.type === 'project-request.approval-requested') {
            const request = store.projectRequests.get(event.data.projectRequestId)
            if (request) {
              const channels = projectApprovalChannels(request, id => store.requests.get(id), id => store.triggers.get(id))
              for (const message of projectApprovalNotices(request, channels)) outbox.send(message)
            }
          }
          // A person's message on an awaiting approval's root thread reaches its Lead, which records the answer (docs/012 D7).
          if (event.type === 'trigger.received') {
            const trigger = store.triggers.get(event.data.triggerId)
            if (trigger?.human) runtime.routeApprovalReply(trigger)
          }
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            const requestRecord = ended.requestId ? store.requests.get(ended.requestId) : undefined
            // A Request delivered by several Tickets reports once, when the Request ends (see the request.ended branch below).
            if (!requestRecord || requestRecord.ticketIds.length === 1) {
              for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
              // Relay the end to the project Lead, which tells the Ticket's worker Sessions (docs/010). A project-less
              // installation Ticket has no Lead to tell.
              const receipt = pullEndReceipt(ended, setup.deployment.repository)
              if (receipt) void sessions.lead.pullEnded(ended, receipt).catch(error => {
                this.log.warn('dsh-superagent-further could not relay a pull request ending to the Lead of project %s: %s',
                  ended.project ?? '', String(error))
              })
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
            this.log.warn('dsh-superagent-further could not remember a finished item: %s', String(error))
          }
        } })
      // The Lead tools and the reply enforcement act through the Engine; attach it once the composition is complete.
      sessions.attachEngine(engine)
      // The approval tools read and write through the same Engine; bind them by the Store the Lead tools are built with.
      bindLeadApprovals(store, {
        raise: input => engine.raiseProjectRequest(input),
        escalate: input => engine.escalateProjectRequest(input),
        plan: (id, plan) => engine.planProjectRequest(id, plan),
        requestApproval: id => engine.requestProjectApproval(id),
        approve: (id, input) => engine.approveProjectRequest(id, input),
        review: ticketId => this.executor.review(ticketId),
        recordReview: (ticketId, review) => engine.recordReview(ticketId, review),
      })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger),
        log: kind => this.capture(kind) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        automations: this.automations, log: this.capture('executor'),
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        projects: () => store.settings().executor.projects,
        label: (triggerId, change) => this.label(triggerId, change),
        sendFile: request => this.sendFile(request),
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      // The `session` Source and its global tool: an independent DSH Session submits through the ordinary intake, and
      // every Decision plus the final Request report is delivered back into that Session. The kind is registered
      // unconditionally so intake, replies and completion work even when the Host exposes no root tools service.
      const sessionHost = {
        receive: (trigger: Trigger): ReceiveResult | Promise<ReceiveResult> => this.receive(trigger),
        accepting: (): { ok: true } | { ok: false; reason: string } => runtime.closing()
          ? { ok: false, reason: 'dsh-superagent-further is stopping.' }
          : !setup.configured() ? { ok: false, reason: 'dsh-superagent-further is waiting for setup to finish.' }
            : store.settings().paused ? { ok: false, reason: 'dsh-superagent-further is paused.' }
              : runtime.sources.instance(SESSION_SOURCE)?.enabled === false
                ? { ok: false, reason: 'The DSH Session Source is off; enable it in dsh-superagent-further\'s Sources settings.' }
                : { ok: true },
        projects: () => store.settings().executor.projects,
        // Master, project Lead and ticket worker Sessions are managed by this plugin; their models call its tools.
        managed: (sessionId: string) => sessionId === masterId || sessionId.startsWith('lead-') || sessionId.startsWith('worker-'),
      }
      this.disposers.push(this.sources.register(sessionKind((sessionId, requestId, text) =>
        this.sessions.prompt(sessionId, requestId, text, 'queue'))))
      // A Session's model only sees a global tool; agent-scoped registrations exist only in managed Sessions.
      const sessionTool = ctx.inject(['tools'], child =>
        child.effect(() => child.tools.register(sessionSubmitTool(sessionHost)), 'session: submission tool'))
      this.disposers.push(() => { void sessionTool.dispose().catch(() => {}) })
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
    try {
      const file = await localFile(project.workspace, request.path)
      const idempotencyKey = `dsh-file-${key(chatId, file.directory, file.name, String(file.size), String(file.mtimeMs))}`
      const result = await kind.sendFile(this, { chatId, directory: file.directory, name: file.name, idempotencyKey })
      return { source, chatId, messageId: result.messageId }
    } catch (error) {
      // Keep the reason whole: the tool response quotes it, Overview shows it, and the panel's Logs tab keeps the warning.
      const reason = error instanceof Error ? error.message : String(error)
      const failure = `Could not deliver ${request.path} to chat ${chatId} through ${source}: ${reason}`
      this.deliveries.push({ path: request.path, chat: chatId, reason, at: now() })
      if (this.deliveries.length > DELIVERY_FAILURES) this.deliveries.splice(0, this.deliveries.length - DELIVERY_FAILURES)
      this.log.warn('%s', failure)
      throw new Error(failure, { cause: error })
    }
  }
  /** The recent file-delivery failures, newest last; Overview turns each into a problem row. */
  deliveryFailures(): readonly DeliveryFailure[] { return this.deliveries }
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
    // A Lead turn that ended while the Host was down may have left requests or worker reports unanswered: prompt it for
    // each one now, so a restart does not silently drop a request.
    try {
      await this.sessions.lead.reconcile()
    } catch (error) {
      this.log.warn('dsh-superagent-further lead reconciliation failed: %s', String(error))
    }
    // Reconcile only after the main Session exists, because every Host target names it. A missing or changed Host task is
    // recorded as orphaned or drifted; it is never recreated silently (docs/011 B4).
    try {
      const reconciled = await this.automations?.reconcile()
      if (reconciled && (reconciled.orphaned || reconciled.drifted || reconciled.unrecorded)) {
        this.log.warn('dsh-superagent-further automation reconciliation: %d checked, %d orphaned, %d drifted, %d unrecorded',
          reconciled.checked, reconciled.orphaned, reconciled.drifted, reconciled.unrecorded)
      }
    } catch (error) {
      this.log.warn('dsh-superagent-further automation reconciliation failed: %s', String(error))
    }
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    this.logStartupSummary()
    void this.cleanupLoop()
    void this.watchdogLoop()
  }
  /**
   * Send a person's reply on the root thread of an awaiting-approval project request to its Lead (docs/012 D7). The Lead
   * records the answer with `lead_request_approve` from that human message, or answers with `lead_request_reply`; the request
   * stays awaiting-approval until it does, so an approval can never come from the Lead's own text alone.
   */
  private routeApprovalReply(trigger: Trigger): void {
    if (!trigger.human) return
    const threads = new Set(trigger.threads.map(threadKey))
    let requests: ProjectRequest[] = []
    try {
      requests = this.store.projectRequests.list().filter(request => request.status === 'awaiting-approval'
        && request.root !== undefined && threads.has(request.root.thread_key)
        && (request.proposal === undefined || trigger.at >= request.proposal.at))
    } catch { return }
    for (const request of requests) {
      const text = `A person replied on the root thread of project request ${request.id} ("${request.title}"):\n\n${trigger.text}\n\n`
        + 'If this answers its design proposal, call lead_request_approve with approved true or false and a reply for the raiser. '
        + 'Otherwise call lead_request_reply so the person and the raiser get an answer.'
      void this.sessions.prompt(leadSessionId(request.project), `project-approval:${request.id}:${trigger.id}`, text, 'queue')
        .catch(error => { this.log.warn('dsh-superagent-further could not route an approval reply: %s', String(error)) })
    }
  }
  /** Removes the worktrees and `agent/` branches of Tickets that ended past the retention; failures are logged, never fatal. */
  private async reclaimFinishedWorktrees(): Promise<void> {
    try {
      const done = await reclaimWorktrees({ store: this.store, settings: this.store.settings(), stateDir: this.machine.stateDir })
      for (const item of done) if (item.removed) this.log.info('dsh-superagent-further: removed the worktree of Ticket %s at %s', item.ticketId, item.directory)
    } catch (error) { this.log.warn('dsh-superagent-further: worktree cleanup failed: %s', String(error)) }
  }
  private async cleanupLoop(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      await this.reclaimFinishedWorktrees()
      // Memory retention runs on the same schedule, so a changed retention applies without a restart.
      try { this.store.memories.prune() } catch (error) { this.log.warn('dsh-superagent-further: memory cleanup failed: %s', String(error)) }
      try { await delay(6 * 60 * 60_000, undefined, { signal: this.stopped.signal }) } catch { break }
    }
  }
  /**
   * One pass of the stalled-Assignment watchdog. A running Assignment whose worker Session has been idle past `STALLED_MS`
   * gets a waiting Report with a stable question, which raises the Ticket's attention, and one durable notice to its
   * project's Lead. The attention this pass raised is cleared when the Assignment ends or a newer Report arrives.
   *
   * Exposed so a test can pass an exact `at`; the loop only decides when to call it.
   */
  async watchdogScan(at = new Date()): Promise<void> {
    if (this.closing()) return
    const open = this.store.tickets.open()
    const ids = new Set(open.map(ticket => ticket.id))
    for (const ticketId of [...this.stalled.keys()]) if (!ids.has(ticketId)) this.stalled.delete(ticketId)
    // A paused Runtime dispatches nothing, so a worker idle now is not yet a stall a Lead could act on.
    if (this.paused()) return
    for (const ticket of open) {
      const assignment = runningAssignment(ticket)
      const tracked = this.stalled.get(ticket.id)
      if (!assignment) {
        if (tracked) this.clearStalled(ticket.id, tracked)
        continue
      }
      if (tracked && tracked.assignmentId !== assignment.id) this.clearStalled(ticket.id, tracked)
      const agent = this.ctx.agents.get(workerSessionId(ticket.id) as SessionId)
      if (agent && agent.status !== 'idle') continue
      // The worker's latest activity is its last turn end or its last Report, whichever is later: a Report shows it is alive.
      const since = [assignment.idleAt, assignment.report?.at].filter((value): value is string => value !== undefined)
        .sort().at(-1)
      if (!since || at.getTime() - Date.parse(since) < STALLED_MS) continue
      const current = this.stalled.get(ticket.id)
      // A Report newer than the one this watchdog wrote shows the worker alive: clear its attention and restart the clock.
      if (current && assignment.report && assignment.report.at > current.reportAt) {
        this.clearStalled(ticket.id, current)
        continue
      }
      // One notice per Assignment, and never over a question or attention another part of the Runtime raised.
      if (current || ticket.attention) continue
      const question = `The worker Session ${workerSessionId(ticket.id)} of Assignment ${assignment.id} has been idle since ${since} without a newer Report. Is the Assignment stuck?`
      try {
        const updated = this.engine.report(ticket.id, { state: 'waiting',
          summary: `Worker idle since ${since} on Assignment ${assignment.id}.`, question })
        this.logs.record('info', 'executor', `report.recorded ticket=${ticket.id} state=waiting outcome=${updated.ended?.outcome ?? 'none'}`)
        const reportAt = runningAssignment(updated)?.report?.at ?? now()
        this.stalled.set(ticket.id, { assignmentId: assignment.id, ...(updated.attention ? { attentionId: updated.attention.id } : {}), reportAt })
        await this.sessions.lead.stalled(updated, assignment, since)
      } catch (error) {
        this.log.warn('dsh-superagent-further watchdog could not raise attention for Ticket %s: %s', ticket.id, String(error))
      }
    }
  }
  /** Drop the attention the watchdog raised for a Ticket, while it is still the current one; nothing else is removed. */
  private clearStalled(ticketId: string, tracked: { attentionId?: string }): void {
    this.stalled.delete(ticketId)
    if (tracked.attentionId === undefined) return
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket?.attention || ticket.attention.id !== tracked.attentionId) return
    delete ticket.attention
    this.store.tickets.save({ ...ticket, updatedAt: now() })
  }
  /** Runs `watchdogScan` on its interval until the Runtime stops; the first look follows one full interval. */
  private async watchdogLoop(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      try { await delay(WATCHDOG_MS, undefined, { signal: this.stopped.signal }) } catch { break }
      try { await this.watchdogScan() } catch (error) {
        this.log.warn('dsh-superagent-further watchdog failed: %s', String(error))
      }
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
      const pending = this.store.projectRequests.list(project.id).filter(request => projectRequestOpen(request.status))
      return { project: project.id, name: project.name, session: session ?? '', status: agent?.status ?? 'absent',
        running: open.filter(ticket => ticket.project === project.id && ticket.assignments.at(-1)?.state === 'running').length,
        waiting: this.store.leads.waiting('lead', project.id).length,
        projectRequests: { pending: pending.length, automated: pending.filter(request => request.raised_by.automation !== undefined).length } }
    })
  }
  /**
   * Decides an escalated project request from the panel. The Lead receives the same mandatory reply the main
   * Session's tool delivers, because both go through `decideEscalation` (docs/012 D13).
   */
  decideEscalation(input: EscalationDecisionInput): Promise<EscalationDecisionResult> {
    return decideEscalation(this.engine, this.store, this.sessions, input)
  }
  /**
   * Logs a claim entering error and its recovery; every other state change is a readiness fact. Startup readies are
   * collected by `logStartupSummary` instead of one entry per claim, and same-state detail updates never reach this.
   */
  private healthChanged(name: string, previous: Health | undefined, next: Health): void {
    if (next.state === 'error') {
      this.logs.record('warn', name, `${name} is error: ${this.short(next.detail)}`)
      return
    }
    if (next.state !== 'ready') return
    if (previous?.state === 'error') {
      this.logs.record('info', name, `${name} recovered: ready`)
      return
    }
    if (this.starting) return
    this.logs.record('info', name, `${name} is ready`)
  }
  /** One startup entry for the claims that came up ready, so a dozen claims do not each produce a line. */
  private logStartupSummary(): void {
    this.starting = false
    const entries = Object.entries(this.board.all)
    const ready = entries.filter(([, value]) => value.state === 'ready').map(([name]) => name).sort()
    const notReady = entries.filter(([, value]) => value.state !== 'ready').map(([name, value]) => `${name}=${value.state}`).sort()
    this.logs.record('info', 'runtime', `runtime ready: ${ready.length} claims ready (${ready.join(', ')})`
      + (notReady.length ? `; not ready: ${notReady.join(', ')}` : ''))
  }
  /** One short info entry per operational Engine event; it carries ids and outcomes, never a message body. */
  private recordLifecycle(event: DomainEvent): void {
    switch (event.type) {
      case 'trigger.received':
        this.logs.record('info', 'trigger', `trigger.received trigger=${event.data.triggerId} threads=${event.data.threads.length}`)
        return
      case 'ticket.created':
        this.logs.record('info', 'ticket', `ticket.created ticket=${event.data.ticketId} decision=${event.data.decisionId} strength=${event.data.strength}`)
        return
      case 'ticket.ended':
        this.logs.record('info', 'ticket', `ticket.ended ticket=${event.data.ticketId} by=${event.data.by} cause=${event.data.cause} outcome=${event.data.outcome}`)
        return
      case 'request.ended':
        this.logs.record('info', 'request', `request.ended request=${event.data.requestId} by=${event.data.by} outcome=${event.data.outcome}`)
        return
      case 'assignment.started':
        this.logs.record('info', 'assignment', `assignment.started ticket=${event.data.ticketId} assignment=${event.data.assignmentId}`)
        return
      case 'assignment.ended':
        this.logs.record('info', 'assignment', `assignment.ended ticket=${event.data.ticketId} assignment=${event.data.assignmentId} reason=${this.short(event.data.reason)}`)
        return
      case 'decision.recorded':
        this.logs.record('info', 'runtime', `decision.recorded decision=${event.data.decisionId} kind=${event.data.kind} thread=${event.data.threadKey}`)
        return
      case 'policy.changed':
        this.logs.record('info', 'runtime', `policy.changed from=${this.short(event.data.from)} to=${this.short(event.data.to)}`)
        return
      default:
        return
    }
  }
  /** A one-line excerpt for a log entry; entries stay short and never carry a message or comment body. */
  private short(value: string, max = 80): string {
    const line = value.replace(/\s+/g, ' ').trim()
    return line.length <= max ? line : `${line.slice(0, max - 3)}...`
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, logs: this.logs,
      automations: this.automations,
      leadOverview: () => runtime.leadOverview(),
      deliveryFailures: () => runtime.deliveryFailures(),
      decideEscalation: input => runtime.decideEscalation(input),
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
      this.log.error('dsh-superagent-further shutdown failed: %s', String(error))
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
      // Flush the durable log before the Store closes: the sink needs no Store, but closing first keeps every shutdown entry
      // that preceded it on disk. close() accepts nothing from its first line and writes the last batch with asynchronous
      // appends, so the timer can actually fire; the bound gives up waiting on a stuck disk without blocking the event loop.
      const sink = this.logsSink
      if (sink) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); timer.unref?.() })
        try {
          await Promise.race([sink.close(), bound])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.log.warn('dsh-superagent-further could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
