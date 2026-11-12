/** Lead-mediated ticket instructions: the Orchestrator asks, the project Lead decides and acts, and nothing acts directly. */
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
