/** The domain Engine: the single entry point of the core, and the role interfaces its callers receive. */
import { randomBytes } from 'node:crypto'
import { UserError } from './errors.ts'
import { isoTime, liveTicket, PROJECT_REQUEST_INSTRUCTION_LIMIT, PROJECT_REQUEST_TITLE_LIMIT, ProjectRequestError, projectRequestOpen }
  from './model.ts'
import type { ChannelRef, Decision, PolicyEffect, ProjectRequest, ProjectRequestDisposition, ProjectRequestInput, ProjectRequestReply,
  ProjectRequestStatus, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Candidate, ProjectRequestRepository, Repositories } from './ports.ts'
import type { EngineOptions } from './part.ts'
import { Assignments, type WorkerReport } from './assignments.ts'
import { Evals, type Outcome } from './evals.ts'
import { Intake, type ReceiveResult } from './intake.ts'
import { Replies, type Reply, type ReplyRequest } from './replies.ts'
import { Tickets } from './tickets.ts'

declare module './ports.ts' {
  interface DomainEvents {
    /** A ProjectRequest ended `completed`; the runtime reports a root request through its origin Channels (docs/012 D6). */
    'project-request.completed': { projectRequestId: string }
  }
}

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './intake.ts'
export type { Reply, ReplyRequest } from './replies.ts'

/**
 * Single transactional entry point for mutating Triggers, Threads, Decisions, Tickets, and Assignments.
 * Coordinates Intake, Evals, Tickets, Assignments, and Replies inside synchronous repository transactions while queuing side
 * effects through ports. Callers receive role-scoped `Pick` interfaces rather than the full engine.
 */
export class Engine {
  private readonly repo: Repositories
  private readonly replies: Replies
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly evals: Evals
  private readonly intake: Intake
  private readonly projectRequests: ProjectRequestRepository | undefined
  constructor(private readonly options: EngineOptions) {
    this.repo = options.repo
    this.projectRequests = options.repo.projectRequests
    this.replies = new Replies(options)
    this.tickets = new Tickets(options, this.replies)
    this.assignments = new Assignments(options, this.tickets, this.replies)
    this.evals = new Evals(options, this.tickets)
    this.intake = new Intake(options, this.tickets)
  }

  // Sources

  /**
   * A Source's request to take in a Trigger: store it once, fan it out to the tickets that subscribe to its Threads (to an
   * ended one only a person's message, which resumes it at once unless processing is paused, and to none a person stopped),
   * and queue it for Eval on its primary Thread unless a ticket's worker decides it (see `followupOwners`).
   * Triggers that arrive while an Eval of that Thread runs wait together for the next one.
   */
  receive(trigger: Trigger): ReceiveResult { return this.repo.atomic(() => this.intake.receive(trigger)) }
  /**
   * A Source's request to make an open ticket follow one of its Threads, such as a pull request's, `own` when the ticket
   * opened it: the ticket subscribes to it, and a ready report ends it only once `followsDone` holds (see `Tickets.followsDone`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own))
  }
  /**
   * A Source's fact that a Thread closed, such as its pull request's merge, at the time it happened. An open ticket that
   * follows it ends once it is done with the Threads it follows, unless work resumed since the close has not finished, or
   * its worker took up a person's message the ticket decides after its latest report.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    this.repo.atomic(() => { this.tickets.threadClosed(thread, outcome, isoTime(at)) })
  }

  // The clock

  /**
   * Requeues overdue Evals up to `REQUEUES` times before recording `unavailable` (undelivered Evals never expire), starts the
   * Evals of Threads whose queued Triggers wait, and resumes ended tickets a person's message reached while processing was
   * paused. While processing is paused, nothing expires: each Eval in progress notes when the pause began, and its deadline
   * moves forward by the pause's length once processing resumes. Each Eval and each ticket update takes one transaction.
   */
  evaluateDue(): void {
    const policy = this.options.policy()
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.repo.atomic(() => { this.evals.due(thread, policy) })
    if (policy.paused) return
    for (const ticket of this.repo.tickets.active()) {
      if (!liveTicket(ticket) && ticket.undelivered.length) this.repo.atomic(() => { this.tickets.wake(ticket.id) })
    }
    for (const thread of this.repo.threads.active()) {
      if (thread.pending.length && !thread.evaluating) this.repo.atomic(() => { this.evals.start(thread.key, policy) })
    }
  }

  // The main Session

  /** The candidate of the Eval that holds a Trigger, as its assessor sees it; undefined while no Eval holds it. */
  candidate(triggerId: string): Candidate | undefined { return this.evals.candidate(triggerId) }
  /**
   * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does, such as a person's explicit
   * request the main Session routes. A proactive candidate is accepted only in `auto` mode with enabled rules its assessment
   * matched, and a Trigger that already started a ticket returns that ticket's Decision. An invalid stop is recorded as
   * `ignore`; one judged under an older Policy as `unavailable`. A decision that ignores, cannot assess or stops a
   * whitelisted person's explicit mention or direct message also queues the one notice that answers it (docs/012 D8).
   * @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
   * ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
   * mode or without enabled matching rules.
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    return this.repo.atomic(() => {
      const decision = this.evals.decide(triggerId, outcome)
      this.replies.answerExplicit(decision)
      return decision
    })
  }
  /**
   * Attach a Trigger to a ticket that the message points at: the ticket follows the Trigger's Threads and receives it as an
   * Input with the routing note, and the Eval that holds the Trigger ends, since the ticket has it now; the other Triggers of
   * its batch wait for a fresh Eval. A note for an Input the worker already received goes out as a new Input, and so does a
   * message the ticket let go, read for context only, or had before it ended. An ended ticket resumes under its Mandate, at
   * once unless processing is paused.
   * @throws UserError for a ticket a person stopped, which withdrew its Mandate, or one whose Mandate the Policy no longer holds.
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.repo.atomic(() => {
      // A message this ticket's worker handed back is not its work: attached here, no worker would decide it, and it could not be handed back again.
      const handedBack = this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)
      if (handedBack) throw new UserError('handedBackHere')
      const trigger = this.tickets.attachable(ticketId, triggerId)
      this.evals.withdraw(trigger)
      this.tickets.attach(ticketId, trigger, note)
      this.evals.routed(triggerId, ticketId)
      this.tickets.wake(ticketId)
      return this.repo.tickets.get(ticketId)!
    })
  }
  /**
   * Ask a running worker that waits in `waiting` state for its status; any other worker is left alone.
   * @returns whether the worker was asked.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean { return this.repo.atomic(() => this.tickets.requestStatus(ticketId)) }
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where the person's message was
   * written, attention where the message that raised the question was, else, like a result, to the conversation the ticket
   * started in. A message queued before is not queued again (see `Replies.reply`).
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket that
   * is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply { return this.repo.atomic(() => this.replies.reply(request)) }

  // Project requests (docs/012)

  private now(): string { return this.options.now?.() ?? new Date().toISOString() }

  /**
   * Record a project-level request a worker or the project Lead raises: `pending`, with no replies yet, in `project`.
   * A worker's repeated raise for the same Ticket and title returns the open request instead of a second one (docs/012 D4),
   * and a derived request is linked from its root request's `derived` list.
   * @throws ProjectRequestError when the repository stores no project requests, the text is empty or too long, or the root
   * named is unknown, is itself derived, or belongs to another project.
   */
  raiseProjectRequest(input: ProjectRequestInput): ProjectRequest {
    return this.repo.atomic(() => {
      const store = this.projectRequestStore()
      const { title, instruction } = this.projectRequestText(input)
      // One open request per (ticket, title): a repeated call answers the request it raised before.
      if (input.raised_by.ticket) {
        const existing = store.list(input.project).find(request =>
          request.raised_by.ticket === input.raised_by.ticket && request.title === title && projectRequestOpen(request.status))
        if (existing) return existing
      }
      const at = this.now()
      const parent = input.root?.project_request_id ? store.get(input.root.project_request_id) : undefined
      if (input.root?.project_request_id) {
        if (!parent) throw new ProjectRequestError('unknownRootProjectRequest')
        if (parent.root?.project_request_id) throw new ProjectRequestError('notRootProjectRequest')
        if (parent.project !== input.project) throw new ProjectRequestError('foreignProjectRequest')
      }
      const request: ProjectRequest = {
        id: `prq-${randomBytes(4).toString('hex')}`,
        project: input.project,
        kind: input.kind ?? 'work',
        title,
        instruction,
        raised_by: { ...input.raised_by },
        status: 'pending',
        replies: [],
        tickets: [],
        derived: [],
        created_at: at,
        updated_at: at,
        ...input.root ? { root: { ...input.root } } : {},
      }
      store.save(request)
      if (parent) store.save({ ...parent, derived: [...parent.derived, request.id], updated_at: at })
      return request
    })
  }
  /**
   * The project requests of one project, or of every project, oldest first; `status` narrows the list to one state.
   * @throws ProjectRequestError when the repository stores no project requests.
   */
  listProjectRequests(filter: { project?: string; status?: ProjectRequestStatus } = {}): ProjectRequest[] {
    const requests = this.projectRequestStore().list(filter.project)
    return filter.status === undefined ? requests : requests.filter(request => request.status === filter.status)
  }
  /**
   * Record the Lead's reply on an open project request, without a disposition (docs/012 D3); replies are kept oldest first.
   * @throws ProjectRequestError when the request is unknown or settled, or the reply is empty.
   */
  replyProjectRequest(id: string, reply: ProjectRequestReply): ProjectRequest {
    return this.repo.atomic(() => {
      const store = this.projectRequestStore()
      const request = this.projectRequestOf(store, id)
      if (!projectRequestOpen(request.status)) throw new ProjectRequestError('settledProjectRequest')
      return this.saveProjectRequestReply(store, request, reply, this.now())
    })
  }
  /**
   * Dispose an open project request with the Lead's mandatory reply (docs/012 D3): `accept` moves it to `accepted`,
   * `reject` to `rejected` and `needs-info` to `needs-info`, recording the decision after the reply. Creating the domain
   * Request and its Tickets on accept is the Lead tools' job when they land (docs/012 D5); this records the decision they read.
   * @throws ProjectRequestError when the request is unknown, already settled, or the reply is empty.
   */
  disposeProjectRequest(id: string, disposition: ProjectRequestDisposition): ProjectRequest {
    return this.repo.atomic(() => {
      const store = this.projectRequestStore()
      const request = this.projectRequestOf(store, id)
      if (request.status !== 'pending' && request.status !== 'needs-info') throw new ProjectRequestError('settledProjectRequest')
      const at = this.now()
      const status: ProjectRequestStatus = disposition.action === 'accept' ? 'accepted'
        : disposition.action === 'reject' ? 'rejected' : 'needs-info'
      const notes = disposition.notes?.trim()
      return this.saveProjectRequestReply(store, request, disposition, at, {
        status,
        decision: { action: disposition.action, at, ...notes ? { notes } : {} },
      })
    })
  }
  /**
   * Complete an accepted project request with the Lead's summary (docs/012 D5, D6): the summary is recorded as the last
   * reply, the request ends `completed`, and the completion is announced so the runtime sends the one aggregate report for
   * a root request. The Lead checks that all Tickets and derived requests ended before it calls this; the report reads the
   * same record.
   * @throws ProjectRequestError when the request is unknown, not accepted (or approved by the architecture flow), or the
   * summary is empty.
   */
  completeProjectRequest(id: string, summary: ProjectRequestReply): ProjectRequest {
    return this.repo.atomic(() => {
      const store = this.projectRequestStore()
      const request = this.projectRequestOf(store, id)
      if (request.status !== 'accepted' && request.status !== 'approved') throw new ProjectRequestError('notAccepted')
      const at = this.now()
      const completed = this.saveProjectRequestReply(store, request, summary, at, { status: 'completed', completed_at: at })
      this.options.emit?.({ type: 'project-request.completed', at, data: { projectRequestId: completed.id } })
      return completed
    })
  }
  private projectRequestStore(): ProjectRequestRepository {
    const store = this.projectRequests
    if (!store) throw new ProjectRequestError('noProjectRequestStore')
    return store
  }
  private projectRequestOf(store: ProjectRequestRepository, id: string): ProjectRequest {
    const request = store.get(id)
    if (!request) throw new ProjectRequestError('unknownProjectRequest')
    return request
  }
  /** Trimmed text, refusing empty and over-long project-request titles and instructions. */
  private projectRequestText(input: Pick<ProjectRequestInput, 'title' | 'instruction'>): { title: string; instruction: string } {
    const title = input.title.trim(), instruction = input.instruction.trim()
    if (!title || !instruction) throw new ProjectRequestError('emptyText')
    if (title.length > PROJECT_REQUEST_TITLE_LIMIT || instruction.length > PROJECT_REQUEST_INSTRUCTION_LIMIT) {
      throw new ProjectRequestError('tooLong')
    }
    return { title, instruction }
  }
  /** Append the Lead's reply at `at`, with `changes` applied, and save the request it answers. */
  private saveProjectRequestReply(store: ProjectRequestRepository, request: ProjectRequest, reply: ProjectRequestReply, at: string,
    changes: Partial<ProjectRequest> = {}): ProjectRequest {
    const text = reply.text.trim()
    if (!text) throw new ProjectRequestError('emptyText')
    const updated: ProjectRequest = { ...request, ...changes, replies: [...request.replies, { at, by: reply.by.trim(), text }], updated_at: at }
    store.save(updated)
    return updated
  }

  // People, through the panel or the main Session

  /** The assessor delivered an Eval's candidate to its Session: the Eval's deadline counts from now. */
  candidateDelivered(evalId: string): void { this.repo.atomic(() => { this.evals.delivered(evalId, this.options.policy()) }) }
  /**
   * Queue a stored Trigger for a fresh Eval, such as a person's replay; returns false while an Eval holds it.
   * @throws UserError when the trigger is unknown.
   */
  reevaluate(triggerId: string): boolean { return this.repo.atomic(() => this.evals.reevaluate(triggerId)) }
  /**
   * A person dismisses the problem an unavailable Decision shows: the overview lists it no more.
   * @throws UserError for a Decision that is unknown or not unavailable.
   */
  dismiss(decisionId: string): Decision { return this.repo.atomic(() => this.evals.dismiss(decisionId)) }
  /**
   * Drop every ticket's Subscription to a Thread, until a new Decision subscribes one again.
   * @returns whether a Subscription was dropped.
   */
  unsubscribe(thread: string): boolean { return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, 'person')) }
  /**
   * A person stops a ticket, which withdraws its Mandate: it ends and receives nothing more.
   * @throws UserError when the ticket is unknown.
   */
  stopTicket(ticketId: string, reason?: string): Ticket { return this.repo.atomic(() => this.tickets.stop(ticketId, reason)) }
  /**
   * A person retries a ticket whose worker reported failed or blocked (or whose input delivery failed): the stalled
   * Assignment ends and a new one starts under the same Mandate.
   * @throws UserError when the ticket is unknown, has ended, or is not retryable.
   */
  retryTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.retry(ticketId)) }

  // The Executor

  /**
   * The Executor's fact that an Assignment runs; the Inputs that wait for it go out.
   * @throws UserError when the ticket is unknown.
   */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.started(ticketId, assignmentId) })
  }
  /**
   * The Executor's fact that Inputs reached the Assignment that runs the ticket, which clears a failed delivery. A fact about
   * an Assignment that no longer runs is dropped. Its worker reads each once its Session takes it into a step (`inputsRead`).
   */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.delivered(ticketId, assignmentId, inputIds) })
  }
  /**
   * The Executor's fact that the worker's Session of an open ticket took the messages that carried Inputs into a step, from
   * which its model reads them: a report or the end of a turn after that counts them as read at the ticket's end.
   * @throws UserError when the ticket is unknown.
   */
  inputsRead(ticketId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.read(ticketId, inputIds) })
  }
  /** The Executor's fact that a turn of the worker of the Assignment that runs the ticket ended, after a report too. */
  turnEnded(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.turnEnded(ticketId, assignmentId) })
  }
  /** The Executor's fact that delivering Inputs to the Assignment that runs the ticket failed; the ticket shows it until a delivery succeeds. */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.repo.atomic(() => { this.assignments.deliveryFailed(ticketId, assignmentId, error) })
  }
  /**
   * A worker's request, through its Executor, to mark a Thread attached to its ticket unrelated, for `reason`: only that
   * ticket's Subscription drops, until a new Decision subscribes it again.
   * @throws UserError when the ticket is unknown, or for the Thread the ticket started on, one a Source bound it to (such as
   * its pull request's), or one it does not follow.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.repo.atomic(() => { this.tickets.markUnrelated(ticketId, thread, reason) })
  }
  /**
   * An Executor's Subscription to a Thread it found related, for context: see `Tickets.followForContext` and `Thread.context`.
   * @returns false when the ticket already follows the Thread.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread))
  }
  /**
   * A fact the main Session gives an open ticket's Executor: see `Tickets.note`.
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket { return this.repo.atomic(() => this.tickets.note(ticketId, text)) }
  /**
   * An Executor's hand-back of a message that reached its ticket but asks for more than it: see `Evals.handback`.
   * @returns whether it was queued for Eval: false while another ticket still decides it, and for one this ticket did not decide (see `Evals.handback`).
   * @throws UserError when the ticket or trigger is unknown, the trigger did not reach the ticket, or the ticket already handed it back.
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason))
  }
  /**
   * Record a report on an open ticket's current Assignment. Its question for a person (`attention`) is asked, kept, or
   * cleared (`null` or a `ready` report), and a replaced attention question whose reply has not been sent yet is withdrawn
   * from the outbox. A `blocked` or `failed` report holds back automated inputs until a human message arrives. A `dropped`
   * report ends the ticket, and a `ready` report ends it: `completed` without followed Threads, else with the `followsDone`
   * outcome once `followsDone` holds.
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question that comes with a ready result or an
   * answer, or a question or answer that names a message that is not a person's or did not reach the ticket.
   */
  report(ticketId: string, report: WorkerReport): Ticket { return this.repo.atomic(() => this.assignments.report(ticketId, report)) }
  /**
   * Handles an assignment that was running when the host stopped: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no Input reached its worker after that report, in which case it keeps its
   * Session and state and gets the Inputs that wait for it.
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.interrupted(ticketId, assignmentId) })
  }

  // Settings

  /**
   * The Policy changed: each open ticket in `effects` is told how the change bears on it, and Evals in progress start again
   * under the new version.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void {
    this.repo.atomic(() => { this.tickets.policyChanged(from, to, effects); this.evals.policyChanged(from, to) })
  }
}

/** What Sources ask and tell the Engine. */
export type EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>
/** What the main Session asks of the Engine. */
export type EngineForMainSession = Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'
  | 'listProjectRequests' | 'replyProjectRequest' | 'disposeProjectRequest' | 'completeProjectRequest'>
/** What people ask of the Engine, through the panel or the main Session. */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'>
/** What Settings tells the Engine. */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** What the Executor tells the Engine, and what its workers ask of it. */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
  | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply' | 'raiseProjectRequest'>
