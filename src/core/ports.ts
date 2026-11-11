/** Ports the core depends on. Sources, policies, assessors, executors, and channels are project-specific. */
import type { Assignment, ChannelRef, Decision, DecisionKind, Deliverable as TicketDeliverable, Mandate, MandateBasis, ProjectRequest, Request, Strength, Thread, Ticket, TicketEndBy, TicketEndCause, TicketOutcome, Trigger }
  from './model.ts'
import type { SelfReportRepository } from './self-reports.ts'
import type { Reason } from './reasons.ts'

/** Gate admission result: either inadmissible with a reason code, or admissible with strength and MandateBasis. */
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** Whether a Source receives a Trigger; `observed` when it also receives messages not addressed to the agent, and `row` the receiving scope the Policy's admission table names, such as a chat. */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis. */
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy. */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** Re-check a mandate's gate-layer basis under this policy, such as before an ended ticket resumes. */
  revalidate(mandate: Mandate): boolean
  /** Whether an inferred candidate may be accepted on the rules its assessment matched: assessments accept, and each rule is enabled. */
  admitsInferred(rules: readonly string[]): boolean
  /** How long an assessor may take before an eval is recorded as unavailable. */
  evalTimeoutMs: number
}

/** What the assessor receives: bounded facts, never authority. */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** Every ticket on the thread, including ended ones, for duplicate judgement. */
  tickets: Ticket[]
}

/** One delivery unit of an accepted ask: a Request creates one Ticket for each, in its own project, ordered by `after`. */
export interface DeliveryUnit {
  /** The registered project whose checkout and repository deliver this Ticket. */
  project?: string
  /** A short label for this Ticket; the accept's title when omitted. */
  title?: string
  /** Indexes of earlier deliverables of the same accept this one waits on. */
  after?: number[]
}
export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /** An accept: `rules` the assessment matched, `name` the ticket's requested short name, `project` the registered project whose checkout the work uses, `note` a routing note for its worker, and `deliverable` what the accepted Tickets owe (default `change`). */
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; project?: string; note?: string; deliverables?: DeliveryUnit[]; deliverable?: TicketDeliverable }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** Semantic judgement. `request` queues the assessment, idempotently per `evalId`; the outcome returns through `Engine.decide`. */
export interface Assessor {
  request(candidate: Candidate): void
  /** Called whenever an eval ends, decided or not, so the assessor drops what it kept for it. */
  release?(evalId: string): void
}

/**
 * Why an Executor stops an Assignment: a Ticket end (see `TicketEndCause`), or a retry, which ends the Assignment but not the
 * Ticket. The cause decides how the worker is retired, so an Executor must never infer it from report timing.
 */
export type ExecutorStopCause = TicketEndCause | 'retry'

/**
 * Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
 * commands, so each method only queues work, which reports back through the Engine's callbacks.
 */
export interface Executor {
  /** Queue a pending assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * Queue delivery of the ticket's waiting Inputs to its running assignment; reports back through `Engine.inputsDelivered`
   * or `Engine.deliveryFailed`, and through `Engine.inputsRead` once its worker's Session takes them into a step.
   */
  deliver(ticket: Ticket, assignment: Assignment): void
  /**
   * End an assignment's work, such as cancelling its Session's turn; called after the ticket or assignment has already ended in
   * the domain. `cause` says why, which decides whether a worker's in-flight turn may finish (`report`) or is preempted.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string, cause: ExecutorStopCause): void
}

/** A message for a Channel; `ticketId` names the Ticket it is for, when there is one. */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }
/** A queued message waits (`pending`), went out (`sent`), or was dropped because its conversation can never receive it (`dropped`). */
export type ReplyStatus = 'pending' | 'sent' | 'dropped'
/** The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later. */
export interface Outbox {
  /** Queue a message idempotently; an id queued before keeps its first message. */
  send(message: OutboundMessage): void
  /** Whether a message was queued, and what became of it. */
  status(id: string): ReplyStatus | undefined
  /** Withdraw a message that has not gone out. */
  withdraw(id: string): void
}

/** What the Engine reports after a change, by event type. */
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; cause: TicketEndCause; outcome: TicketOutcome; reason?: string }
  /** A Request all of whose Tickets ended; the one place its result is reported. */
  'request.ended': { requestId: string; by: 'human' | 'executor'; outcome: 'done' | 'partial' | 'stopped' }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  /** A person dropped every ticket's Subscription, or a ticket's Executor its own, for `reason`. */
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** A person's follow-up that reached tickets and that an earlier version also queued for Eval left the queue. */
  'trigger.followup': { triggerId: string }
  'policy.changed': { from: string; to: string }
}
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/** The project-request records of a schema 21 Store (docs/012 D1): root and derived requests, read oldest first. */
export interface ProjectRequestRepository {
  get(id: string): ProjectRequest | undefined
  save(request: ProjectRequest): void
  /** Oldest first; `project` narrows the list to one project's requests. */
  list(project?: string): ProjectRequest[]
}

/** The self-report records of a schema 24 Store (docs/014 D3): drafts, filed Issues and dismissed findings. */
/** Durable state. Every method is synchronous so `atomic` can wrap a unit of work. */
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): import('./model.ts').TriggerDisposition | undefined
    saveDisposition(id: string, value: import('./model.ts').TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** Threads with Triggers queued for Eval or an Eval in progress. */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** Tickets with undelivered Inputs or a pending or running Assignment, which is always the latest. */
    active(): Ticket[]
  }
  requests: {
    get(id: string): Request | undefined
    save(request: Request): void
    list(): Request[]
  }
  /** Absent from repositories opened before schema 21, such as `MemoryRepositories`; project-request commands refuse there. */
  projectRequests?: ProjectRequestRepository
  /** Absent from repositories opened before schema 24, such as `MemoryRepositories`; the Issue outlet refuses there. */
  selfReports?: SelfReportRepository
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
}
