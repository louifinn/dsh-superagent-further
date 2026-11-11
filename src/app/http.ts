/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { record } from '../kv.ts'
import { MEMORY_SORTS } from '../memory.ts'
import { THREAD_FILTERS, TICKET_FILTERS, INCIDENT_STATUS_FILTERS, INCIDENT_SEVERITY_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { AutomationCreateSchema, AutomationLimitError, AutomationRunRefusedError, AutomationUpdateSchema, UnknownAutomationError, UnknownProjectError,
  type Automations } from './automations.ts'
import type { AutomationsView } from './views/automations.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, SettingsRevisionNotFound, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { WorkspaceSetupError } from './workspace-root.ts'
import { UserError, latestAssignment, runningAssignment, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { workerSessionId, type DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { EscalationDecisionInput, EscalationDecisionResult } from './escalations.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { LeadRow, DeliveryFailure } from './views/overview.ts'
import type { SelfReports } from './self-reports.ts'
import type { Incidents } from './incidents.ts'
import type { IncidentFilter } from '../core/incidents.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { memoriesView } from './views/memories.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import type { LogFilter, Logs, LogsView } from './logs.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  /** Bounded in-memory log of the plugin host's own messages, plus the audit trail of human-triggered actions. */
  readonly logs: Pick<Logs, 'list' | 'record'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'restore' | 'pause' | 'sync' | 'refreshLabels' | 'proposals' | 'proposal' | 'applyProposal' | 'rejectProposal'>
  readonly engine: EngineForPeople
  /** Decide one escalated project request and deliver its mandatory reply to the Lead. */
  decideEscalation(input: EscalationDecisionInput): Promise<EscalationDecisionResult>
  readonly executor: Pick<DshExecutor, 'activeCount' | 'jobsSnapshot'>
  /** One row per registered project: its Lead Session, and the executors and messages it holds. */
  leadOverview(): LeadRow[]
  /** File deliveries that failed since startup, newest last; Overview shows each as a problem. */
  deliveryFailures(): readonly DeliveryFailure[]
  /** The plugin's automation tasks; absent when the Host's `schedule` service is not installed. */
  readonly automations?: Automations
  /** The self-evolution Issue outlet: drafts for the Overview, and the approve/dismiss actions. */
  readonly selfReports: SelfReports
  /** Deterministic incident records and their evidence bundles (docs/015). */
  readonly incidents: Incidents
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  /** The prepared orchestrator workspace, shown by the panel; null until the operator selects one. */
  readonly workspace?: { path: string; title: string } | null
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  /** Stop the runtime, then end the host process; requested by the service script where no graceful signal exists. */
  requestShutdown(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing refusal raised during management route parsing or lookup, with the HTTP status the route answers.
 * Route handlers throw it when request bodies are malformed, records are missing, or a Host service is unavailable.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof WorkspaceSetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UnknownProjectError) return [400, { error: error.message, code: 'projectNotRegistered' }]
  if (error instanceof UnknownAutomationError) return [404, { error: error.message }]
  if (error instanceof AutomationRunRefusedError) {
    return [error.code === 'schedule_not_found' ? 404 : 409, { error: error.message, code: error.code }]
  }
  if (error instanceof AutomationLimitError) return [400, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsRevisionNotFound) return [404, { error: error.message }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    workspace: runtime.workspace ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/**
 * KV record of the setup wizard: when the operator last finished or skipped it, and which of the two it was.
 * A missing record is what makes a first run open the wizard, so it survives panel reloads without touching Settings.
 */
const WizardRecord = record<{ at: string; skipped: boolean }>('setup-wizard')
/**
 * First-run state of the setup wizard: it opens while no workspace is selected, and while no project is registered and the
 * operator never finished or skipped it. A workspace is mandatory, so an upgrade pauses here until the operator chooses one.
 */
function wizardView(runtime: HttpHost) {
  const done = runtime.store.get(WizardRecord)
  return { firstRun: runtime.store.settings().workspace.path === '' || (runtime.store.settings().executor.projects.length === 0 && done === undefined),
    skipped: done?.skipped ?? false }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent-further status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    wizard: wizardView(runtime),
    // The pending-proposal count is the Settings badge on the groups without a settings body; those with one show the list's own heading.
    proposals: runtime.store.proposals?.pending().length ?? 0,
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** The Automations page's response: the tasks with their recent deliveries, unrecorded Host tasks, and the create form's projects. */
async function automationsPage(runtime: HttpHost): Promise<AutomationsView> {
  const service = runtime.automations
  if (service === undefined) throw new RouteError(503, 'The Host schedule service is not installed')
  // Reading the Host once here records deliveries that arrived since startup; it does not bump revisions or audit.
  await service.refresh()
  const list = await service.list()
  const items = list.items.map(item => ({ ...item, history: service.history(item.id) }))
  return { service: true, items, unrecorded: list.unrecorded,
    projects: runtime.store.settings().executor.projects.map(({ id, name }) => ({ id, name })),
    attention: items.filter(item => item.orphaned || item.last_error !== null).length }
}
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
/**
 * The Execution tab's Workers block: each open Ticket's worker Session, its current Assignment state, and the shell jobs it
 * settled or still runs with their output preview. A live job is observed through `DshExecutor.jobsSnapshot`, never waited on.
 */
function workersPage(runtime: HttpHost) {
  const jobs = runtime.executor.jobsSnapshot()
  return { items: runtime.store.tickets.open().map(ticket => {
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    return { ticket: ticket.id, title: ticket.title, session: workerSessionId(ticket.id), assignment: assignment?.state ?? null,
      assignmentId: assignment?.id ?? null, jobs: jobs.get(ticket.id) ?? [] }
  }) }
}
export type WorkersView = ReturnType<typeof workersPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const LogsQuery = z.object({ level: z.enum(['all', 'warn', 'error']).catch('all'), scope: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(2000).default(200), q: z.string().default('') })
const MemoriesQuery = z.object({ q: z.string().default(''), project: z.string().default(''), sort: z.enum(MEMORY_SORTS).catch('newest'),
  offset: count.default(0), limit: limit(20, 200) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor', 'memory', 'language', 'workspace']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
const RestoreRequest = z.object({ revision: z.number().int().nonnegative(), reason: z.string().trim().max(280).optional() })
const IncidentsQuery = z.object({
  status: z.enum(INCIDENT_STATUS_FILTERS).catch('open'),
  severity: z.enum(INCIDENT_SEVERITY_FILTERS).optional().catch(undefined),
  project: z.string().trim().max(120).default(''), ticket: z.string().trim().max(120).default(''),
  request: z.string().trim().max(120).default(''), session: z.string().trim().max(120).default(''),
  offset, limit: limit(20, 100),
})

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  /**
   * Record one human-triggered domain action for the operator audit trail. Only the action name and identifiers are
   * logged: setting values, replies, reasons, instructions and any other payload text stay out of the log by design.
   */
  const audit = (action: string, fields: Record<string, string | number | boolean> = {}): void => {
    const facts = Object.entries(fields).map(([name, value]) => `${name}=${value}`).join(' ')
    runtime.logs.record('info', 'audit', `${action}${facts ? ` ${facts}` : ''} actor=operator`, { actor: 'operator', action, ...fields })
  }
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem, runtime.leadOverview(),
      runtime.deliveryFailures(), runtime.selfReports.drafts()),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'GET settings/proposals': () => runtime.settings.proposals(),
    'POST settings/proposals/:id/apply': async ({ params }) => {
      const result = await runtime.settings.applyProposal(params.id)
      if (result === undefined) throw new RouteError(404, 'Settings proposal not found')
      return result
    },
    'POST settings/proposals/:id/reject': ({ params }) => {
      const proposal = runtime.settings.rejectProposal(params.id)
      if (proposal === undefined) throw new RouteError(404, 'Settings proposal not found')
      return { proposal }
    },
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'GET workers': () => workersPage(runtime),
    'POST tickets/:id/retry': ({ params }) => {
      const id = ticket(params.id)
      runtime.engine.retryTicket(id)
      audit('ticket.retry', { ticket: id })
      return { retried: true }
    },
    'POST tickets/:id/stop': ({ params }) => {
      const id = ticket(params.id)
      runtime.engine.stopTicket(id)
      audit('ticket.stop', { ticket: id })
      return { stopped: true }
    },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      const saved = await runtime.settings.save(block, request.value, request.revision, 'panel')
      audit('settings.save', { block, revision: saved.revision })
      return saved
    },
    // Restore one block from a saved revision through the ordinary panel save path (docs/011 A5.3); the history records the values.
    'POST settings/:block/restore': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = RestoreRequest.parse(await body())
      const saved = await runtime.settings.restore(block, request.revision, request.reason ? { reason: request.reason } : {})
      audit('settings.restore', { block, revision: saved.revision, restoredFrom: saved.restoredFrom })
      return { revision: saved.revision, restarting: saved.restarting, restoredFrom: saved.restoredFrom }
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    // The wizard is answered once: `firstRun` stays false afterwards even while no project exists, because the operator
    // may have skipped it deliberately and can reopen it from the panel header.
    'PUT wizard': async ({ body }) => {
      const { skipped } = z.object({ skipped: z.boolean() }).parse(await body())
      // A workspace is mandatory: skipping or finishing the wizard before one is selected must fail closed, so a reload
      // cannot present the first-run state as answered while the host is paused without a workspace.
      if (store.settings().workspace.path === '') throw new WorkspaceSetupError('workspaceRequired')
      store.set(WizardRecord, { at: new Date().toISOString(), skipped })
      return wizardView(runtime)
    },
    // Acknowledge before stopping: the acknowledgement must be written to the socket before the process ends, which is how
    // `scripts/dsh-superagent-further stop` ends a detached service on Windows where no graceful signal can be delivered.
    'POST shutdown': () => { setTimeout(() => { runtime.requestShutdown() }, 0); return { stopping: true } },
    'GET models': () => runtime.models(),
    'GET memories': ({ query }) => { const { q, project, sort, offset, limit } = MemoriesQuery.parse(query);
      return memoriesView(store, { query: q, project, sort, offset, limit }) },
    'POST escalations/:id/decide': async ({ params, body }) => {
      const input = z.object({
        decision: z.enum(['accept', 'reject', 'needs-info']),
        reply: z.string().trim().min(1).max(8000),
        units: z.array(z.object({ project: z.string().trim().min(1).max(40), title: z.string().trim().min(1).max(200).optional(),
          after: z.array(z.number().int().min(0)).max(7).optional() })).min(1).max(8).optional(),
        deliverable: z.enum(['change', 'answer']).optional(),
      }).strict().refine(value => value.decision !== 'accept' || (value.units?.length ?? 0) > 0, 'accept needs at least one delivery unit')
        .parse(await body())
      const projects = runtime.store.settings().executor.projects
      for (const [index, unit] of (input.units ?? []).entries()) {
        if (!projects.some(item => item.id === unit.project)) throw new RouteError(400, `Deliverable ${index}: project ${unit.project} is not registered`)
      }
      const result = await runtime.decideEscalation({ ...input, id: params.id })
      audit('escalation.decide', { request: params.id, decision: input.decision, units: input.units?.length ?? 0 })
      return result
    },
    // The self-evolution outlet's two review actions (docs/014 D5): only a draft is approvable or dismissable, and filing
    // reuses the outlet's own deduplication, daily cap and label rules rather than a second HTTP path for them.
    'POST self-reports/:id/approve': async ({ params }) => {
      const result = await runtime.selfReports.approve(params.id)
      if (result.status !== 'filed' && result.status !== 'linked') throw new RouteError(409, 'Self report could not be filed')
      audit('self-report.approve', { report: result.report.id, issue: result.issue_number, status: result.status })
      return { status: result.status, report_id: result.report.id, issue_number: result.issue_number }
    },
    'POST self-reports/:id/dismiss': ({ params }) => {
      const report = runtime.selfReports.dismiss(params.id)
      audit('self-report.dismiss', { report: report.id })
      return { status: 'dismissed', id: report.id }
    },
    'POST memory/forget': async ({ body }) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(await body())
      return { forgotten: store.memories.forget(id) }
    },
    'POST memory/pin': async ({ body }) => {
      const { id, pinned } = z.object({ id: z.string().min(1), pinned: z.boolean() }).parse(await body())
      const row = store.memories.setPinned(id, pinned)
      if (row === undefined) throw new RouteError(404, 'Memory not found')
      return { pinned: row.pinned }
    },
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
    // Automations share the service the main Session's tools use; the panel is another client of the same code path. A missing
    // Host schedule service is a 503 instead of a broken page, and no route can re-target scope or project.
    'GET logs': ({ query }): LogsView => {
      const { level, scope, limit, q } = LogsQuery.parse(query)
      return { entries: runtime.logs.list({ level: level as LogFilter, scope, limit, q }), level: level as LogFilter, scope, q }
    },
    // Deterministic incidents (docs/015). Detection itself is not exposed here: M34 adds the diagnose/dismiss actions.
    'GET incidents': ({ query }) => {
      const parsed = IncidentsQuery.parse(query)
      const scope: { project?: string; ticket?: string; request?: string; session?: string } = {}
      for (const name of ['project', 'ticket', 'request', 'session'] as const) {
        const value = parsed[name]
        if (value !== '') scope[name] = value
      }
      const filter: IncidentFilter = { status: parsed.status, offset: parsed.offset, limit: parsed.limit,
        ...(parsed.severity === undefined ? {} : { severity: parsed.severity }),
        ...(Object.keys(scope).length === 0 ? {} : { scope }) }
      return { incidents: runtime.incidents.list(filter), total: runtime.incidents.total(filter), status: parsed.status,
        ...(parsed.severity === undefined ? {} : { severity: parsed.severity }), offset: parsed.offset, limit: parsed.limit }
    },
    'GET incidents/:id': ({ params }) => {
      const view = runtime.incidents.detail(params.id)
      if (view === undefined) throw new RouteError(404, 'Incident not found')
      return view
    },
    'GET automations': () => automationsPage(runtime),
    'POST automations': async ({ body }) => {
      if (runtime.automations === undefined) throw new RouteError(503, 'The Host schedule service is not installed')
      const created = await runtime.automations.create(AutomationCreateSchema.parse(await body()), 'panel')
      audit('automation.create', { automation: created.id })
      return created
    },
    'PUT automations/:id': async ({ params, body }) => {
      if (runtime.automations === undefined) throw new RouteError(503, 'The Host schedule service is not installed')
      const update = AutomationUpdateSchema.parse(await body())
      const result = await runtime.automations.edit({ id: params.id, action: 'update', ...update }, 'panel')
      if ('conflict' in result) throw new RouteError(409, result.warning)
      audit('automation.edit', { automation: result.id })
      return result
    },
    // A manual run never re-targets or edits a task; the Host either admits one delivery or refuses it.
    'POST automations/:id/run': async ({ params }) => {
      if (runtime.automations === undefined) throw new RouteError(503, 'The Host schedule service is not installed')
      const automation = await runtime.automations.run(params.id, 'panel')
      audit('automation.run', { automation: automation.id })
      return { ran: true, automation }
    },
    'DELETE automations/:id': async ({ params }) => {
      if (runtime.automations === undefined) throw new RouteError(503, 'The Host schedule service is not installed')
      const result = await runtime.automations.remove(params.id, 'panel')
      audit('automation.delete', { automation: result.id })
      return result
    },
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
