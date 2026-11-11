/**
 * Retiring the worker whose report ended its Ticket. A ready report ends the Ticket inside the report tool call itself, while
 * that call's turn is still live: disposing the activation there aborted the tool call and told the Lead the worker had been
 * stopped before it finished (the 2026-11-10 incident). The Executor instead waits, bounded by `RETIRE_GRACE_MS`, for the
 * worker's turn to end and only cancels a turn that outlives the grace.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => {
  vi.useRealTimers()
  await h?.stop()
  h = undefined
})

/** Waits for the background retirement of `ticketId`, which the runtime's Executor tracks under that Ticket. */
const retired = (host: Host, ticketId: string) =>
  (host.runtime.executor as unknown as { stopped(id: string): Promise<void> }).stopped(ticketId)

it('retires a reporting worker after its turn ends instead of aborting the report call', async () => {
  h = await startRuntime()
  // An answer Ticket completes on its own ready report, so that report's transaction ends the Ticket mid-call.
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
  const agent = h.agents.get(sessionId)!
  expect(agent.status).toBe('running')
  // The report call completes even though it ended the Ticket: nothing cancelled the turn it belongs to.
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'the answer' }))
    .toMatchObject({ reported: true })
  expect(agent.cancel).not.toHaveBeenCalled()
  // The ending names its cause, and the activation still waits for the turn.
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'executor', outcome: 'completed', cause: 'report' })
  expect(h.subagents.live(sessionId)).toBe(true)
  // The turn ends as turns do; retirement then disposes the activation without cancelling anything.
  agent.status = 'idle'
  await retired(h, ticket.id)
  expect(h.subagents.live(sessionId)).toBe(false)
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('cancels a worker turn that outlives the retirement grace', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
  const agent = h.agents.get(sessionId)!
  // The grace is the wall clock, so this test owns it rather than waiting a minute.
  vi.useFakeTimers()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'the answer' })
  expect(agent.cancel).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60_000)
  // Once the grace expires the Executor ends the turn the worker did not end itself.
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  await retired(h, ticket.id)
  expect(h.subagents.live(sessionId)).toBe(false)
})

it('retires under a host whose activation dispose() returns undefined instead of a Promise', async () => {
  h = await startRuntime(undefined, { disposeReturnsVoid: true })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
  const agent = h.agents.get(sessionId)!
  expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'the answer' }))
    .toMatchObject({ reported: true })
  // The report call and the retirement both complete: the release of the activation resolves undefined
  // without turning the stop into a TypeError.
  agent.status = 'idle'
  await retired(h, ticket.id)
  expect(h.subagents.live(sessionId)).toBe(false)
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'executor', outcome: 'completed', cause: 'report' })
})
