/** Lead-mediated ticket instructions: the Orchestrator asks, the project Lead decides and acts, and nothing acts directly. */
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** The texts delivered to the project's Lead Session. */
const leadTexts = (): string[] => h.deliveries.mock.calls.map(([call]) => call)
  .filter(call => call.sessionId === 'lead-default').map(call => call.text)

it('takes the Orchestrator note instruction through the project Lead and applies it', async () => {
  const accepted = await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
  const asked = await h.runTool(h.runtime.masterId, 'orchestrator_lead_instruction', {
    action: 'note', ticket_id: accepted.ticket.id, text: 'Please include the failing test.',
  }) as { request_id: string; delivered: boolean }
  expect(asked.delivered).toBe(true)
  expect(leadTexts().some(text => text.includes(asked.request_id))).toBe(true)

  const replied = await h.runTool('lead-default', 'lead_instruction_reply', {
    request_id: asked.request_id, ticket_id: accepted.ticket.id, text: 'Noted for the next turn.',
  }) as { replied: boolean }
  expect(replied.replied).toBe(true)
  const stored = h.runtime.store.tickets.get(accepted.ticket.id)!
  expect(stored.inputs.some(input => input.kind === 'note' && input.text.includes('failing test'))).toBe(true)
  expect(h.runtime.store.leads.getByRequest('lead', asked.request_id)!.ackAt).toBeDefined()

  await expect(h.runTool('lead-default', 'lead_instruction_reply', {
    request_id: asked.request_id, ticket_id: accepted.ticket.id, text: 'Again.',
  })).rejects.toThrow(/already answered/)
})

it('keeps an instruction out of the worker Session and offers no direct Orchestrator-to-worker tool', async () => {
  const accepted = await h.acceptedTicket(feishu('2', '@bot 修一下回归'), 'answer')
  const asked = await h.runTool(h.runtime.masterId, 'orchestrator_lead_instruction', {
    action: 'note', ticket_id: accepted.ticket.id, text: 'Only the Lead reads this note.',
  }) as { request_id: string; delivered: boolean }
  expect(asked.delivered).toBe(true)
  const workerTexts = h.deliveries.mock.calls.map(([call]) => call)
    .filter(call => call.sessionId === accepted.sessionId).map(call => call.text)
  expect(workerTexts.some(text => text.includes('Only the Lead reads this note'))).toBe(false)
  // ADR-0008 removed the direct note tool; the only cross-layer instruction path is the Lead one above.
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_ticket_note', {
    ticket_id: accepted.ticket.id, text: 'bypass the Lead',
  })).rejects.toThrow()
})

it('delivers a worker report to its project Lead, which forwards it to the Orchestrator', async () => {
  const accepted = await h.acceptedTicket(feishu('3', '@bot 审查这个仓库'), 'answer')
  const raised = await h.runTool(accepted.sessionId, 'request_create', {
    title: 'Need a decision', instruction: 'The review found a decision for the Lead.', evidence: 'The page layout is open.',
  }) as { id: string }
  h.deliveries.mockClear()
  await h.runTool(accepted.sessionId, 'orchestrator_report', {
    state: 'ready', summary: 'found a decision for the lead', requests: [raised.id],
  })
  // The actionable report is a durable Lead message, and so is the worker's report the Lead reviews.
  expect(h.runtime.store.leads.getByRequest('lead', `worker-report:${raised.id}`)).toMatchObject({ kind: 'report', to: 'lead' })
  const delivered = h.runtime.store.leads.list('default', 50).find(item => item.requestId.startsWith('executor-report:'))!
  expect(delivered).toMatchObject({ kind: 'report', from: 'executor', to: 'lead' })
  // Reports travel stepwise: the Orchestrator hears nothing until the Lead forwards the report upward.
  expect(h.relays(h.runtime.masterId)).toHaveLength(0)
  const lead = await h.runtime.sessions.ensureLead('default', join(h.directory, 'default'), 'Default')
  const forwarded = await h.runTool(lead.id, 'lead_report', {
    report_id: delivered.requestId.slice('executor-report:'.length), note: 'Reviewed: the layout question is real.',
  }) as { reported: boolean }
  expect(forwarded.reported).toBe(true)
  expect(h.runtime.store.leads.get(delivered.id)!.ackAt).toBeDefined()
  await h.runtime.pump()
  await h.runtime.idle()
  const relayed = h.relays(h.runtime.masterId)
  expect(relayed).toHaveLength(1)
  expect(relayed[0]).toMatchObject({ kind: 'lead_report' })
})
