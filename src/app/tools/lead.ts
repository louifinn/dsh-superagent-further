/** Lead application tools: the project a Lead serves, and the Project Requests it must answer. */
import { z } from 'zod'
import { ticketStage, type ProjectRequest, type ProjectRequestPlan, type Ticket } from '../../core/index.ts'
import type { Project } from '../../projects.ts'
import type { LeadDispatch } from '../lead-dispatch.ts'
import { projectRequestView } from '../lead-dispatch.ts'
import type { Store } from '../store.ts'
import { tool, type Tool } from './tool.ts'

/** The Engine commands the approval tools need; the runtime binds them because a Lead Session only holds its dispatch. */
export interface LeadApprovalHost {
  plan(id: string, plan: ProjectRequestPlan): ProjectRequest
  requestApproval(id: string): ProjectRequest
  approve(id: string, input: { approved: boolean; trigger_id: string }): ProjectRequest
}
/** Bind the Engine-backed approval commands to one Store, as the runtime and the tool tests do before serving a Lead. */
const approvals = new WeakMap<object, LeadApprovalHost>()
export function bindLeadApprovals(store: object, host: LeadApprovalHost): void { approvals.set(store, host) }

/** Host dependencies of the Lead tools: the Store's project records, its optional read-side thread history, and the Lead dispatch. */
export interface LeadToolsHost {
  readonly store: Pick<Store, 'tickets' | 'leads' | 'projectRequests'> & { readonly read?: Store['read'] }
  readonly lead: LeadDispatch
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
 * The tools a project's Lead Session gets. `lead_status` and `lead_requests` read the project; the other three record
 * the mandatory reply: a disposition (with the plan an accept carries), an extra reply, or completion.
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
  })]
}
