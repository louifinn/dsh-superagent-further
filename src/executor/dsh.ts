/** DSH executor: manages one persistent worker session and workspace directory per ticket. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canComplete, key, latestAssignment, latestReport, liveTicket, requiresPullRequest, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, ExecutorStopCause, JobSnapshot, Mandate, PolicyEffect, Ticket,
  TicketInput, Trigger } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { projectByRepository, projectOf, type Project } from '../projects.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import { REVIEWER_PRESET, WORKER_PRESET, type Sessions } from '../app/sessions.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { CaptureLogs } from '../app/logs.ts'
import type { HealthEntry } from '../infra/health.ts'
import { cancelled, collectJob, jobOutputPreview, killJobs, onJobSettled, runningJobs, stopBackground, stopSubagents, until, untilQuiet }
  from './background.ts'
import type { JobEvent, JobView } from './background.ts'
import { executorActivation, LeadActivations, type Activation, type SubagentService } from './lead-dispatch.ts'

const now = (): string => new Date().toISOString()
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** How long a worker's background work may run on after its turn ended before it is stopped and the worker reported waiting. */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** How long a host stop waits for the workers' background work to stop. */
const SHUTDOWN_STOP_MS = 10_000
/** How long a worker whose own report ended its Ticket may take to finish the turn that report belongs to. */
const RETIRE_GRACE_MS = 60_000
/** How long a worker that goes on after a passing failure waits for a worker slot, or for processing to resume, between looks. */
const SLOT_WAIT_MS = 5000
/** How many settled job snapshots one Ticket keeps, in memory and on its latest Assignment. */
const JOB_SNAPSHOTS = 8
/** How many tail bytes of a settled job's retained output a snapshot preview keeps. */
const JOB_PREVIEW_BYTES = 2_048
/** How many Tickets keep settled-job snapshots in memory, oldest dropped first. */
const JOB_TICKETS = 256
/** How many job ids a Ticket remembers as woken, so a repeated settle event does not wake its worker twice. */
const JOB_WAKES = 64
/** The part of DSH's job registry the panel reads: the jobs one Session owns, observed without waiting on or consuming them. */
interface JobList {
  list(caller: string): readonly JobView[]
}
/** One shell job in the panel: a settled snapshot, or a job the worker still holds. */
export interface WorkerJobRow {
  id: string
  kind: string
  label: string
  status: string
  /** The tail of the job's retained output, read without taking the worker's cursor. */
  preview: string
  /** The job's retained output size in bytes so far. */
  total: number
  /** When the job started, ISO 8601; carried by a live row. */
  startedAt?: string
  /** When the job settled, ISO 8601; carried by a settled row. */
  endedAt?: string
  /** What the job last reported about its progress; carried by a live row when DSH has it. */
  detail?: string
}
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * Internal error thrown when a ticket's workspace prepare command fails during launch.
 * DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
 */
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
 * connection that was refused, reset, timed out, or could not resolve its host.
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Host dependencies used by `DshExecutor`. */
export interface ExecutorHost {
  /** DSH Cordis context: agents and their events, and the subprocess service used to run prepare commands. */
  readonly context: Context
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted' | 'beginReview'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit' | 'leads' | 'requests'>
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  readonly sessions: Pick<Sessions, 'ensure' | 'ensureLead' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  closing(): boolean
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined
  /** Operational log scoped to the executor; entries carry ids and outcomes, never content. */
  readonly log: CaptureLogs
}
/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  // An answer ticket reads its project's live checkout and owns no branch or worktree; a change ticket gets its own worktree.
  const project = projectOf(settings.executor.projects, ticket.project)
  const answer = canComplete(ticket.deliverable)
  const name = answer ? '' : ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  // A ticket of a registered project keeps its worktree inside that project's namespace, so two projects can both use `add-login`.
  const directory = answer ? project?.workspace ?? '' : join(executionRoot(settings, stateDir), ...ticket.project ? [ticket.project] : [], name)
  return { name, directory, assignment }
}
/**
 * The git command that creates a ticket's worktree in its project's local clone. Used when the operator configured no
 * prepare command: a new branch `agent/<name>` at the project's base branch, checked out in the ticket's directory.
 */
export const worktreePrepare = (ticket: Ticket, project: Project): string[] =>
  ['git', '-C', project.workspace, 'worktree', 'add', '-b', `agent/${ticket.execution?.name ?? ''}`,
    ticket.execution?.directory ?? '', project.branch || 'HEAD']
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
export class WorkerSlots {
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - Returns the tickets whose worker holds a slot (see `DshExecutor.running`) with their project, if any.
   * @param max - Returns the configured maximum number of concurrent worker slots.
   * @param projectMax - Returns how many executors one project may run at once.
   */
  constructor(private readonly running: () => { ticketId: string; project?: string }[],
    private readonly max: () => number, private readonly projectMax: () => number) {}
  /** Number of slots currently in use across running workers and starting reservations. */
  used(): number { return new Set([...this.running().map(item => item.ticketId), ...this.starting.keys()]).size }
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running().map(item => item.ticketId), ...wakes]).size
  }
  /** How many slots one project uses, across running workers and starting reservations. */
  private projectUsed(project: string): number {
    const ids = new Set(this.running().flatMap(item => item.project === project ? [item.ticketId] : []))
    for (const [ticketId, by] of this.starting) if (by !== 'person' && this.projectOf(ticketId) === project) ids.add(ticketId)
    return ids.size
  }
  /** The project a starting reservation was made for; reservations record it when taken. */
  private readonly reserved = new Map<string, string | undefined>()
  private projectOf(ticketId: string): string | undefined { return this.reserved.get(ticketId) }
  /**
   * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond the limits, so a person's follow-up
   * never waits behind new launches or a busy project.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free, globally or in the ticket's project.
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person', project?: string): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    if (project !== undefined && by !== 'person' && this.projectUsed(project) >= this.projectMax()) {
      throw new Later('No worker slot is free for this project')
    }
    this.starting.set(ticketId, by)
    this.reserved.set(ticketId, project)
  }
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  free(ticketId: string): void { this.starting.delete(ticketId); this.reserved.delete(ticketId) }
}

/**
 * Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
 * `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
  private readonly resuming = new Set<string>()
  /** Assignments whose launch is queued or running, so a message arriving meanwhile cannot start a second one. */
  private readonly launching = new Set<string>()
  /**
   * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  private readonly settling = new Map<string, AbortController>()
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** When a person's message typed into a worker's Session last started a turn, by ticket. */
  private readonly personal = new Map<string, string>()
  /** The subscriptions to the ends of each Ticket's worker jobs, by ticket, which dispose clears. */
  private readonly watching = new Map<string, () => void>()
  /** The settlements whose wake is running, by ticket and job id, so a repeated event sends one wake. */
  private readonly waking = new Set<string>()
  /** The job ids a Ticket's worker was already woken for, by ticket. */
  private readonly woke = new Map<string, Set<string>>()
  /** The newest settled-job snapshots by ticket, for the panel and for M22 while the Assignment keeps them too. */
  private readonly settled = new Map<string, readonly JobSnapshot[]>()
  /** The timers of workers that go on after a passing failure, which dispose clears. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Per-Ticket start of the worker turn in flight, so `turn/end` can report its duration. */
  private readonly turns = new Map<string, { turn: number; startedAt: number }>()
  /** Executor activations of Lead-hosted workers, by child Session id. */
  private readonly leads: LeadActivations
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(
      () => host.store.tickets.open().filter(ticket => this.running(ticket))
        .map(ticket => ({ ticketId: ticket.id, ...ticket.project === undefined ? {} : { project: ticket.project } })),
      () => host.store.settings().executor.maxWorkers,
      () => host.store.settings().executor.projectWorkers)
    // A Cordis service is read through get: a plain property access throws unless the plugin injects it.
    this.leads = new LeadActivations(() => host.context.get('subagents') as SubagentService | undefined)
    // Each launch reserves a worker slot so launches run concurrently while slots are free.
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const settings = this.host.store.settings()
    // The origin Trigger carries the repository the request came from; a registered project with that repository owns the worktree.
    const origin = sourceTrigger(this.host, ticket)
    const repository = typeof origin?.meta.repository === 'string' ? origin.meta.repository : undefined
    // An accept may split its work across Tickets, and the Engine sets the project on each of them; a single delivery gets one here.
    const requested = ticket.project ?? outcome.project
    const named = projectOf(settings.executor.projects, requested)
    if (requested && !named) throw new Error(`Unknown project ${requested}; register it in Execution first`)
    const fromRepository = projectByRepository(settings.executor.projects, repository)
    // A Feishu message names no repository, so the assessment may choose a project; a GitHub Trigger's own repository decides,
    // except that an accept split into several deliveries may place each one in its own project.
    const split = ticket.requestId !== undefined && (this.host.store.requests.get(ticket.requestId)?.ticketIds.length ?? 1) > 1
    if (named && fromRepository && named.id !== fromRepository.id && !split) {
      throw new Error(`The chosen project ${named.id} is not the project of the Trigger's repository ${repository}`)
    }
    const project = named ?? fromRepository
    if (!project) throw new Error('This Ticket names no registered project; a request must be accepted with a project (Execution → Projects)')
    const placed: Ticket = { ...ticket, project: project.id }
    return { ...placed, execution: ticketExecution(placed, outcome, settings, this.host.machine.stateDir) }
  }
  /**
   * The command that runs an operator's prepare command: PowerShell on Windows, which the configuration mounts as the worker's
   * shell tool, and the POSIX shell elsewhere.
   */
  private prepareCommand(command: string): string[] {
    return process.platform === 'win32' ? ['pwsh', '-NoProfile', '-NonInteractive', '-Command', command] : ['sh', '-c', command]
  }
  /**
   * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
   * execution environment variables, then verifies the directory as the worker sees it.
   * A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
   * @throws PrepareFailed with the command's output when the prepare command fails.
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    if (canComplete(ticket.deliverable)) throw new Error('An answer ticket reads its project\'s live checkout; it has no worktree to prepare')
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const settings = this.host.store.settings()
    const command = settings.executor.prepare.trim()
    const project = projectOf(settings.executor.projects, ticket.project)
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    const argv = command ? this.prepareCommand(command) : project ? worktreePrepare(ticket, project) : undefined
    if (argv) await runAsWorker(this.host.context.subprocess, argv, dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
        await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
        throw new PrepareFailed(`${command ? 'The prepare command' : `Creating the worktree in ${project?.workspace ?? ''}`} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void {
    // An Input can arrive while the launch runs; a second launch would collide with the child the first creates.
    // `assignmentStarted` delivers the waiting Inputs to the child once the first launch is done.
    if (this.launching.has(assignment.id)) return
    this.launching.add(assignment.id)
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch', ticket.project)
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // Shutdown or pause re-queues the launch for resume, and transient network/provider errors retry with backoff.
      // A failed prepare command is not retried automatically because an existing directory counts as prepared, so retrying
      // would treat whatever a failed prepare command left behind in the directory as a prepared workspace; instead the
      // ticket is marked failed and waits until new human input or an explicit retry arrives.
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.launching.delete(assignmentId); this.slots.free(ticketId) }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    // A stop of the worker's background work ends with a cancel, which would drop what is delivered meanwhile.
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake', ticket.project)
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      // A stop of the worker's background work that started meanwhile ends with a cancel, which would drop the Input.
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    // A Lead-hosted child's Session is subagent-owned and refuses a root prompt, so the Lead steers the message instead;
    // after a restart the activation map is empty, but the durable child still takes a message from its Lead.
    const leadProject = this.leadProject(ticket)
    if (!leadProject) throw new Error('This Ticket names no registered project; a request must be accepted with a project (Execution → Projects)')
    const lead = await this.host.sessions.ensureLead(leadProject.id, leadProject.workspace, `Lead · ${leadProject.name}`)
    await this.leads.send(lead, workerSessionId(ticket.id), text, this.host.lifetime)
  }
  /** The project whose Lead hosts this Ticket's executor; a Ticket without a project runs as a root Session. */
  private leadProject(ticket: Ticket): Project | undefined {
    const settings = this.host.store.settings()
    if (ticket.project === undefined) return undefined
    return projectOf(settings.executor.projects, ticket.project)
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work and stops its shell jobs and subagents, including jobs it left to
   * a person. A Ticket ended by its worker's own report retires that worker only after its in-flight turn ends; every other
   * cause preempts the turn at once, because the work is no longer wanted.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string, cause: ExecutorStopCause): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.watching.get(ticket.id)?.(); this.watching.delete(ticket.id); this.woke.delete(ticket.id)
      this.settling.get(ticket.id)?.abort()
      if (cause === 'report') this.track(ticket.id, this.retire(ticket.id, this.leads.take(sessionId), reason))
      else {
        this.host.log.info('assignment.preempted ticket=%s assignment=%s cause=%s cancelled=true', ticket.id, assignment.id, String(cause))
        this.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
        this.stopWork(ticket.id, reason)
      }
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /**
   * Retire a worker whose own report ended its Ticket: the report's transaction commits while its tool call still runs, so the
   * executor waits, bounded by `RETIRE_GRACE_MS`, for that turn to end before disposing the activation and stopping its
   * background work. Only a turn that outlives the grace is cancelled, and then its report call, already recorded, is the
   * only thing left to abort. The fake and the real subagent runtime both treat disposing a live activation as cancelling a
   * running turn, so the dispose must come after the wait.
   */
  private async retire(ticketId: string, activation: Activation | undefined, reason: string): Promise<void> {
    const sessionId = workerSessionId(ticketId)
    const agent = this.host.context.agents.get(sessionId as SessionId)
    let cancelled = false
    if (agent && agent.status !== 'idle') {
      this.host.log.info('assignment.retiring ticket=%s graceMs=%d', ticketId, RETIRE_GRACE_MS)
      const idle = await until(agent.whenIdle(), this.host.lifetime, RETIRE_GRACE_MS)
      if (idle === false) { agent.cancel({ kind: 'user' }, { keepInbox: false }); cancelled = true }
    }
    if (activation) await activation.dispose().catch(() => {})
    await stopBackground(this.host.context, sessionId, reason).catch(() => {})
    this.host.log.info('assignment.retired ticket=%s cancelled=%s', ticketId, String(cancelled))
  }
  /** Stop what a ticket's worker runs in the background (see `stopBackground`). */
  private stopWork(ticketId: string, reason: string, keepInbox = false): void {
    // A Lead-hosted executor is stopped by disposing its activation, which ends the child and its descendants.
    const activation = this.leads.take(workerSessionId(ticketId))
    if (activation) this.track(ticketId, activation.dispose().catch(() => {}))
    this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox))
  }
  /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /**
   * On a host stop, for a bounded time: dispose every Lead activation, including a graceful retirement that has already taken
   * one; cancel a worker turn that still runs, keeping its inbox, which also releases a retirement waiting on that turn; then
   * stop each loaded worker's background work, keeping its inbox, and end the collecting of the jobs left to a person, which
   * were killed.
   */
  async shutdown(): Promise<void> {
    const agents = this.host.store.tickets.list().map(ticket => this.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
      .filter((agent): agent is Agent => agent !== undefined)
    const stop = async () => {
      for (const dispose of this.watching.values()) dispose()
      this.watching.clear()
      await this.leads.disposeAll()
      const running = agents.filter(agent => agent.status !== 'idle')
      for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
      // A retirement a report started may still wait on a turn; the cancellation above ends it, and this waits for its dispose.
      await Promise.allSettled([...this.stopping.values()])
      await Promise.allSettled(running.map(agent => agent.whenIdle()))
      await Promise.allSettled(agents.map(agent => stopBackground(this.host.context, agent.id, 'dsh-superagent-further stopped', true)))
      for (const { collect } of this.left.values()) collect.abort()
    }
    await until(stop(), undefined, SHUTDOWN_STOP_MS)
  }
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /**
   * Watch the shell jobs of a Ticket's worker Session. A job that settles while its Assignment still runs wakes the worker
   * through its Lead, so a job that ends at the same moment its turn does still reaches the worker's next turn.
   */
  private watchJobs(ticketId: string): void {
    if (this.watching.has(ticketId)) return
    const dispose = onJobSettled(this.host.context, workerSessionId(ticketId), (job, event) => {
      void this.background(this.jobSettled(ticketId, job, event))
    })
    if (dispose) this.watching.set(ticketId, dispose)
  }
  /**
   * Record a job that ended while its worker owned the Assignment, for the panel and a later review, and wake the worker
   * when the job ended uncollected and the Assignment still runs. A wait, a kill the Executor collected, or a teardown
   * already tells the worker, or must tell it nothing.
   */
  private async jobSettled(ticketId: string, job: JobView, event: JobEvent): Promise<void> {
    if (this.host.closing()) return
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) return
    const known = this.settled.get(ticketId) ?? []
    if (known.some(item => item.id === job.id)) return
    const snapshot: JobSnapshot = { id: job.id, kind: job.kind, label: job.label, status: job.status,
      preview: jobOutputPreview(this.host.context, job.id, workerSessionId(ticketId), JOB_PREVIEW_BYTES),
      total: job.output?.total ?? 0, endedAt: new Date(job.finishedAt ?? Date.now()).toISOString() }
    const jobs = [...known, snapshot].slice(-JOB_SNAPSHOTS)
    this.rememberJobs(ticketId, jobs)
    this.recordJobs(ticketId, assignment.id, jobs)
    // Operational metadata only: a job's output and arguments are never logged.
    this.host.log.debug('job.settled ticket=%s job=%s status=%s cause=%s', ticketId, job.id, job.status, event.cause ?? 'none')
    // A wait collected the end, or a teardown killed the job: the worker already hears of it, or must not.
    if (event.awaited || event.cause === 'teardown') return
    // Only a job that ends while its Assignment still runs wakes the worker; a late end is history the panel keeps.
    const live = this.host.store.tickets.get(ticketId)
    const current = live && liveTicket(live) ? runningAssignment(live) : undefined
    if (!live || !current || current.id !== assignment.id) return
    // An idle Session is woken by DSH's own completion notice. A Session that still runs would get that notice injected,
    // and the turn may end before its next step takes it, so only this case needs the Lead-routed wake.
    const worker = this.host.context.agents.get(workerSessionId(ticketId) as SessionId)
    if (worker?.status === 'idle') return
    await this.wakeForJob(live, current, job)
  }
  /** Keep the newest settled-job snapshots of one Ticket, bounding how many Tickets stay in memory. */
  private rememberJobs(ticketId: string, jobs: readonly JobSnapshot[]): void {
    this.settled.delete(ticketId)
    this.settled.set(ticketId, jobs)
    while (this.settled.size > JOB_TICKETS) {
      const oldest = this.settled.keys().next().value
      if (oldest === undefined || oldest === ticketId) break
      this.settled.delete(oldest)
    }
  }
  /** Record settled jobs on their Assignment, so a restart and a later view keep what the worker was told. */
  private recordJobs(ticketId: string, assignmentId: string, jobs: readonly JobSnapshot[]): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) return
    const assignments = ticket.assignments.map(item => item.id === assignmentId ? { ...item, jobs } : item)
    this.host.store.tickets.save({ ...ticket, assignments, updatedAt: now() })
  }
  /**
   * Wake a worker whose job ended after the turn did, through the Lead that hosts its Session: a Lead-hosted child refuses
   * a root prompt, and a queued wake is what reaches its next turn. One wake per job, also when a settle event repeats.
   */
  private async wakeForJob(ticket: Ticket, assignment: Assignment, job: JobView): Promise<void> {
    const wake = `${ticket.id}:${job.id}`
    const sent = this.woke.get(ticket.id) ?? new Set<string>()
    if (sent.has(job.id) || this.waking.has(wake)) return
    this.waking.add(wake)
    try {
      const go = async (): Promise<void> => {
        if (this.host.closing()) return
        const stored = this.host.store.tickets.get(ticket.id)
        const current = stored && liveTicket(stored) ? runningAssignment(stored) : undefined
        if (!stored || !current || current.id !== assignment.id) return
        if (this.host.paused()) { this.after(SLOT_WAIT_MS, () => { void this.background(go()) }); return }
        const waking = !this.running(stored)
        if (waking) {
          try { this.slots.reserve(ticket.id, 'wake', stored.project) } catch (failure) {
            if (!(failure instanceof Later)) throw failure
            this.after(SLOT_WAIT_MS, () => { void this.background(go()) })
            return
          }
        }
        try {
          const leadProject = this.leadProject(stored)
          if (!leadProject) throw new Error(`Ticket ${ticket.id} names no registered project to wake its worker through`)
          const lead = await this.host.sessions.ensureLead(leadProject.id, leadProject.workspace, `Lead · ${leadProject.name}`)
          const label = job.label.split('\n')[0]?.trim() || job.label
          const text = `Background job ${job.id} (${job.kind}: ${label}) settled as ${job.status}. `
            + `Read its output with job_output for job ${job.id}, then continue the assignment; report again if the result changes its state.`
          await this.leads.send(lead, workerSessionId(ticket.id), text, this.host.lifetime)
          sent.add(job.id)
          while (sent.size > JOB_WAKES) {
            const oldest = sent.values().next().value
            if (oldest === undefined) break
            sent.delete(oldest)
          }
          this.woke.set(ticket.id, sent)
        } finally {
          if (waking) this.slots.free(ticket.id)
        }
      }
      await go()
    } finally {
      this.waking.delete(wake)
    }
  }
  /**
   * The shell jobs a running worker still holds, read from DSH's registry by listing and reading them: no wait, no kill, and
   * `jobOutputPreview`'s non-consuming `readAt`, so the worker's own cursor and end notice stay untouched.
   */
  private liveJobs(ticketId: string): readonly WorkerJobRow[] {
    const caller = workerSessionId(ticketId)
    const registry = this.host.context.get('jobs') as JobList | undefined
    if (!registry) return []
    try {
      return registry.list(caller)
        .filter(job => job.owner === caller && (job.status === 'running' || job.status === 'stopping'))
        .map(job => ({ id: job.id, kind: job.kind, label: job.label, status: job.status,
          preview: jobOutputPreview(this.host.context, job.id, caller, JOB_PREVIEW_BYTES), total: job.output?.total ?? 0,
          startedAt: new Date(job.startedAt).toISOString(), ...(job.detail ? { detail: job.detail } : {}) }))
    } catch { return [] }
  }
  /**
   * The shell jobs of each Ticket, newest last, for the panel and for M22's review of a late result: what settled in this
   * process or was recorded on the latest Assignment, followed by what a worker that still holds a slot is running now.
   */
  jobsSnapshot(): ReadonlyMap<string, readonly WorkerJobRow[]> {
    const snapshots = new Map<string, readonly WorkerJobRow[]>()
    for (const ticket of this.host.store.tickets.list()) {
      const rows = new Map<string, WorkerJobRow>()
      for (const job of this.settled.get(ticket.id) ?? latestAssignment(ticket)?.jobs ?? []) rows.set(job.id, job)
      if (!ticket.ended && this.running(ticket)) for (const job of this.liveJobs(ticket.id)) rows.set(job.id, job)
      if (rows.size) snapshots.set(ticket.id, [...rows.values()])
    }
    return snapshots
  }
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  private failed(ticketId: string, summary: string): void {
    const ended = this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
      return updated
    })
    this.host.log.info('report.recorded ticket=%s state=failed outcome=%s', ticketId, ended.ended?.outcome ?? 'none')
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  /** Start an independent reviewer subagent for a live change Ticket, recorded on the Ticket while its verdict waits. */
  async review(ticketId: string): Promise<{ session_id: string }> {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) throw new Error(`Unknown Ticket ${ticketId}`)
    if (!liveTicket(ticket)) throw new Error(`Ticket ${ticketId} has ended; start a review on a live Ticket`)
    if (!requiresPullRequest(ticket.deliverable)) throw new Error('Only a change Ticket carries a review')
    const project = ticket.project === undefined ? undefined : projectOf(this.host.store.settings().executor.projects, ticket.project)
    if (!project) throw new Error('This Ticket names no registered project; a review needs a project checkout')
    const lead = await this.host.sessions.ensureLead(project.id, project.workspace, `Lead · ${project.name}`)
    const childId = `review-${ticket.id}`
    const report = latestReport(ticket)
    const text = JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(report?.pullRequest ? { pull_request: report.pullRequest } : {}),
      ...(report?.summary ? { report: report.summary } : {}), ...(report?.checks?.length ? { checks: report.checks } : {}),
      instruction: 'Review this change independently in the project worktree: read the diff and the relevant code, run the checks that matter, '
        + 'and answer with a concise verdict. The Lead records it with lead_review_record; do not edit files, commit or merge.' })
    await this.leads.start(executorActivation({ childId, title: `Review · ${ticket.title}`, cwd: ticket.execution?.directory ?? project.workspace,
      text, lead, signal: this.host.lifetime, preset: REVIEWER_PRESET,
      // DSH's parent settlement notice carries the reviewer's closing verdict to the Lead model, which records it: the
      // reviewer preset has no app tool of its own, and nothing else routes the activation result to the Lead.
      delivery: 'parent' }))
    this.host.engine.beginReview(ticket.id, childId)
    return { session_id: childId }
  }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent-further is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // An answer ticket reads the project's live checkout: no branch, worktree, prepare command or cleanup; a change ticket
    // prepares its own worktree once, and an existing directory counts as already prepared (including worktrees created
    // before `prepare` commands existed).
    if (canComplete(ticket.deliverable)) {
      if (!await stat(workspace).then(() => true, () => false)) {
        throw new Error(`The workspace ${workspace || '(unset)'} of this answer ticket is missing; it must be the project's live checkout`)
      }
    } else if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    // Watch its jobs from before it starts: a job that ends as the first turn ends must still reach the next turn.
    this.watchJobs(ticket.id)
    const settings = this.host.store.settings()
    const project = ticket.project === undefined ? undefined : projectOf(settings.executor.projects, ticket.project)
    // A Lead-hosted executor starts as a subagent of its project's Lead Session; there is no root worker path.
    if (!project) throw new Error('This Ticket names no registered project; a request must be accepted with a project (Execution → Projects)')
    if (!current()) return
    // The background work of the Assignment this one replaces stops first, so its end does not clear this one's message.
    await this.stopped(ticket.id)
    if (!current()) return
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    {
      const lead = await this.host.sessions.ensureLead(project.id, project.workspace, `Lead · ${project.name}`)
      if (!current()) return
      // The activation carries the same first message a root worker Session would receive, under the reserved worker id, so
      // the rest of the Executor (prompt, tools, panel links) finds the child by the same id.
      const activation = await this.leads.start(executorActivation({ childId: sessionId, title: ticket.title, cwd: workspace,
        text, lead, signal: this.host.lifetime, preset: WORKER_PRESET }))
      if (!current()) { void activation.dispose().catch(() => {}); return }
      // The dispatch is recorded against the Lead and marked delivered once its child runs, so the panel's waiting count and
      // the Lead's message history describe the same dispatch.
      const dispatch = this.host.store.leads.send({ project: project.id, kind: 'assignment', from: 'orchestrator',
        to: 'lead', requestId: assignment.id, ticketId: ticket.id, body: text })
      this.host.store.leads.deliver(dispatch.id)
      this.host.engine.assignmentStarted(ticket.id, assignment.id)
      this.host.log.info('assignment.launched ticket=%s assignment=%s session=%s', ticket.id, assignment.id, sessionId)
      return
    }
  }
  /** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // A turn that starts ends the look at its worker's background work; the turn's own idle looks afresh.
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // The turn a stop of the worker's subagents woke and cancelled is no turn of the worker's.
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
    }))
    // A person's message typed into a worker's Session, which the ticket does not record.
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // The Inputs a message of dsh-superagent-further's carries, which its worker reads once the Session took the message into its
    // history: a step that claimed it may be cancelled or fail before, which drops it.
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (ticketId === undefined || this.host.closing()) return
      // Turn boundaries are the worker's operational pulse: ids, reason and duration only, never a prompt or an answer.
      if (event.type === 'turn/start') {
        this.turns.set(ticketId, { turn: event.data.turn, startedAt: Date.now() })
        this.host.log.debug('turn.started ticket=%s turn=%d', ticketId, event.data.turn)
        return
      }
      if (event.type === 'turn/end') {
        const started = this.turns.get(ticketId)
        const duration = started?.turn === event.data.turn ? Math.max(0, Date.now() - started.startedAt) : 0
        this.turns.delete(ticketId)
        const reason = event.data.reason
        if (reason.kind === 'aborted') {
          this.host.log.info('turn.ended ticket=%s turn=%d reason=aborted cancel=%s duration=%dms',
            ticketId, event.data.turn, reason.reason.kind, duration)
        } else {
          this.host.log.info('turn.ended ticket=%s turn=%d reason=%s duration=%dms', ticketId, event.data.turn, reason.kind, duration)
        }
        return
      }
      if (event.type !== 'user/message') return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
        // A root worker receives the Input under its deterministic message id; a Lead-hosted child receives the Lead's message,
        // whose id DSH chose, so the Input it carries is named in the delivered text.
        const carried = (() => {
          try { return (JSON.parse(text) as { trigger_id?: string }).trigger_id } catch { return undefined }
        })()
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
          && (this.host.sessions.promptedId(input.id) === message.id || (carried !== undefined && input.triggerId === carried))).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error, turn, step }) => {
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return
      // Error name, code, turn and step are metadata; the error message and any provider payload are never logged.
      this.host.log.warn('agent.error ticket=%s name=%s code=%s turn=%s step=%s', ticket.id,
        error instanceof Error ? error.name : 'Error', String((error as { code?: unknown } | undefined)?.code ?? ''), String(turn), String(step))
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
    }))
  }
  /** Unsubscribes from host agent events and clears any pending transient-retry timers. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const dispose of this.watching.values()) dispose()
    this.watching.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  resume(): void {
    // Launch pending tickets oldest first (in acceptance order).
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        // A restart within this process left DSH's Sessions, jobs and subagents running: they stop first. The inbox keeps an
        // Input that was handed over but not yet taken.
        this.watchJobs(ticket.id)
        this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent-further restarted', true)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      }
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // Wait while processing is paused or no wake slot is free.
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      const sessionId = workerSessionId(ticketId)
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake', ticket.project) } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      // A Lead-hosted child refuses a root prompt, so a transient retry wakes it from its Lead instead.
      const leadProject = this.leadProject(ticket)
      const sent = leadProject
        ? this.host.sessions.ensureLead(leadProject.id, leadProject.workspace, `Lead · ${leadProject.name}`)
          .then(lead => this.leads.send(lead, sessionId, text, this.host.lifetime))
        : this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
   * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
   */
  private handOff(ticketId: string, agent: Agent): void {
    this.track(ticketId, stopSubagents(this.host.context, agent, true))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended) return
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
    await agent.whenIdle()
    // A turn that failed for a passing reason goes on after its backoff, which is no end of the turn.
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // A turn that ended as turns do starts the count of passing failures again.
    this.transient.delete(idle.id)
    // The ticket while the Assignment that went idle runs it.
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person;
    // an Input delivered after its result or question is new work.
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // A turn a person started in the Session is the person's work, which goes on in the background as any turn's does.
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // The worker read what reached it before a turn that ended: one it handed off with, or one whose background work ended.
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile: at most for the limit from
    // this idle, and until the worker runs again or the Assignment ends.
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(idle.id)) return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // Its shell jobs that ran past the limit are killed, which it is told at its next turn; its subagents, whose stop would
      // wake it, go on.
      const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name)
      if (jobs.length) {
        void this.background(killJobs(this.host.context, sessionId, 'The job ran past its limit', left))
        const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`
        void this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }))
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
    if (handedOff(current)) return
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
    this.host.log.info('report.recorded ticket=%s state=waiting outcome=%s', ticket.id,
      this.host.store.tickets.get(ticket.id)?.ended?.outcome ?? 'none')
  }
}
