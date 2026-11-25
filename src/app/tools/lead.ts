/** Lead application tools: the project a Lead serves, and the Project Requests it must answer. */
import { z } from 'zod'
import { ticketStage, type ProjectRequest, type ProjectRequestInput, type ProjectRequestPlan, type Ticket } from '../../core/index.ts'
import type { Project } from '../../projects.ts'
import type { LeadDispatch } from '../lead-dispatch.ts'
import { projectRequestView } from '../lead-dispatch.ts'
import { assignmentOfRequest } from '../lead-messages.ts'
import type { Store } from '../store.ts'
import { tool, type Tool } from './tool.ts'

/** The Engine commands the Lead tools need; the runtime binds them because a Lead Session only holds its dispatch. */
export interface LeadApprovalHost {
  raise(input: ProjectRequestInput): ProjectRequest
  /** Raise an escalation to the Orchestrator for work outside this project (docs/012 D13). */
  escalate(input: ProjectRequestInput): ProjectRequest
  /** Start a reviewer subagent for a live change Ticket of this project; resolves with its Session id. */
  review(ticketId: string): Promise<{ session_id: string }>
  /** Record a reviewer's verdict on a change Ticket. */
  recordReview(ticketId: string, input: { state: 'clean' | 'blocked'; summary: string; findings?: readonly string[] }): Ticket
  plan(id: string, plan: ProjectRequestPlan): ProjectRequest
  requestApproval(id: string): ProjectRequest
  approve(id: string, input: { approved: boolean; trigger_id: string }): ProjectRequest
}
/** Bind the Engine-backed approval commands to one Store, as the runtime and the tool tests do before serving a Lead. */
const approvals = new WeakMap<object, LeadApprovalHost>()
export function bindLeadApprovals(store: object, host: LeadApprovalHost): void { approvals.set(store, host) }

/** The Executor command a Lead needs to start what the Orchestrator dispatched; the runtime binds it to the Executor. */
export interface LeadAssignmentHost {
  /** Acknowledges the dispatch grant and queues the launch; resolves with the worker Session id. */
  assign(ticketId: string, assignmentId: string): { ticketId: string; assignmentId: string; sessionId: string }
}
/** Bind the Executor's `assignForLead` to one Store, as the runtime and the tool tests do before serving a Lead. */
const assignmentHosts = new WeakMap<object, LeadAssignmentHost>()
export function bindLeadAssignments(store: object, host: LeadAssignmentHost): void { assignmentHosts.set(store, host) }

/** Host dependencies of the Lead tools: the Store's project records, its optional read-side thread history, the Lead dispatch, and
 * the Lead Session those tools answer for. */
export interface LeadToolsHost {
  readonly store: Pick<Store, 'tickets' | 'leads' | 'projectRequests'> & { readonly read?: Store['read'] }
  readonly lead: LeadDispatch
  /** The Lead Session the tools run in; a request the Lead raises records it as its raiser. */
  readonly session: string
  /** Relays a notice to a worker or reviewer Session of this project; the Sessions layer validates the Session belongs to it. */
  notify(session: string, text: string): Promise<{ delivered: true }>
  /** Relays a worker report this Lead reviewed upward to the Orchestrator (worker → Lead → Orchestrator). */
  report(reportId: string, note?: string): { reported: true }
  /** The Engine's ticket commands; the runtime binds them once its composition is complete (ADR-0008). */
  readonly tickets?: LeadTicketHost
}

/** The Engine ticket commands a project Lead may use on the live Tickets of its own project. */
export interface LeadTicketHost {
  attach(ticketId: string, triggerId: string, note?: string): Ticket
  stop(ticketId: string, reason?: string): Ticket
  retry(ticketId: string): Ticket
  note(ticketId: string, text: string): Ticket
  requestStatus(ticketId: string): boolean
}

/** The live Ticket of this Lead's project, refusing an unknown Ticket or one of another project. */
function ticketOf(host: LeadToolsHost, project: Project, id: string): Ticket {
  const ticket = host.store.tickets.get(id)
  if (!ticket) throw new Error(`Unknown Ticket ${id}`)
  if (ticket.project !== project.id) throw new Error(`Ticket ${id} belongs to project ${ticket.project}, not ${project.id}`)
  return ticket
}

/** The Engine's ticket commands, refusing when the runtime did not bind them. */
function ticketCommands(host: LeadToolsHost): LeadTicketHost {
  if (!host.tickets) throw new Error('Lead ticket commands are not bound in this runtime')
  return host.tickets
}

/** What one Ticket looks like to its project's Lead: the stage a person sees and the executor's latest state. */
function row(ticket: Ticket) {
  return { ticket_id: ticket.id, title: ticket.title, stage: ticketStage(ticket).stage,
    executor: ticket.assignments.at(-1)?.state ?? 'none', ...ticket.ended === undefined ? {} : { ended: ticket.ended.outcome } }
}

/** A Project Request of this Lead's project, refusing one that is unknown or belongs to another project. */
function requestOf(host: LeadToolsHost, project: Project, id: string): ProjectRequest {
  const request = host.store.projectRequests.get(id)
  if (!request) throw new Error(`Unknown project request ${id}`)
  if (request.project !== project.id) throw new Error(`Project request ${id} belongs to project ${request.project}, not ${project.id}`)
  return request
}

/** The statuses a Lead may filter its request list by. */
const STATUS = z.enum(['pending', 'needs-info', 'accepted', 'rejected', 'awaiting-approval', 'approved', 'completed', 'withdrawn'])

/**
 * The tools a project's Lead Session gets. `lead_status` and `lead_requests` read the project; `lead_request_create` raises
 * the work a scheduled automation's inspection finds; the remaining tools record the mandatory reply: a disposition (with
 * the plan an accept carries), an extra reply, or completion.
 */
export function leadTools(host: LeadToolsHost, project: Project): Tool[] {
  return [tool({
    name: 'lead_status',
    description: 'Read the project this Lead serves: its local clone, repository and base branch, the open and recently ended '
      + 'Tickets of the project, and the messages waiting for the Lead.',
    schema: z.object({}).strict(),
    execute: async () => {
      const open = host.store.tickets.open().filter(ticket => ticket.project === project.id)
      const ended = host.store.tickets.list().filter(ticket => ticket.project === project.id && ticket.ended !== undefined).slice(-10)
      return {
        project: { id: project.id, name: project.name, workspace: project.workspace, repository: project.repository,
          branch: project.branch === '' ? 'the repository default branch' : project.branch },
        tickets: { open: open.map(row), ended: ended.map(row) },
        messages: host.store.leads.waiting('lead', project.id)
          .map(message => ({ kind: message.kind, request: message.requestId, ...message.ticketId === undefined ? {} : { ticket_id: message.ticketId }, body: message.body })),
      }
    },
  }), tool({
    name: 'lead_requests',
    description: 'Read the Project Requests of this project: the recent ones with who raised them and their replies, the pending '
      + 'ones still unanswered, the worker reports awaiting a reply, and requests marked needs-attention.',
    schema: z.object({
      status: STATUS.optional().describe('Only requests in this status; omit for the recent requests of every status.'),
    }).strict(),
    execute: async ({ status }: { status?: z.infer<typeof STATUS> }) => {
      const requests = host.store.projectRequests.list(project.id).filter(request => status === undefined || request.status === status)
      const unanswered = host.lead.unanswered(project.id)
      const reports = host.lead.unansweredReports(project.id)
      return {
        project: project.id,
        requests: requests.slice(-30).reverse().map(projectRequestView),
        unanswered: unanswered.map(request => ({ id: request.id, title: request.title, kind: request.kind, status: request.status,
          raised_by: request.raised_by, created_at: request.created_at })),
        reports: reports.map(message => ({ request_id: message.requestId.slice('worker-report:'.length),
          ...message.ticketId === undefined ? {} : { ticket_id: message.ticketId }, at: message.at,
          delivered: message.deliveredAt !== undefined, body: message.body })),
        attention: host.lead.attention(project.id).map(message => ({ request_id: message.requestId.slice('lead-attention:'.length),
          ...message.ticketId === undefined ? {} : { ticket_id: message.ticketId }, at: message.at, body: message.body })),
      }
    },
  }), tool({
    name: 'lead_assign',
    description: 'Start the Assignment the Orchestrator dispatched for this project, as the Lead who grants its launch. Without '
      + 'assignment_id it starts the one Assignment waiting for this Lead. The worker Session owns the work: do not do it '
      + 'yourself, and answer its report or question when it reaches you.',
    schema: z.object({
      assignment_id: z.string().trim().min(1).optional()
        .describe('The assignment id from a dispatch message; omit when exactly one Assignment waits for this Lead.'),
    }).strict(),
    execute: async ({ assignment_id }: { assignment_id?: string }) => {
      const waiting = host.store.leads.list(project.id, 500)
        .filter(message => message.kind === 'assignment' && message.ackAt === undefined)
      const selected = assignment_id === undefined ? waiting
        : waiting.filter(message => assignmentOfRequest(message.requestId) === assignment_id)
      if (!selected.length) {
        throw new Error(assignment_id === undefined
          ? `No Assignment waits to start in project ${project.id}`
          : `Assignment ${assignment_id} is not waiting for this Lead's dispatch in project ${project.id}`)
      }
      if (selected.length > 1) {
        throw new Error(`More than one Assignment waits to start in project ${project.id}; pass assignment_id: `
          + selected.map(message => assignmentOfRequest(message.requestId)).join(', '))
      }
      const dispatch = selected[0]!
      const ticketId = dispatch.ticketId
      if (ticketId === undefined) throw new Error(`The dispatch ${dispatch.requestId} names no Ticket`)
      const ticket = ticketOf(host, project, ticketId)
      const assignmentId = assignmentOfRequest(dispatch.requestId)
      if (assignmentId === undefined) throw new Error(`The dispatch ${dispatch.requestId} names no Assignment`)
      const executor = assignmentHosts.get(host.store)
      if (!executor) throw new Error('Lead assignment commands are not bound in this runtime')
      const granted = executor.assign(ticket.id, assignmentId)
      return { ticket_id: granted.ticketId, assignment_id: granted.assignmentId, session_id: granted.sessionId, state: 'starting' }
    },
  }), tool({
    name: 'lead_request_create',
    description: 'Raise a project request when a scheduled automation delivery finds work this project needs. Pass the automation '
      + 'id from the delivery marker. The Lead then decides it with lead_request_decide; an accepted work request creates its '
      + 'domain Request and Tickets at once. Only work requests can be raised here: an architecture request needs a worker-raised '
      + 'request anchored to a Trigger for its approval.',
    schema: z.object({
      title: z.string().trim().min(1).max(200).describe('One line naming the work the project request asks for.'),
      instruction: z.string().trim().min(1).max(8_000).describe('What is needed, with the evidence the inspection rests on.'),
      automation: z.string().trim().min(1).max(200).optional()
        .describe('When this turn is an automation delivery, the automation id from its marker.'),
    }).strict(),
    execute: async ({ title, instruction, automation }: { title: string; instruction: string; automation?: string }) => {
      const engine = approvals.get(host.store)
      if (!engine) throw new Error('Lead approvals are not bound in this runtime')
      const raised = engine.raise({
        project: project.id, kind: 'work', title, instruction,
        raised_by: { session: host.session, ...(automation ? { automation } : {}) },
      })
      return projectRequestView(raised)
    },
  }), tool({
    name: 'lead_request_escalate',
    description: 'Escalate work that belongs outside this project, or at the installation level, to the Orchestrator. The '
      + 'Orchestrator decides it with the mandatory reply; this project Lead cannot decide an escalated request itself.',
    schema: z.object({
      title: z.string().trim().min(1).max(200).describe('One line naming the escalated work.'),
      instruction: z.string().trim().min(1).max(8_000).describe('What is needed, why this project cannot do it, and the evidence.'),
    }).strict(),
    execute: async ({ title, instruction }: { title: string; instruction: string }) => {
      const engine = approvals.get(host.store)
      if (!engine) throw new Error('Lead approvals are not bound in this runtime')
      const raised = engine.escalate({ project: project.id, kind: 'escalation', title, instruction,
        raised_by: { session: host.session } })
      return projectRequestView(raised)
    },
  }), tool({
    name: 'lead_review',
    description: 'Start an independent reviewer on a live change Ticket of this project. The reviewer runs as a subagent of this Lead '
      + 'in the Ticket worktree, reads the diff and runs the checks that matter, and reports findings back here. Record its verdict '
      + 'with lead_review_record; a blocked review keeps the Ticket open when the pull request merges.',
    schema: z.object({
      ticket_id: z.string().trim().min(1).describe('The id of a live change Ticket of this project.'),
    }).strict(),
    execute: async ({ ticket_id }: { ticket_id: string }) => {
      const ticket = host.store.tickets.get(ticket_id)
      if (!ticket) throw new Error(`Unknown Ticket ${ticket_id}`)
      if (ticket.project !== project.id) throw new Error(`Ticket ${ticket_id} belongs to project ${ticket.project}, not ${project.id}`)
      if (ticket.review !== undefined) throw new Error(`Ticket ${ticket_id} already carries a review; record it with lead_review_record`)
      const engine = approvals.get(host.store)
      if (!engine) throw new Error('Lead approvals are not bound in this runtime')
      return engine.review(ticket_id)
    },
  }), tool({
    name: 'lead_review_record',
    description: 'Record the reviewer\'s verdict on a change Ticket started with lead_review. A blocked review keeps the Ticket '
      + 'open when its pull request merges; a clean review lets the merge end it.',
    schema: z.object({
      ticket_id: z.string().trim().min(1).describe('The Ticket lead_review started a review on.'),
      state: z.enum(['clean', 'blocked']).describe('blocked names findings a person must resolve; clean accepts the change.'),
      summary: z.string().trim().min(1).max(2_000).describe('The verdict in the language of the Ticket.'),
      findings: z.array(z.string().trim().min(1).max(1_000)).max(50).optional().describe('Concrete problems a blocked review found.'),
    }).strict(),
    execute: async (input: { ticket_id: string; state: 'clean' | 'blocked'; summary: string; findings?: string[] }) => {
      const engine = approvals.get(host.store)
      if (!engine) throw new Error('Lead approvals are not bound in this runtime')
      const reviewed = engine.recordReview(input.ticket_id, { state: input.state, summary: input.summary,
        ...(input.findings ? { findings: input.findings } : {}) })
      return { ticket_id: reviewed.id, review: reviewed.review }
    },
  }), tool({
    name: 'lead_request_decide',
    description: 'Decide one project request with the reply it requires. On accept, name the statement and deliverables the work '
      + 'should carry. The reply reaches the Session that raised the request when it still exists.',
    schema: z.object({
      id: z.string().trim().min(1).describe('The project request id, as lead_requests lists it.'),
      action: z.enum(['accept', 'reject', 'needs-info']).describe('accept starts the work, reject declines it, needs-info asks the raiser for more.'),
      reply: z.string().trim().min(1).max(8_000).describe('The required non-empty reply, in the language of the request.'),
      statement: z.string().trim().min(1).max(8_000).optional().describe('accept: the instruction the accepted work follows.'),
      deliverables: z.array(z.object({ project: z.string().trim().min(1).max(40).nullish(), title: z.string().trim().min(1).max(200).nullish(),
        after: z.array(z.number().int().min(0)).nullish() }).strict()).max(8).optional()
        .describe('accept: one entry per delivery unit; `after` names earlier indexes it waits on. This project is the default project.'),
      notes: z.string().trim().min(1).max(4_000).optional().describe('Optional reason or constraint recorded with the decision.'),
    }).strict(),
    execute: async (input: { id: string; action: 'accept' | 'reject' | 'needs-info'; reply: string; statement?: string;
      deliverables?: { project?: string | null; title?: string | null; after?: number[] | null }[]; notes?: string }) => {
      const request = requestOf(host, project, input.id)
      if (request.kind === 'escalation') {
        throw new Error(`Project request ${input.id} is escalated to the Orchestrator; orchestrator_escalation_decide decides it`)
      }
      // An accepted project request's work stays in this project (docs/012 D2), so a deliverable naming another project is refused here too.
      if (input.action === 'accept') {
        for (const [index, item] of (input.deliverables ?? []).entries()) {
          if (item.project && item.project !== project.id) throw new Error(`Deliverable ${index} belongs to project ${item.project}, not ${project.id}`)
        }
        // The structured plan reaches the Engine before the disposition's reply text, so an approved design creates the staged
        // Tickets, not one Ticket defaulted from the request (docs/012 D5, D7).
        approvals.get(host.store)?.plan(request.id, {
          ...input.statement ? { statement: input.statement } : {},
          deliverables: (input.deliverables ?? []).map(item => ({
            project: item.project ?? project.id,
            ...item.title ? { title: item.title } : {},
            ...item.after?.length ? { after: item.after } : {},
          })),
        })
      }
      const result = await host.lead.decide(request, input)
      return { ...projectRequestView(result.request), reply_delivered: result.delivered }
    },
  }), tool({
    name: 'lead_request_approval',
    description: 'After the design Ticket of an accepted architecture project request has ended, send its report to the root '
      + 'channel for a person\'s approval and mark the request awaiting-approval. The request then waits for a human reply.',
    schema: z.object({
      id: z.string().trim().min(1).describe('The accepted architecture project request id whose design Ticket ended.'),
    }).strict(),
    execute: async ({ id }: { id: string }) => {
      const engine = approvals.get(host.store)
      if (!engine) throw new Error('Lead approvals are not bound in this runtime')
      const request = requestOf(host, project, id)
      return { ...projectRequestView(engine.requestApproval(request.id)), approval_requested: true }
    },
  }), tool({
    name: 'lead_request_approve',
    description: 'Record a person\'s approval or rejection of an awaiting-approval architecture project request from their human '
      + 'reply on the root thread. Approval creates the implementation Request and its staged Tickets; rejection records it. '
      + 'When no human reply can be linked yet, the text still reaches the raiser and the request stays awaiting approval.',
    schema: z.object({
      id: z.string().trim().min(1).describe('The awaiting-approval architecture project request id.'),
      approved: z.boolean().describe('True when the person approved the design, false when they rejected it.'),
      text: z.string().trim().min(1).max(8_000).describe('The Lead\'s reply to the raiser, in the language of the request.'),
    }).strict(),
    execute: async ({ id, approved, text }: { id: string; approved: boolean; text: string }) => {
      const engine = approvals.get(host.store)
      if (!engine) throw new Error('Lead approvals are not bound in this runtime')
      const request = requestOf(host, project, id)
      if (!request.root) throw new Error(`Project request ${id} has no root thread to approve on`)
      const read = host.store.read
      if (!read) throw new Error('This runtime cannot read the root thread history')
      const since = request.proposal?.at
      // Store.read returns the latest triggers of a thread oldest first; the newest human one after the proposal is the answer.
      const answer = read.threadTriggers(request.root.thread_key, 50)
        .filter(trigger => trigger.human && (since === undefined || trigger.at >= since)).at(-1)
      if (!answer) {
        const result = await host.lead.reply(request, text)
        return { ...projectRequestView(result.request), approval_recorded: false,
          reason: 'No human reply on the root thread can be linked yet; the request stays awaiting approval.' }
      }
      if (approved) {
        const updated = engine.approve(request.id, { approved: true, trigger_id: answer.id })
        const result = await host.lead.reply(updated, text)
        return { ...projectRequestView(result.request), approval_recorded: true, reply_delivered: result.delivered }
      }
      // A rejected request accepts no reply, so record the answer to the raiser before the approval closes it.
      const acknowledged = await host.lead.reply(request, text)
      const updated = engine.approve(request.id, { approved: false, trigger_id: answer.id })
      return { ...projectRequestView(updated), approval_recorded: true, reply_delivered: acknowledged.delivered }
    },
  }), tool({
    name: 'lead_request_reply',
    description: 'Add a reply to an open project request without deciding it, when the raiser needs an answer rather than a '
      + 'disposition. The reply reaches the Session that raised the request when it still exists.',
    schema: z.object({
      id: z.string().trim().min(1).describe('The project request id.'),
      reply: z.string().trim().min(1).max(8_000).describe('The reply, in the language of the request.'),
    }).strict(),
    execute: async ({ id, reply }: { id: string; reply: string }) => {
      const result = await host.lead.reply(requestOf(host, project, id), reply)
      return { ...projectRequestView(result.request), reply_delivered: result.delivered }
    },
  }), tool({
    name: 'lead_request_complete',
    description: 'Mark an accepted project request completed with a summary, and tell the Session that raised it. The origin-channel '
      + 'result is reported separately.',
    schema: z.object({
      id: z.string().trim().min(1).describe('The accepted project request id.'),
      summary: z.string().trim().min(1).max(8_000).describe('What was completed, in the language of the request.'),
    }).strict(),
    execute: async ({ id, summary }: { id: string; summary: string }) => {
      const result = await host.lead.complete(requestOf(host, project, id), summary)
      return { ...projectRequestView(result.request), reply_delivered: result.delivered }
    },
  }), tool({
    name: 'lead_ticket_note',
    description: 'Add one fact or constraint to a live Ticket of this project, for its worker to read on the next turn. This grants '
      + 'no authority: it neither starts work nor answers a question. The Orchestrator sends this on a person\'s instruction.',
    schema: z.object({
      ticket_id: z.string().trim().min(1).max(200).describe('The live Ticket of this project.'),
      text: z.string().trim().min(1).max(2_000).describe('The fact or constraint, in the language of the work.'),
    }).strict(),
    execute: async ({ ticket_id, text }: { ticket_id: string; text: string }) => {
      ticketOf(host, project, ticket_id)
      ticketCommands(host).note(ticket_id, text)
      return { ticket_id, noted: true }
    },
  }), tool({
    name: 'lead_ticket_request_status',
    description: 'Ask a worker of this project that reported waiting for a status report, once. It only queues the request that a live worker '
      + 'reads on its next turn; the Orchestrator sends this on a person\'s instruction.',
    schema: z.object({
      ticket_id: z.string().trim().min(1).max(200).describe('The live Ticket of this project.'),
    }).strict(),
    execute: async ({ ticket_id }: { ticket_id: string }) => {
      ticketOf(host, project, ticket_id)
      const requested = ticketCommands(host).requestStatus(ticket_id)
      return requested ? { ticket_id, requested } : { ticket_id, requested, reason: 'The worker is not waiting for a status report.' }
    },
  }), tool({
    name: 'lead_ticket_retry',
    description: 'End a stuck Assignment of this project and start a new one, when the person asked for a retry. The Engine still '
      + 'refuses a Ticket whose latest report awaits a person\'s answer.',
    schema: z.object({
      ticket_id: z.string().trim().min(1).max(200).describe('The live Ticket of this project.'),
    }).strict(),
    execute: async ({ ticket_id }: { ticket_id: string }) => {
      ticketOf(host, project, ticket_id)
      ticketCommands(host).retry(ticket_id)
      return { ticket_id, retried: true }
    },
  }), tool({
    name: 'lead_ticket_stop',
    description: 'Stop a live Ticket of this project at the person\'s instruction: its assignments end and its worker stops. This '
      + 'does not complete or drop the Ticket; a person decides what happens to it next.',
    schema: z.object({
      ticket_id: z.string().trim().min(1).max(200).describe('The live Ticket of this project.'),
      reason: z.string().trim().min(1).max(500).optional().describe('Why the person stopped it, recorded with the ending.'),
    }).strict(),
    execute: async ({ ticket_id, reason }: { ticket_id: string; reason?: string }) => {
      ticketOf(host, project, ticket_id)
      ticketCommands(host).stop(ticket_id, reason ?? 'Stopped from the project Lead.')
      return { ticket_id, stopped: true }
    },
  }), tool({
    name: 'lead_ticket_attach',
    description: 'Attach a Trigger of this project to a live Ticket of this project at the person\'s instruction. The worker reads '
      + 'the new input on its next turn; attaching the same message twice is refused by the Engine.',
    schema: z.object({
      ticket_id: z.string().trim().min(1).max(200).describe('The live Ticket of this project.'),
      trigger_id: z.string().trim().min(1).max(200).describe('The Trigger to attach, from this project\'s repository.'),
      note: z.string().trim().min(1).max(2_000).optional().describe('Why the person attached this message.'),
    }).strict(),
    execute: async ({ ticket_id, trigger_id, note }: { ticket_id: string; trigger_id: string; note?: string }) => {
      ticketOf(host, project, ticket_id)
      ticketCommands(host).attach(ticket_id, trigger_id, note)
      return { ticket_id, trigger_id, attached: true }
    },
  }), tool({
    name: 'lead_instruction_reply',
    description: 'Answer an instruction the Orchestrator relayed for one of this project\'s Tickets, and act on it when it '
      + 'applies: attach a Trigger, stop the Ticket, retry a stuck Assignment, pass a note to the worker, or ask for a status '
      + 'report. One reply per instruction; the Ticket must belong to this project.',
    schema: z.object({
      request_id: z.string().trim().min(1).max(300).describe('The instruction request id from the Orchestrator.'),
      ticket_id: z.string().trim().min(1).max(200).describe('The Ticket the instruction names.'),
      text: z.string().trim().min(1).max(8_000).describe('The Lead\'s answer, in the language of the work.'),
    }).strict(),
    execute: async ({ request_id, ticket_id, text }: { request_id: string; ticket_id: string; text: string }) => {
      const message = host.store.leads.getByRequest('lead', request_id)
      if (!message || message.kind !== 'instruction') throw new Error(`Unknown instruction ${request_id}`)
      if (message.project !== project.id) throw new Error(`Instruction ${request_id} belongs to project ${message.project}, not ${project.id}`)
      if (message.ticketId !== ticket_id) throw new Error(`Instruction ${request_id} is not about Ticket ${ticket_id}`)
      if (message.ackAt !== undefined) throw new Error(`Instruction ${request_id} was already answered`)
      ticketOf(host, project, ticket_id)
      const instruction = JSON.parse(message.body) as { action?: string; trigger_id?: string; text?: string; reason?: string }
      const commands = ticketCommands(host)
      const action = instruction.action
      if (action === 'note') commands.note(ticket_id, instruction.text ?? text)
      else if (action === 'retry') commands.retry(ticket_id)
      else if (action === 'stop') commands.stop(ticket_id, instruction.reason)
      else if (action === 'attach') {
        if (instruction.trigger_id === undefined) throw new Error(`Instruction ${request_id} names no Trigger to attach`)
        commands.attach(ticket_id, instruction.trigger_id, text)
      } else if (action === 'status') {
        if (!commands.requestStatus(ticket_id)) throw new Error('The worker is not waiting for a status report')
      } else throw new Error(`Instruction ${request_id} names an unknown action`)
      host.store.leads.ack(message.id)
      // The Orchestrator reads the answer as a relay notice at its next turn; the durable record above remains for audit.
      host.store.leads.send({ project: project.id, kind: 'notice', from: 'lead', to: 'orchestrator',
        requestId: `lead-instruction-answer:${request_id}`, ticketId: ticket_id, body: text })
      return { replied: true, action }
    },
  }), tool({
    name: 'lead_notify_worker',
    description: 'Relay a short notice to a worker or reviewer Session of this project, by Session id, after the work it was doing '
      + 'ended — for example when a pull request merged. Use one call per Session. This is a relay only: it neither starts work '
      + 'nor grants the recipient new authority, and it cannot reach Sessions of another project.',
    schema: z.object({
      session: z.string().trim().min(1).max(200).describe('A worker or reviewer Session id of this project, such as worker-<ticket> or review-<ticket>.'),
      text: z.string().trim().min(1).max(2_000).describe('The notice, in the language of the work.'),
    }).strict(),
    execute: async ({ session, text }: { session: string; text: string }) => host.notify(session, text),
  }), tool({
    name: 'lead_report',
    description: 'Relay a worker report you reviewed upward to the Orchestrator. Take the report_id from the worker-report '
      + 'message; the Orchestrator receives your relay with the worker\'s original report and your optional note. Reports reach '
      + 'the Orchestrator only through this tool: do not start new work or change the external thread, and never relay a report '
      + 'you did not review.',
    schema: z.object({
      report_id: z.string().trim().min(1).max(200).describe('The report_id from the worker-report message.'),
      note: z.string().trim().min(1).max(2_000).optional().describe('Your review: what you checked and what the Orchestrator should know.'),
    }).strict(),
    execute: async ({ report_id, note }: { report_id: string; note?: string }) => host.report(report_id, note),
  })]
}
