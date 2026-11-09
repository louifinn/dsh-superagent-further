/** The domain Engine: the single entry point of the core, and the role interfaces its callers receive. */
import { randomBytes } from 'node:crypto'
import { UserError } from './errors.ts'
import { isoTime, latestReport, liveTicket, PROJECT_REQUEST_INSTRUCTION_LIMIT, PROJECT_REQUEST_TITLE_LIMIT, ProjectRequestError,
  projectRequestOpen, threadKey } from './model.ts'
import type { Assignment, Decision, Deliverable, Mandate, PolicyEffect, ProjectRequest, ProjectRequestDeliverable, ProjectRequestDisposition,
  ProjectRequestInput, ProjectRequestPlan, ProjectRequestReply, ProjectRequestStatus, Request, ThreadRef, Ticket, Trigger } from './model.ts'
import { key } from './ids.ts'
import type { AssessmentOutcome, Candidate, DeliveryUnit, ProjectRequestRepository, Repositories } from './ports.ts'
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
    /** An architecture request's design ended and its proposal must reach the root Channel for a person's approval (docs/012 D7). */
    'project-request.approval-requested': { projectRequestId: string }
  }
}

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './intake.ts'
export type { Reply, ReplyRequest } from './replies.ts'

/** What the main Session asks when an installation automation delivery's findings become work (docs/012 D12). */
export interface InstallationRequestInput {
  title: string
  instruction: string
  /** The installation automation id from the delivery marker, recorded as the Mandate's provenance. */
  automation: string
  /** One Ticket per unit, in order; every unit names a registered project. */
  units: DeliveryUnit[]
  deliverable?: Deliverable
}

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
   * A worker's repeated raise for the same Ticket and title, and a Lead's repeated raise of the same title in its Session,
   * return the open request instead of a second one (docs/012 D4, D11); a derived request is linked from its root request's
   * `derived` list.
   * @throws ProjectRequestError when the repository stores no project requests, the text is empty or too long, or the root
   * named is unknown, is itself derived, or belongs to another project.
   */
  raiseProjectRequest(input: ProjectRequestInput): ProjectRequest {
    return this.repo.atomic(() => {
      const store = this.projectRequestStore()
      const { title, instruction } = this.projectRequestText(input)
      // One open request per (ticket, title): a repeated call answers the request it raised before.
      const open = store.list(input.project).filter(request => request.title === title && projectRequestOpen(request.status))
      const existing = input.raised_by.ticket
        ? open.find(request => request.raised_by.ticket === input.raised_by.ticket)
        : open.find(request => request.raised_by.ticket === undefined && request.raised_by.session === input.raised_by.session)
      if (existing) return existing
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
   * Turn an installation automation delivery's findings into work (docs/012 D12): one rootless Request with its delivery
   * units' Tickets, under an installation Mandate that records the automation id. A repeated raise for the same title and
   * automation while the first Request is open returns it instead of creating a second one.
   * @throws ProjectRequestError when the title or instruction is empty or too long, the automation id is empty, or a unit
   * names no project.
   */
  raiseInstallationRequest(input: InstallationRequestInput): Request {
    return this.repo.atomic(() => {
      const title = input.title.trim(), instruction = input.instruction.trim()
      if (!title || !instruction) throw new ProjectRequestError('emptyText')
      if (title.length > PROJECT_REQUEST_TITLE_LIMIT || instruction.length > PROJECT_REQUEST_INSTRUCTION_LIMIT) {
        throw new ProjectRequestError('tooLong')
      }
      const automation = input.automation.trim()
      if (!automation) throw new ProjectRequestError('emptyText')
      const units = input.units.slice(0, 8).map((unit): DeliveryUnit => {
        const project = unit.project?.trim()
        if (!project) throw new Error('Every installation request unit needs a registered project')
        return { project, ...unit.title?.trim() ? { title: unit.title.trim() } : {}, ...unit.after?.length ? { after: unit.after } : {} }
      })
      if (!units.length) throw new Error('An installation request needs at least one delivery unit')
      const existing = this.repo.requests.list().find(request => !request.ended && request.title === title
        && request.mandate.basis.via === 'installation' && request.mandate.basis.automation === automation)
      if (existing) return existing
      const at = this.now()
      const decisionId = key('installation-request', automation, title, at)
      const mandate: Mandate = {
        strength: 'explicit',
        policyVersion: this.options.policy().version,
        basis: { via: 'installation', automation },
        actor: { source: 'dsh-superagent', id: 'installation' },
        scope: instruction,
      }
      const outcome: Extract<AssessmentOutcome, { kind: 'accept' }> = {
        kind: 'accept', title, scope: instruction, reason: 'installationAutomation',
        deliverables: units, project: units[0]!.project, ...input.deliverable ? { deliverable: input.deliverable } : {},
      }
      return this.tickets.createLead(decisionId, mandate, outcome, at)
    })
  }
  /**
   * The project requests of one project, or of every project, oldest first; `status` narrows the list to one state.
   * @throws ProjectRequestError when the repository stores no project requests.
   */
  listProjectRequests(filter: { project?: string; status?: ProjectRequestStatus } = {}): ProjectRequest[] {
    const requests = this.projectRequestStore().list(filter.project)
    return filter.status === undefined ? requests : requests.filter(request => request.status === filter.status)
  }  /**
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
   * `reject` to `rejected` and `needs-info` to `needs-info`, recording the decision after the reply. An accept also creates
   * the domain work: an architecture request gets one design Ticket that produces the decision document (docs/012 D7) and
   * waits for a person's approval, while a work request creates its implementation Request and Tickets at once (docs/012 D5).
   * @throws ProjectRequestError when the request is unknown, already settled, the reply is empty, or an architecture accept
   * has no root Trigger to anchor its approval.
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
      const decision = { action: disposition.action, at, ...notes ? { notes } : {} }
      if (disposition.action !== 'accept') return this.saveProjectRequestReply(store, request, disposition, at, { status, decision })
      const trigger = request.root ? this.repo.triggers.get(request.root.trigger_id) : undefined
      if (request.kind === 'architecture') {
        if (!request.root || !trigger) throw new ProjectRequestError('approvalRootRequired')
        const design = this.createDesignTicket(request, trigger, at)
        return this.saveProjectRequestReply(store, request, disposition, at,
          { status, decision, design_ticket_id: design, tickets: [...request.tickets, design] })
      }
      // A work request the Lead raised itself has no root Trigger: it still creates its Request and Tickets, with no
      // external Channels, so the project's Lead owns and reports the result (docs/012 D11).
      if (!request.root) {
        const decisionId = key('lead-request', request.id)
        const created = this.tickets.createLead(decisionId, this.leadMandate(request), this.leadOutcome(request, 'work'), at)
        return this.saveProjectRequestReply(store, request, disposition, at, {
          status, decision, request_id: created.id, tickets: [...request.tickets, ...created.ticketIds],
        })
      }
      // A root Trigger that no longer exists has no Channels to deliver from; record the accept without creating work.
      if (!trigger) return this.saveProjectRequestReply(store, request, disposition, at, { status, decision })
      const decisionId = key('lead-request', request.id)
      this.tickets.create(key('ticket', request.id, 'work'), decisionId, this.leadMandate(request, trigger),
        { triggerIds: [trigger.id], primary: trigger.id }, this.leadOutcome(request, 'work'), at)
      const created = this.repo.requests.get(key('request', decisionId))
      return this.saveProjectRequestReply(store, request, disposition, at, {
        status, decision,
        ...created ? { request_id: created.id, tickets: [...request.tickets, ...created.ticketIds] } : {},
      })
    })
  }
  /**
   * Record the plan the Lead staged when it accepted a project request (docs/012 D5, D7): the statement and the ordered
   * deliverables that become the implementation Request's Tickets after a person approves the design. The tool records it
   * before the disposition because the disposition arrives as the Lead's reply text only.
   * @throws ProjectRequestError when the request is unknown or settled, or a deliverable names another project.
   */
  planProjectRequest(id: string, plan: ProjectRequestPlan): ProjectRequest {
    return this.repo.atomic(() => {
      const store = this.projectRequestStore()
      const request = this.projectRequestOf(store, id)
      if (!projectRequestOpen(request.status)) throw new ProjectRequestError('settledProjectRequest')
      const deliverables = (plan.deliverables ?? []).slice(0, 8).map((item): ProjectRequestDeliverable => {
        const project = item.project?.trim() || request.project
        if (project !== request.project) throw new ProjectRequestError('foreignProjectRequest')
        const title = item.title?.trim().slice(0, 200)
        const after = item.after?.filter(index => Number.isInteger(index) && index >= 0)
        return { project, ...title ? { title } : {}, ...after?.length ? { after } : {} }
      })
      const statement = plan.statement?.trim().slice(0, PROJECT_REQUEST_INSTRUCTION_LIMIT)
      const updated: ProjectRequest = { ...request, plan: { ...statement ? { statement } : {}, deliverables }, updated_at: this.now() }
      store.save(updated)
      return updated
    })
  }
  /**
   * Move an accepted architecture request to `awaiting-approval` once its design Ticket ended (docs/012 D7): the design's
   * latest report becomes the proposal the runtime sends to the root Channel for a person to answer.
   * @throws ProjectRequestError when the request is not an accepted architecture request of a root thread, or its design
   * Ticket has not ended.
   */
  requestProjectApproval(id: string): ProjectRequest {
    return this.repo.atomic(() => {
      const store = this.projectRequestStore()
      const request = this.projectRequestOf(store, id)
      if (request.kind !== 'architecture') throw new ProjectRequestError('notArchitectureProjectRequest')
      if (request.status !== 'accepted') throw new ProjectRequestError('notAcceptedForApproval')
      if (!request.root) throw new ProjectRequestError('approvalRootRequired')
      const design = request.design_ticket_id ? this.repo.tickets.get(request.design_ticket_id) : undefined
      if (!design || !design.ended) throw new ProjectRequestError('designNotEnded')
      const at = this.now()
      const text = latestReport(design)?.summary?.trim() || request.instruction
      const updated: ProjectRequest = {
        ...request, status: 'awaiting-approval', proposal: { at, ticket_id: design.id, text }, updated_at: at,
      }
      store.save(updated)
      this.options.emit?.({ type: 'project-request.approval-requested', at, data: { projectRequestId: updated.id } })
      return updated
    })
  }
  /**
   * Record a person's approval or rejection of an architecture request's design (docs/012 D7), linked only to a human Trigger
   * on the request's root thread written after its proposal. Approval creates the implementation Request and its staged
   * Tickets under a Lead Mandate; rejection records the person's answer and ends the request. The Lead's reply is recorded by
   * its tool before or after this, because a rejected request accepts none.
   * @throws ProjectRequestError when the request is not awaiting approval, or no human Trigger on the root thread after the
   * proposal can be linked.
   */
  approveProjectRequest(id: string, input: { approved: boolean; trigger_id: string }): ProjectRequest {
    return this.repo.atomic(() => {
      const store = this.projectRequestStore()
      const request = this.projectRequestOf(store, id)
      if (request.kind !== 'architecture') throw new ProjectRequestError('notArchitectureProjectRequest')
      if (request.status !== 'awaiting-approval') throw new ProjectRequestError('notAwaitingApproval')
      if (!request.root || !request.proposal) throw new ProjectRequestError('approvalRootRequired')
      const trigger = this.repo.triggers.get(input.trigger_id)
      const onRoot = trigger?.threads.some(ref => threadKey(ref) === request.root!.thread_key) ?? false
      if (!trigger || !trigger.human || !onRoot || trigger.at < request.proposal.at) throw new ProjectRequestError('missingApprovalTrigger')
      const at = this.now()
      const approval = {
        thread_key: request.root.thread_key, trigger_id: trigger.id, at: trigger.at, by: 'human' as const,
        text: trigger.text.trim(), ...!input.approved ? { approved: false } : {},
      }
      if (!input.approved) {
        const rejected: ProjectRequest = { ...request, status: 'rejected', approval, updated_at: at }
        store.save(rejected)
        return rejected
      }
      const decisionId = key('lead-approval', request.id)
      this.tickets.create(key('ticket', request.id, 'implementation'), decisionId, this.leadMandate(request, trigger),
        { triggerIds: [request.root.trigger_id], primary: request.root.trigger_id }, this.leadOutcome(request, 'approved'), at)
      const created = this.repo.requests.get(key('request', decisionId))
      const approved: ProjectRequest = {
        ...request, status: 'approved', approval, updated_at: at,
        ...created ? { request_id: created.id, tickets: [...request.tickets, ...created.ticketIds] } : {},
      }
      store.save(approved)
      return approved
    })
  }
  /** The Lead Mandate an accepted project request's Tickets run under (docs/012 D2); a Lead's own request has no Trigger actor. */
  private leadMandate(request: ProjectRequest, trigger?: Trigger): Mandate {
    return {
      strength: 'explicit',
      policyVersion: this.options.policy().version,
      basis: { via: 'lead', project: request.project, project_request_id: request.id },
      actor: trigger ? { ...trigger.actor } : { source: 'dsh-superagent', id: `lead:${request.project}` },
      scope: request.plan?.statement ?? request.title,
    }
  }
  /** A worktree-safe short name for a Lead-created Ticket; Chinese or digit-led titles fall back to a stable English name. */
  private leadWorktreeName(request: ProjectRequest, phase: 'design' | 'work' | 'approved'): string {
    const words = request.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 4)
    const slug = words.join('-').slice(0, 32).replace(/-+$/g, '')
    if (/^[a-z]+(?:-[a-z0-9]+){0,3}$/.test(slug)) return slug
    return phase === 'design' ? 'lead-design' : phase === 'approved' ? 'lead-implementation' : 'lead-work'
  }
  /** The accept outcome of an accepted project request's Tickets: one design Ticket, or the staged plan's deliverables. */
  private leadOutcome(request: ProjectRequest, phase: 'design' | 'work' | 'approved'): Extract<AssessmentOutcome, { kind: 'accept' }> {
    const deliverables = phase === 'design' ? undefined : request.plan?.deliverables.length ? request.plan.deliverables : undefined
    return {
      kind: 'accept',
      title: request.title,
      scope: request.plan?.statement ?? request.title,
      reason: { code: phase === 'design' ? 'leadDesign' : phase === 'approved' ? 'leadApproved' : 'leadRequest' },
      project: request.project,
      name: this.leadWorktreeName(request, phase),
      ...deliverables ? { deliverables: deliverables.map(item => ({ ...item })) } : {},
      ...phase === 'design'
        ? { note: 'Design only: produce the decision document or plan this architecture request needs; make no code changes.' }
        : {},
    }
  }
  /**
   * Create the one design Ticket an architecture accept needs (docs/012 D7): it is not part of a domain Request, because the
   * implementation Request exists only after a person approves the design, and it starts from the root Trigger's Channel.
   */
  private createDesignTicket(request: ProjectRequest, trigger: Trigger, at: string): string {
    const id = key('ticket', request.id, 'design')
    const decisionId = key('lead-request', request.id)
    const mandate = this.leadMandate(request, trigger)
    const outcome = this.leadOutcome(request, 'design')
    let ticket: Ticket = {
      id, title: request.title, decisionId, mandate, deliverable: 'answer',
      channels: trigger.channel ? [{ ...trigger.channel }] : [],
      assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
      origin: { triggerId: trigger.id, triggerIds: [trigger.id] }, project: request.project,
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const assignment: Assignment = { id: key('assignment', ticket.id, '0'), state: 'pending', createdAt: at }
    ticket.assignments.push(assignment)
    this.repo.tickets.save(ticket)
    const stored = this.repo.tickets.get(ticket.id)
    if (stored) this.options.executor.start(stored, assignment)
    this.options.emit?.({ type: 'ticket.created', at, data: { ticketId: ticket.id, decisionId, strength: mandate.strength } })
    return ticket.id
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

/** What the project Lead's approval tools ask of the Engine (docs/012 D7). */
export type EngineForLeadApprovals = Pick<Engine, 'planProjectRequest' | 'requestProjectApproval' | 'approveProjectRequest'>
/** What Sources ask and tell the Engine. */
export type EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>
/** What the main Session asks of the Engine. */
export type EngineForMainSession = Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'
  | 'listProjectRequests' | 'replyProjectRequest' | 'disposeProjectRequest' | 'completeProjectRequest' | 'raiseInstallationRequest'>
/** What people ask of the Engine, through the panel or the main Session. */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'>
/** What Settings tells the Engine. */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** What the Executor tells the Engine, and what its workers ask of it. */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
  | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply' | 'raiseProjectRequest'>
