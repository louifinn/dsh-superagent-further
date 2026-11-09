/** The project-request tools and the Lead activation boundary: worker requests, Lead replies, and bounded reminders. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Ends the Lead's current turn the way DSH does, and lets the activation-boundary handler run. */
const endLeadTurn = async (): Promise<void> => {
  h.agents.get('lead-default')!.cancel()
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** The messages delivered to the project's Lead Session. */
const leadTexts = (): string[] => h.deliveries.mock.calls.map(([call]) => call)
  .filter(call => call.sessionId === 'lead-default').map(call => call.text)

/** A setup with one accepted ticket whose worker raises `title`. */
const raised = async (title = 'Add a project status page') => {
  const accepted = await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
  const request = await h.runTool(accepted.sessionId, 'request_create', {
    title, instruction: 'Build a page that lists each project\'s open work.', evidence: 'The overview only shows tickets.',
  }) as { id: string; status: string }
  return { ...accepted, request }
}

it('raises one project request per worker title, prompts the project Lead and lists it there', async () => {
  const { ticket, request } = await raised()
  expect(request.id).toMatch(/^prq-[0-9a-f]{8}$/)
  expect(request.status).toBe('pending')
  const stored = h.runtime.store.projectRequests.get(request.id)!
  expect(stored).toMatchObject({ project: 'default', title: 'Add a project status page', kind: 'work', status: 'pending', replies: [], tickets: [], derived: [],
    raised_by: { session: `worker-${ticket.id}`, ticket: ticket.id } })
  expect(stored.raised_by.assignment).toBe(ticket.assignments.at(-1)!.id)
  expect(stored.instruction).toContain('Evidence: The overview only shows tickets.')
  expect(stored.root).toMatchObject({ request_id: ticket.requestId, trigger_id: ticket.origin.triggerId })
  expect(leadTexts().filter(text => text.includes(request.id))).toHaveLength(1)
  expect(h.tools.get('lead-default')!.has('lead_requests')).toBe(true)
  const listed = await h.runTool('lead-default', 'lead_requests', {}) as { requests: Record<string, unknown>[]; unanswered: Record<string, unknown>[] }
  expect(listed.requests).toHaveLength(1)
  expect(listed.requests[0]).toMatchObject({ id: request.id, project: 'default', status: 'pending', raised_by: { ticket: ticket.id } })
  expect(listed.unanswered.map(item => item.id)).toEqual([request.id])

  // A duplicate title returns the open request instead of raising another, and does not prompt the Lead twice.
  const before = leadTexts().length
  expect(await h.runTool(`worker-${ticket.id}`, 'request_create', { title: 'Add a project status page', instruction: 'Again.' }))
    .toEqual({ id: request.id, status: 'pending' })
  expect(h.runtime.store.projectRequests.list('default')).toHaveLength(1)
  expect(leadTexts()).toHaveLength(before)

  // A derived request names its parent, so the Lead reads it on that request and follows the same root thread.
  const child = await h.runTool(`worker-${ticket.id}`, 'request_create',
    { title: 'Choose the page layout', instruction: 'Which layout?', parent: request.id }) as { id: string }
  expect(h.runtime.store.projectRequests.get(child.id)).toMatchObject({ root: { project_request_id: request.id, request_id: ticket.requestId,
    trigger_id: ticket.origin.triggerId } })
  expect(h.runtime.store.projectRequests.get(request.id)!.derived).toEqual([child.id])
})

it('refuses a finished report that leaves a raised request unanswered, and names the requests it answers', async () => {
  const { ticket, sessionId, request } = await raised()
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' }))
    .rejects.toThrow(`Name the unanswered project requests this report leaves behind in requests: ${request.id}`)
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.', requests: ['prq-00000000'] }))
    .rejects.toThrow('was not raised by this ticket')
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.', requests: [request.id] }))
    .toMatchObject({ reported: true, requests: [request.id] })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  // The report message makes the unanswered worker report visible on the Lead's list.
  const listed = await h.runTool('lead-default', 'lead_requests', {}) as { reports: Record<string, unknown>[] }
  expect(listed.reports.map(item => item.request_id)).toContain(request.id)
  expect(leadTexts().some(text => text.includes('raised requests that await your reply'))).toBe(true)
})

it('decides, replies to and completes a request with the mandatory non-empty reply', async () => {
  const { sessionId, ticket, request } = await raised()
  await expect(h.runTool('lead-default', 'lead_request_decide', { id: request.id, action: 'reject', reply: '  ' }))
    .rejects.toThrow('Too small')
  // The Engine refuses a whitespace-only reply even when a call reaches it without the tool's schema.
  await expect(h.runtime.sessions.lead.decide(h.runtime.store.projectRequests.get(request.id)!,
    { action: 'reject', reply: '   ' })).rejects.toThrow('needs text')
  await expect(h.runTool('lead-default', 'lead_request_decide', { id: request.id, action: 'accept', reply: 'Accepted.',
    deliverables: [{ project: 'other', title: 'Elsewhere' }] })).rejects.toThrow('belongs to project other, not default')
  const pending = await h.runTool('lead-default', 'lead_request_reply',
    { id: request.id, reply: 'I am reading the overview now.' }) as { status: string; replies: { text: string; by: string }[];
    reply_delivered: boolean }
  expect(pending.status).toBe('pending')
  expect(pending.reply_delivered).toBe(true)
  expect(pending.replies.at(-1)).toMatchObject({ by: 'lead-default', text: 'I am reading the overview now.' })

  const accepted = await h.runTool('lead-default', 'lead_request_decide', { id: request.id, action: 'accept', reply: 'Accepted; ship the overview page.',
    statement: 'Build the project overview page.', deliverables: [{ title: 'Overview page' }, { title: 'Project status API', after: [0] }],
    notes: 'Keep the existing style.' }) as { status: string; decision: { action: string; notes?: string }; reply_delivered: boolean }
  expect(accepted).toMatchObject({ status: 'accepted', reply_delivered: true, decision: { action: 'accept' } })
  expect(accepted.decision.notes).toContain('Statement: Build the project overview page.')
  expect(accepted.decision.notes).toContain('- 0: Overview page')
  expect(accepted.decision.notes).toContain('- 1: Project status API after 0')
  expect(accepted.decision.notes).toContain('Keep the existing style.')
  // The decision reached the raising worker Session, and the Lead's question prompt was acknowledged.
  expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === `worker-${ticket.id}`)
    .some(call => call.text.includes('Accepted; ship the overview page.'))).toBe(true)
  expect(h.runtime.store.leads.getByRequest('lead', `project-request:${request.id}`)?.ackAt).toBeDefined()

  const completed = await h.runTool('lead-default', 'lead_request_complete',
    { id: request.id, summary: 'The overview page is live.' }) as { status: string; completed_at?: string }
  expect(completed.status).toBe('completed')
  expect(completed.completed_at).toBeDefined()
  expect(h.runtime.store.projectRequests.get(request.id)!.replies.map(reply => reply.by))
    .toEqual(['lead-default', 'lead-default', 'lead-default'])
  expect(sessionId).toBe(`worker-${ticket.id}`)
})

it('reminds the Lead twice at the activation boundary, then marks the request needs-attention', async () => {
  const { request } = await raised()
  await endLeadTurn()
  expect(leadTexts().some(text => text.includes('reminder 1 of 2') && text.includes(request.id))).toBe(true)
  await endLeadTurn()
  expect(leadTexts().some(text => text.includes('reminder 2 of 2') && text.includes(request.id))).toBe(true)
  await endLeadTurn()
  expect(h.runtime.store.leads.getByRequest('lead', `lead-attention:${request.id}`)?.body)
    .toContain('needs attention: its Lead did not reply after 2 reminders')
  const listed = await h.runTool('lead-default', 'lead_requests', {}) as { attention: { request_id: string }[] }
  expect(listed.attention.map(item => item.request_id)).toEqual([request.id])
  // The bounded attempts stop: a fourth turn end adds no reminder and no second attention record.
  const before = leadTexts().filter(text => text.includes('reminder')).length
  await endLeadTurn()
  expect(leadTexts().filter(text => text.includes('reminder'))).toHaveLength(before)
  expect(h.runtime.store.leads.list('default').filter(message => message.requestId === `lead-attention:${request.id}`)).toHaveLength(1)
  // A reply answers the attention record too, so the notification is not repeated.
  await h.runTool('lead-default', 'lead_request_decide', { id: request.id, action: 'reject', reply: 'Not in this project.' })
  expect(h.runtime.store.leads.getByRequest('lead', `lead-attention:${request.id}`)?.ackAt).toBeDefined()
})

