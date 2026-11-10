/**
 * The Lead activation boundary: prompts a project's Lead Session when a worker raises a Project Request or reports
 * one unanswered, and enforces the mandatory reply after each Lead turn (docs/012 D3-D5).
 *
 * The Store's `lead_message` records are the durable source of truth: a question or report is written before its
 * prompt, so a crash leaves an undelivered row the next startup can recover, and every reminder is a row too, which
 * bounds the attempts without in-memory state. After two reminders a request is marked `needs-attention` in the
 * Store, visible to the panel and to the Orchestrator; it is never silently dropped.
 */
import { key, projectRequestOpen, type Assignment, type EngineForMainSession, type ProjectRequest, type Ticket } from '../core/index.ts'
import type { LeadMessage } from './lead-messages.ts'
import type { Project } from '../projects.ts'
import type { Store } from './store.ts'

/** The Engine project-request commands the Lead tools and the reply enforcement use. */
export type LeadEngine = Pick<EngineForMainSession, 'disposeProjectRequest' | 'replyProjectRequest' | 'completeProjectRequest'>

/** Host dependencies of the Lead dispatch. */
export interface LeadDispatchHost {
  readonly store: Pick<Store, 'leads' | 'projectRequests' | 'settings' | 'tickets'>
  /** The Engine's project-request commands; assigned after the Runtime composes the Engine. */
  engine(): LeadEngine
  /** Resolves or creates a project's Lead Session and returns its Session id. */
  ensureLead(project: Project): Promise<string>
  /** Delivers a message to a Session once per request id; throws when that Session no longer exists. */
  prompt(sessionId: string, requestId: string, text: string): Promise<void>
  /** Injects a notice into the main Session, which the Orchestrator reads. */
  notify(name: string, value: Record<string, unknown>, summary: string): void
  /** Logs a delivery failure without failing the worker's report or request. */
  warn?(message: string, error: unknown): void
}

/** One unanswered Project Request a Lead owes a reply for. */
export interface LeadDemand { key: string; text: string }
/** The most reminders one unanswered set of items receives before it is marked `needs-attention`. */
const REMINDERS = 2
/** How many recent records a listing or reminder count reads. */
const RECENT = 500

/** The durable message a raised request writes for its Lead. */
const questionId = (request: string): string => `project-request:${request}`
/** The durable message a worker report writes for each unanswered request it names. */
const reportId = (request: string): string => `worker-report:${request}`
/** The durable record that a request stayed unanswered after the bounded reminders. */
const attentionId = (request: string): string => `lead-attention:${request}`
/** The request-id family of a set of demands' reminders. */
const reminderPrefix = (project: string, cycle: string): string => `lead-reminder:${project}:${cycle}:`

/** A Project Request as the Lead tools read it, without the storage details. */
export function projectRequestView(request: ProjectRequest) {
  const { id, project, kind, title, instruction, raised_by, root, status, replies, decision, request_id, tickets, derived, approval } = request
  return { id, project, kind, title, instruction, raised_by, ...root ? { root } : {}, status, replies, ...decision ? { decision } : {},
    ...request_id ? { request_id } : {}, tickets, derived, ...approval ? { approval } : {},
    created_at: request.created_at, updated_at: request.updated_at, ...request.completed_at ? { completed_at: request.completed_at } : {} }
}

/**
 * Delivers Lead prompts and enforces the mandatory reply. A worker's failed prompt never fails its request or
 * report: the durable record stays waiting and `reconcile` retries it at the next startup.
 */
export class LeadDispatch {
  constructor(private readonly host: LeadDispatchHost) {}

  /** Prompts the project's Lead about a request a worker just raised. */
  async requestRaised(request: ProjectRequest): Promise<void> {
    const project = this.projectOf(request.project)
    if (!project) return
    try {
      const session = await this.host.ensureLead(project)
      const message = this.host.store.leads.send({ project: project.id, kind: 'question', from: 'orchestrator', to: 'lead',
        requestId: questionId(request.id), ...(request.raised_by.ticket ? { ticketId: request.raised_by.ticket } : {}),
        body: this.questionText(request) })
      await this.host.prompt(session, message.requestId, message.body)
      this.host.store.leads.deliver(message.id)
    } catch (error) {
      this.host.warn?.(`could not prompt the Lead about project request ${request.id}`, error)
    }
  }

  /**
   * Tells the project's Lead that a followed pull request ended the Ticket, so the Lead relays the end to the Ticket's
   * worker Sessions with `lead_notify_worker` (docs/010). Durable like every Lead prompt: the message is written before
   * its prompt, and a failed prompt is retried by `reconcile` at the next startup.
   */
  async pullEnded(ticket: Ticket, receipt: { number: number; url: string; outcome: 'merged' | 'closed' }): Promise<void> {
    if (ticket.project === undefined || ticket.project === '') return
    const project = this.projectOf(ticket.project)
    if (!project) return
    const requestId = `pull-end:${ticket.id}`
    if (this.host.store.leads.getByRequest('lead', requestId)) return
    const verb = receipt.outcome === 'merged' ? 'merged' : 'was closed without merging'
    const workers = [`worker-${ticket.id}`, ...(ticket.review?.sessionId ? [ticket.review.sessionId] : [])]
    const body = `Pull request #${receipt.number} (${receipt.url}) ${verb}; this ended Ticket ${ticket.id} "${ticket.title}" in project ${project.id}.\n`
      + `Relay this to the Ticket's worker Session(s) with the lead_notify_worker tool, one call per Session: ${workers.join(', ')}. `
      + 'Tell them the work is closed, no further action is expected, and they should not start new work. '
      + 'Do not open work or change the external thread unless a person asks.'
    try {
      const session = await this.host.ensureLead(project)
      const message = this.host.store.leads.send({ project: project.id, kind: 'notice', from: 'orchestrator', to: 'lead',
        requestId, ticketId: ticket.id, body })
      await this.host.prompt(session, requestId, body)
      this.host.store.leads.deliver(message.id)
    } catch (error) {
      this.host.warn?.(`could not tell the Lead of project ${project.id} that Ticket ${ticket.id}'s pull request ended`, error)
    }
  }

  /**
   * Tells the project's Lead that a running Assignment has stalled: its worker Session stayed idle past the Runtime's
   * threshold without a new Report. The Runtime already wrote the waiting Report that raises the Ticket's attention; this
   * durable notice asks the Lead to inspect the Session and either nudge it or end the work. One notice per Assignment,
   * also when the threshold is crossed again in another process, because the Lead message's request id deduplicates it.
   */
  async stalled(ticket: Ticket, assignment: Assignment, idleSince: string): Promise<void> {
    if (ticket.project === undefined || ticket.project === '') return
    const project = this.projectOf(ticket.project)
    if (!project) return
    const requestId = `stalled:${ticket.id}:${assignment.id}`
    if (this.host.store.leads.getByRequest('lead', requestId)) return
    const worker = `worker-${ticket.id}`
    const last = assignment.report ? ` Its last Report was ${assignment.report.state}: ${assignment.report.summary}` : ' It has not reported yet.'
    const body = `Ticket ${ticket.id} "${ticket.title}" in project ${project.id} has Assignment ${assignment.id} running, but its worker Session `
      + `${worker} has been idle since ${idleSince}.${last}\n`
      + `Inspect the Session and its latest status. Use the lead_notify_worker tool to ask ${worker} to continue or to report; `
      + 'or tell the Orchestrator to stop the Ticket if the work should end. Do not start new work for this Ticket yourself.'
    try {
      const session = await this.host.ensureLead(project)
      const message = this.host.store.leads.send({ project: project.id, kind: 'notice', from: 'orchestrator', to: 'lead',
        requestId, ticketId: ticket.id, body })
      await this.host.prompt(session, requestId, body)
      this.host.store.leads.deliver(message.id)
    } catch (error) {
      this.host.warn?.(`could not tell the Lead of project ${project.id} that Ticket ${ticket.id}'s Assignment ${assignment.id} stalled`, error)
    }
  }

  /**
   * Records the worker's report for each unanswered request it names and prompts the Lead once. The requests are the
   * durable record; the report messages make an unanswered worker report visible in `lead_requests` too.
   */
  async reported(ticket: Ticket, report: { state: string; summary: string }, requestIds: readonly string[]): Promise<void> {
    const project = this.projectOf(ticket.project)
    if (!project) return
    const unanswered = requestIds.flatMap(id => {
      const request = this.host.store.projectRequests.get(id)
      return request && request.replies.length === 0 && projectRequestOpen(request.status) ? [request] : []
    })
    if (!unanswered.length) return
    try {
      const session = await this.host.ensureLead(project)
      const messages: LeadMessage[] = []
      for (const request of unanswered) {
        messages.push(this.host.store.leads.send({ project: project.id, kind: 'report', from: 'orchestrator', to: 'lead',
          requestId: reportId(request.id), ...(request.raised_by.ticket ? { ticketId: request.raised_by.ticket } : {}),
          body: this.reportText(request, ticket, report) }))
      }
      const text = this.reportPrompt(unanswered, ticket, report)
      await this.host.prompt(session, `worker-report-prompt:${ticket.id}:${ticket.assignments.at(-1)?.id ?? 'none'}`, text)
      for (const message of messages) this.host.store.leads.deliver(message.id)
    } catch (error) {
      this.host.warn?.(`could not prompt the Lead about worker report on ticket ${ticket.id}`, error)
    }
  }

  /** Records the Lead's disposition of a request, acknowledges its prompts, and tells the Session that raised it. */
  async decide(request: ProjectRequest, input: { action: 'accept' | 'reject' | 'needs-info'; reply: string; notes?: string }):
  Promise<{ request: ProjectRequest; delivered: boolean }> {
    const notes = planNotes(input)
    const updated = this.host.engine().disposeProjectRequest(request.id, { by: `lead-${request.project}`, action: input.action,
      text: input.reply, ...(notes ? { notes } : {}) })
    this.answered(updated)
    const delivered = await this.deliver(updated, `Your project request ${updated.id} was ${input.action}: ${input.reply}`)
    return { request: updated, delivered }
  }

  /** Records another Lead reply on an open request and tells the Session that raised it. */
  async reply(request: ProjectRequest, reply: string): Promise<{ request: ProjectRequest; delivered: boolean }> {
    const updated = this.host.engine().replyProjectRequest(request.id, { by: `lead-${request.project}`, text: reply })
    this.answered(updated)
    const delivered = await this.deliver(updated, `Your project request ${updated.id} received a reply: ${reply}`)
    return { request: updated, delivered }
  }

  /** Marks an accepted request completed and tells the Session that raised it. The origin-channel aggregate is D6. */
  async complete(request: ProjectRequest, summary: string): Promise<{ request: ProjectRequest; delivered: boolean }> {
    const updated = this.host.engine().completeProjectRequest(request.id, { by: `lead-${request.project}`, text: summary })
    this.answered(updated)
    const delivered = await this.deliver(updated, `Your project request ${updated.id} is complete: ${summary}`)
    return { request: updated, delivered }
  }

  /**
   * Called when a Lead turn ends: while unanswered project requests remain, sends a reminder listing them, at most
   * twice, and then records them as `needs-attention` instead of prompting again. A new request or a recovered
   * delivery starts a new cycle.
   */
  async turnEnded(projectId: string): Promise<void> {
    const project = this.projectOf(projectId)
    if (!project) return
    const demands = this.demands(projectId)
    if (!demands.length) return
    const cycle = key('lead-demands', projectId, ...demands.map(demand => demand.key)).slice(0, 12)
    const reminders = this.reminderCount(projectId, cycle)
    try {
      if (reminders >= REMINDERS) {
        this.markAttention(project, demands)
        return
      }
      const session = await this.host.ensureLead(project)
      const n = reminders + 1
      const requestId = `${reminderPrefix(projectId, cycle)}${n}`
      const message = this.host.store.leads.send({ project: projectId, kind: 'notice', from: 'orchestrator', to: 'lead', requestId,
        body: this.reminderText(project, demands, n) })
      await this.host.prompt(session, requestId, message.body)
      this.host.store.leads.deliver(message.id)
    } catch (error) {
      this.host.warn?.(`could not remind the Lead of project ${projectId}`, error)
    }
  }

  /** Retries prompts a crash left undelivered, then continues the reply enforcement from the durable records. */
  async reconcile(): Promise<void> {
    for (const project of this.host.store.settings().executor.projects) {
      const waiting = this.host.store.leads.waiting('lead', project.id)
        .filter(message => message.kind !== 'assignment' && !message.requestId.startsWith('lead-attention:'))
      const demands = this.demands(project.id)
      if (!waiting.length && !demands.length) continue
      try {
        if (waiting.length) {
          const session = await this.host.ensureLead(project)
          for (const message of waiting.slice(-20)) {
            await this.host.prompt(session, `lead-recovered:${message.id}`, message.body)
            this.host.store.leads.deliver(message.id)
          }
        }
        // A recovered message starts a Lead turn; that turn's end checks the reply before a reminder is needed.
        if (!waiting.length && demands.length) await this.turnEnded(project.id)
      } catch (error) {
        this.host.warn?.(`could not recover Lead messages for project ${project.id}`, error)
      }
    }
  }

  /** The unanswered Project Requests of a project, as the Lead tools list them. */
  unanswered(projectId: string): ProjectRequest[] {
    return this.host.store.projectRequests.list(projectId)
      .filter(request => request.status === 'pending' && request.replies.length === 0)
  }

  /** The worker-report records still awaiting a reply, newest first. */
  unansweredReports(projectId: string): LeadMessage[] {
    return this.host.store.leads.list(projectId, RECENT)
      .filter(message => message.kind === 'report' && message.ackAt === undefined)
  }

  /** The durable `needs-attention` records of a project, newest first. */
  attention(projectId: string): LeadMessage[] {
    return this.host.store.leads.list(projectId, RECENT)
      .filter(message => message.kind === 'notice' && message.requestId.startsWith('lead-attention:') && message.ackAt === undefined)
  }

  /** Acknowledges every prompt a Lead reply answered, so the reply enforcement sees the request as handled. */
  private answered(request: ProjectRequest): void {
    this.ack(questionId(request.id))
    this.ack(reportId(request.id))
    this.ack(attentionId(request.id))
  }

  private ack(requestId: string): void {
    const message = this.host.store.leads.getByRequest('lead', requestId)
    if (message) this.host.store.leads.ack(message.id)
  }

  /** The unanswered requests of a project, oldest first: every pending request whose replies are still empty. */
  private demands(projectId: string): LeadDemand[] {
    return this.unanswered(projectId).map(request => ({ key: `request:${request.id}`,
      text: `${request.id}: ${request.title} (${request.kind}, raised by ${request.raised_by.session})` }))
  }

  private reminderCount(projectId: string, cycle: string): number {
    const prefix = reminderPrefix(projectId, cycle)
    return this.host.store.leads.list(projectId, RECENT).filter(message => message.requestId.startsWith(prefix)).length
  }

  private markAttention(project: Project, demands: readonly LeadDemand[]): void {
    for (const demand of demands) {
      const id = demand.key.slice('request:'.length)
      const request = this.host.store.projectRequests.get(id)
      if (!request) continue
      if (this.host.store.leads.getByRequest('lead', attentionId(request.id))) continue
      this.host.store.leads.send({ project: project.id, kind: 'notice', from: 'orchestrator', to: 'lead',
        requestId: attentionId(request.id), ...(request.raised_by.ticket ? { ticketId: request.raised_by.ticket } : {}),
        body: `Project request ${request.id} needs attention: its Lead did not reply after ${REMINDERS} reminders.\n${request.title}` })
      // The panel and the Orchestrator see this notice; the request itself stays pending, never dropped.
      this.host.notify(key('lead-attention', request.id), { lead_attention: { project: project.id, request_id: request.id,
        title: request.title, kind: request.kind, status: request.status, raised_by: request.raised_by } },
      `Project request ${request.id} needs attention: the Lead did not reply`)
    }
  }

  private async deliver(request: ProjectRequest, text: string): Promise<boolean> {
    try {
      await this.host.prompt(request.raised_by.session, `project-request-reply:${request.id}:${request.replies.length}`, text)
      return true
    } catch (error) {
      this.host.warn?.(`could not deliver the Lead reply to ${request.raised_by.session}`, error)
      return false
    }
  }

  private projectOf(project: string | undefined): Project | undefined {
    return project === undefined ? undefined : this.host.store.settings().executor.projects.find(item => item.id === project)
  }

  private questionText(request: ProjectRequest): string {
    return [`A worker raised project request ${request.id} (${request.kind}): ${request.title}`, request.instruction,
      `Reply with lead_request_decide (a non-empty reply is required) or lead_request_reply. The request stays pending until you do.`]
      .join('\n\n')
  }

  private reportText(request: ProjectRequest, ticket: Ticket, report: { state: string; summary: string }): string {
    return [`Worker on ticket ${ticket.id} (${ticket.title}) reported ${report.state}: ${report.summary}`,
      `Project request ${request.id} (${request.title}) raised by that worker still has no Lead reply.`, 'Answer it with lead_request_decide or lead_request_reply.']
      .join('\n\n')
  }

  private reportPrompt(requests: readonly ProjectRequest[], ticket: Ticket, report: { state: string; summary: string }): string {
    return [`A worker finished a report on ticket ${ticket.id} (${ticket.title}) and raised requests that await your reply:`,
      ...requests.map(request => `- ${request.id}: ${request.title}`), 'Answer each with lead_request_decide or lead_request_reply.'].join('\n')
  }

  private reminderText(project: Project, demands: readonly LeadDemand[], n: number): string {
    return [`Unanswered project requests in project ${project.name} (${project.id}); reminder ${n} of ${REMINDERS}:`,
      ...demands.map(demand => `- ${demand.text}`), 'Reply to each with lead_request_decide (a non-empty reply is required) or lead_request_reply.'].join('\n')
  }
}

/** The plan an accept carries, recorded in the decision's notes until the Engine can create its Tickets (docs/012 D5). */
function planNotes(input: { statement?: string; deliverables?: readonly { title?: string | null; project?: string | null; after?: readonly number[] | null }[]; notes?: string }): string | undefined {
  const lines: string[] = []
  if (input.statement?.trim()) lines.push(`Statement: ${input.statement.trim()}`)
  if (input.deliverables?.length) lines.push(['Deliverables:', ...input.deliverables.map((item, index) =>
    `- ${index}: ${item.title?.trim() || 'untitled'}${item.project ? ` in ${item.project}` : ''}${item.after?.length ? ` after ${item.after.join(', ')}` : ''}`)].join('\n'))
  if (input.notes?.trim()) lines.push(input.notes.trim())
  return lines.join('\n\n') || undefined
}
