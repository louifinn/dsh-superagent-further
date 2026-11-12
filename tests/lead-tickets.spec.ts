/** The Lead's own ticket tools: a project Lead manages the live tickets of its project, and nothing else. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

it('lets the project Lead note its own ticket without the Orchestrator acting on it', async () => {
  const accepted = await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
  expect(h.tools.get('lead-default')!.has('lead_ticket_note')).toBe(true)

  const noted = await h.runTool('lead-default', 'lead_ticket_note', { ticket_id: accepted.ticket.id, text: 'Please include the failing test.' }) as { noted: boolean }
  expect(noted.noted).toBe(true)
  const stored = h.runtime.store.tickets.get(accepted.ticket.id)!
  expect(stored.inputs.some(input => input.kind === 'note' && input.text.includes('failing test'))).toBe(true)

  await expect(h.runTool('lead-default', 'lead_ticket_note', { ticket_id: 'tkt-unknown', text: 'x' }))
    .rejects.toThrow(/Unknown Ticket/)
})

it('refuses a live ticket that belongs to another project', async () => {
  await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
  const foreign = await h.acceptedTicket(feishu('2', '@bot 再做一单'), 'answer')
  const stored = h.runtime.store.tickets.get(foreign.ticket.id)!
  h.runtime.store.tickets.save({ ...stored, project: 'elsewhere' })

  await expect(h.runTool('lead-default', 'lead_ticket_retry', { ticket_id: foreign.ticket.id }))
    .rejects.toThrow(/belongs to project elsewhere/)
})
