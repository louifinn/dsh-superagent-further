/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { ProposalsView } from './settings.ts'
import type { Proposal } from './store.ts'
import type { HistoryView } from './settings-history.ts'
import type { MemorySort } from '../memory.ts'
import type { AutomationCreateInput, AutomationSummary, AutomationUpdate } from './automations.ts'
import type { AutomationsView } from './views/automations.ts'
import type { EscalationDecisionResult } from './escalations.ts'
import type { LogFilter, LogsView } from './logs.ts'
import type { MemoriesView } from './views/memories.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  /** Restore one block from a saved revision as a new revision, recording `restoredFrom` on the history row. */
  'POST settings/:block/restore': { body: { revision: number; reason?: string }; response: { revision: number; restarting: boolean; restoredFrom: number } }
  /** Pending tier-B settings proposals, with the per-field diff the panel shows (docs/011 A5.2). */
  'GET settings/proposals': { response: ProposalsView }
  /** Approve a proposal through the ordinary panel save path, recording its actor and reason on the new revision. */
  'POST settings/proposals/:id/apply': { response: { revision: number; restarting: boolean; proposal: Proposal } }
  /** Reject a pending proposal without changing settings. */
  'POST settings/proposals/:id/reject': { response: { proposal: Proposal } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  /** Record that the setup wizard was finished or skipped; `firstRun` reports whether it should open by itself. */
  'PUT wizard': { body: { skipped: boolean }; response: { firstRun: boolean; skipped: boolean } }
  /** Stop gracefully and end the host process; `scripts/dsh-superagent-further stop` uses it where a signal cannot be delivered. */
  'POST shutdown': { response: { stopping: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
  /** The Memory page: stored memories with their totals and the config the page edits. */
  'GET memories': { query?: { q?: string; project?: string; sort?: MemorySort; offset?: number; limit?: number }; response: MemoriesView }
  'POST memory/forget': { body: { id: string }; response: { forgotten: boolean } }
  'POST memory/pin': { body: { id: string; pinned: boolean }; response: { pinned: boolean } }
  /** The Automations page: tasks at installation or project scope, and the projects a new task can target. */
  'GET logs': { query?: { level?: LogFilter; scope?: string; limit?: number }; response: LogsView }
  'GET automations': { response: AutomationsView }
  'POST automations': { body: AutomationCreateInput; response: AutomationSummary }
  'PUT automations/:id': { body: AutomationUpdate; response: AutomationSummary }
  'POST automations/:id/run': { response: { ran: true; automation: AutomationSummary } }
  'DELETE automations/:id': { response: { id: string; deleted: true } }
  /** Decide one escalated project request from the Overview; its mandatory reply reaches the Lead. */
  'POST escalations/:id/decide': { body: { decision: 'accept' | 'reject' | 'needs-info'; reply: string
    ; units?: { project: string; title?: string; after?: number[] }[]; deliverable?: 'change' | 'answer' }; response: EscalationDecisionResult }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
