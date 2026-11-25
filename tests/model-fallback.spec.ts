/** Hierarchical model fallback (issue #24): a retried Worker or Lead takes its parent's current model on the next request. */
import { afterEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

const worker = { provider: 'worker-provider', model: 'worker-model' }
const lead = { provider: 'lead-provider', model: 'lead-model' }
const orchestrator = { provider: 'orchestrator-provider', model: 'orchestrator-model' }

/** Boot the Runtime with a distinct model per role, so a fallback changes the route. */
const boot = async (): Promise<Host> => startRuntime(store => {
  const settings = store.settings()
  store.saveSettings({ ...settings, eval: { ...settings.eval, model: orchestrator },
    executor: { ...settings.executor, model: worker, lead } })
})

/** One accepted answer Ticket whose worker Session the Lead already started (`acceptedTicket` assigns by default). */
const started = async () => {
  const accepted = await h!.acceptedTicket(feishu('1', '@bot fix the bug'), 'answer')
  const workerAgent = h!.agents.get(`worker-${accepted.ticket.id}`)!
  const leadAgent = h!.agents.get('lead-default')!
  return { accepted, workerAgent, leadAgent }
}

/** The fixture's Session stub records every appended model selection; the exported agent type hides it. */
type SelectionAgent = { session: { append: ReturnType<typeof vi.fn>; id: string } }
const sessionOf = (agent: unknown): SelectionAgent['session'] => (agent as SelectionAgent).session

/** The model selections a Session's own model was set to, in order. */
const selections = (agent: unknown) => sessionOf(agent).append.mock.calls
  .filter(([type]) => type === 'model/selection').map(([, value]) => value)

it('falls a worker back to its project Lead model, then a Lead to the orchestrator model, once per outage', async () => {
  h = await boot()
  const { workerAgent, leadAgent } = await started()
  expect(selections(workerAgent)).toEqual([worker])
  expect(await h.runtime.sessions.escalateModel(workerAgent.id, 'provider failed twice')).toMatchObject({
    sessionId: workerAgent.id, level: 'worker', from: worker, to: lead })
  expect(selections(workerAgent)).toEqual([worker, lead])
  // The same retry wait never bounces the same Session twice.
  expect(await h.runtime.sessions.escalateModel(workerAgent.id, 'provider failed again')).toBeUndefined()
  expect(selections(workerAgent)).toEqual([worker, lead])
  expect(selections(leadAgent)).toEqual([lead])
  expect(await h.runtime.sessions.escalateModel(leadAgent.id, 'provider failed twice')).toMatchObject({
    sessionId: leadAgent.id, level: 'lead', from: lead, to: orchestrator })
  expect(selections(leadAgent)).toEqual([lead, orchestrator])
  // The orchestrator has no parent model; its failures reach a person through the model-fault alert instead.
  expect(await h.runtime.sessions.escalateModel(h.runtime.masterId, 'provider failed twice')).toBeUndefined()
  const log = h.runtime.logs.list({ level: 'all', limit: 50 }).map(entry => entry.message).join('\n')
  expect(log).toContain('switched the model of')
  expect(log).toContain('worker-provider/worker-model')
  expect(log).toContain('lead-provider/lead-model')
})

it('switches after the retry stream reports repeated budget failures rather than on the first retry', async () => {
  h = await boot()
  const { workerAgent } = await started()
  const retry = (seq: number, attempt: number) => (h!.ctx as unknown as { emit: (name: string, session: unknown, event: unknown) => void })
    .emit('session/event', sessionOf(workerAgent), {
    type: 'llm/retry', seq, time: Date.now(),
    data: { turn: 0, step: 0, retryId: 'retry-1', provider: 'over-budget', retry: attempt, failure: { type: 'budget_exceeded' } } })
  retry(1, 1)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(selections(workerAgent)).toEqual([worker])
  retry(2, 2)
  await vi.waitFor(() => expect(selections(workerAgent)).toEqual([worker, lead]))
})

it('does not append a model selection for helper services or without a configured parent model', async () => {
  h = await boot()
  const { workerAgent } = await started()
  expect(await h.runtime.sessions.escalateModel('subagent-elsewhere', 'provider failed')).toBeUndefined()
  expect(selections(workerAgent)).toEqual([worker])
})
