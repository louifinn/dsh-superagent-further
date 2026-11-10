/** Starting an executor as a subagent of a project's Lead Session: the request, the activations a host keeps, and the notices it writes. */
import { describe, expect, it, vi } from 'vitest'
import { executorActivation, LEAD_PROVIDER, LeadActivations, type Activation, type ActivationSpec, type SubagentService } from '../src/executor/lead-dispatch.ts'
import { LeadDispatch, type LeadDispatchHost } from '../src/app/lead-dispatch.ts'
import type { LeadMessage } from '../src/app/lead-messages.ts'
import type { Assignment, Ticket } from '../src/core/index.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'

const signal = new AbortController().signal
const lead = { id: 'lead-app' } as never

function activation(childId: string, disposed = vi.fn(async () => {})): Activation {
  return { childId, result: new Promise(() => {}), dispose: disposed }
}

function service(start = vi.fn(async (spec: ActivationSpec) => activation((spec as { childId: string }).childId)),
  extra: Partial<SubagentService> = {}): SubagentService {
  return { startActivation: start, sendMessage: vi.fn(async () => 'message-1'), ...extra }
}

describe('the activation request of a Lead-hosted executor', () => {
  it('spawns the worker preset under the Lead, keeping the Ticket worker id', () => {
    const spec = executorActivation({ childId: 'worker-ticket-1', title: 'Add a line', cwd: '/state/work/app/one', text: '{"ticket_id":"t"}',
      lead, signal, preset: 'dsh-superagent-further-worker' })
    expect(spec.provider).toBe(LEAD_PROVIDER)
    expect(spec.childId).toBe('worker-ticket-1')
    expect(spec.label).toBe('Add a line')
    expect(spec.delivery).toBe('parent')
    expect(spec.request.cwd).toBe('/state/work/app/one')
    expect(spec.request.agentPreset).toBe('dsh-superagent-further-worker')
    expect(spec.request.parent).toBe(lead)
    expect(spec.request.maxDepth).toBe(1)
    expect(spec.request.prompt).toEqual([{ type: 'text', text: '{"ticket_id":"t"}' }])
    expect(spec.signal).toBe(signal)
  })
})

describe('the activations a host keeps', () => {
  it('refuses to start when the runtime has no subagent service', async () => {
    const leads = new LeadActivations(() => undefined)
    expect(leads.available).toBe(false)
    await expect(leads.start(executorActivation({ childId: 'worker-a', title: 'a', cwd: '/w', text: 'x', lead, signal, preset: 'p' })))
      .rejects.toThrow(/no subagent service/)
  })

  it('starts, holds and disposes one activation per child', async () => {
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async () => activation('worker-a', dispose))
    const leads = new LeadActivations(() => service(start))
    const started = await leads.start(executorActivation({ childId: 'worker-a', title: 'a', cwd: '/w', text: 'x', lead, signal, preset: 'p' }))
    expect(start).toHaveBeenCalledTimes(1)
    expect(leads.size).toBe(1)
    expect(started.childId).toBe('worker-a')
    await leads.dispose('worker-a')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(leads.size).toBe(0)
  })

  it('wakes the durable child of a retried Ticket instead of starting a second', async () => {
    const sendMessage = vi.fn(async () => 'message-1')
    const interrupt = vi.fn()
    const leads = new LeadActivations(() => ({ startActivation: async () => { throw new Error('SubagentError: subagent "worker-a" already exists') },
      sendMessage, interrupt }))
    const started = await leads.start(executorActivation({ childId: 'worker-a', title: 'a', cwd: '/w', text: 'new work', lead, signal, preset: 'p' }))
    expect(started.childId).toBe('worker-a')
    expect(sendMessage).toHaveBeenCalledWith(lead, 'worker-a', [{ type: 'text', text: 'new work' }], { signal })
    await leads.dispose('worker-a')
    expect(interrupt).toHaveBeenCalledWith('worker-a', { kind: 'ancestor', agent: lead })
  })

  it('steers a later delivery into the child it started, from that child Lead', async () => {
    const sendMessage = vi.fn(async () => 'message-1')
    const leads = new LeadActivations(() => ({ startActivation: async spec => activation((spec as { childId: string }).childId), sendMessage }))
    await leads.start(executorActivation({ childId: 'worker-a', title: 'a', cwd: '/w', text: 'first', lead, signal, preset: 'p' }))
    expect(leads.holds('worker-a')).toBe(true)
    expect(await leads.steer('worker-a', 'more work', signal)).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith(lead, 'worker-a', [{ type: 'text', text: 'more work' }], { signal })
    expect(await leads.steer('worker-unknown', 'x', signal)).toBe(false)
  })

  it('sends from a Lead after a restart lost the activation map', async () => {
    const sendMessage = vi.fn(async () => 'message-1')
    const leads = new LeadActivations(() => ({ startActivation: vi.fn(async () => { throw new Error('unused') }), sendMessage }))
    await leads.send(lead, 'worker-a', 'hello', signal)
    expect(sendMessage).toHaveBeenCalledWith(lead, 'worker-a', [{ type: 'text', text: 'hello' }], { signal })
  })

  it('forgets an activation that settled on its own, without disposing it', async () => {
    const dispose = vi.fn(async () => {})
    const settled = Promise.resolve('done')
    const leads = new LeadActivations(() => ({ startActivation: async () => ({ childId: 'worker-b', result: settled, dispose }), sendMessage: vi.fn(async () => 'm') }))
    await leads.start(executorActivation({ childId: 'worker-b', title: 'b', cwd: '/w', text: 'x', lead, signal, preset: 'p' }))
    await settled
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(leads.size).toBe(0)
    expect(dispose).not.toHaveBeenCalled()
  })

  it('disposes every activation when the host stops', async () => {
    const one = vi.fn(async () => {}), two = vi.fn(async () => {})
    let count = 0
    const leads = new LeadActivations(() => ({ startActivation: async () => activation(`worker-${++count}`, count === 1 ? one : two),
      sendMessage: vi.fn(async () => 'm') }))
    await leads.start(executorActivation({ childId: 'worker-1', title: 'a', cwd: '/w', text: 'x', lead, signal, preset: 'p' }))
    await leads.start(executorActivation({ childId: 'worker-2', title: 'b', cwd: '/w', text: 'x', lead, signal, preset: 'p' }))
    await leads.disposeAll()
    expect(one).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(1)
    expect(leads.size).toBe(0)
  })
})

describe('the stalled-Assignment notice', () => {
  it('writes one durable notice per Assignment and asks the Lead to inspect or stop the work', async () => {
    const messages: LeadMessage[] = []
    let sequence = 0
    const leads = {
      send: vi.fn((input: Omit<LeadMessage, 'id' | 'at'>) => {
        const record = { ...input, id: `message-${++sequence}`, at: '2026-01-01T00:00:00.000Z' } as LeadMessage
        messages.push(record)
        return record
      }),
      getByRequest: vi.fn((recipient: string, requestId: string) =>
        messages.find(message => message.to === recipient && message.requestId === requestId)),
      deliver: vi.fn(),
    }
    const host = {
      store: {
        leads,
        settings: () => ({ executor: { projects: [{ id: 'app', name: 'App', workspace: '/w', repository: '', branch: '' }] } }),
      },
      engine: () => ({}),
      ensureLead: vi.fn(async () => 'lead-app'),
      prompt: vi.fn(async () => {}),
      notify: vi.fn(),
    } as unknown as LeadDispatchHost
    const dispatch = new LeadDispatch(host)
    const ticket = { id: 't1', title: 'Fix the header', project: 'app' } as Ticket
    const assignment = { id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:00.000Z',
      report: { state: 'waiting', summary: 'waiting for CI', at: '2026-01-01T00:00:00.000Z' } } as Assignment
    await dispatch.stalled(ticket, assignment, '2026-01-01T00:00:00.000Z')
    await dispatch.stalled(ticket, assignment, '2026-01-01T00:00:00.000Z')
    expect(leads.send).toHaveBeenCalledTimes(1)
    expect(leads.send).toHaveBeenCalledWith(expect.objectContaining({ project: 'app', kind: 'notice', from: 'orchestrator', to: 'lead',
      requestId: 'stalled:t1:a1', ticketId: 't1' }))
    expect(host.ensureLead).toHaveBeenCalledWith(expect.objectContaining({ id: 'app' }))
    const body = leads.send.mock.calls[0]![0].body
    expect(body).toContain('worker-t1')
    expect(body).toContain('2026-01-01T00:00:00.000Z')
    expect(body).toContain('waiting for CI')
    expect(body).toContain('lead_notify_worker')
    expect(body).toContain('Orchestrator')
    expect(host.prompt).toHaveBeenCalledTimes(1)
    expect(host.prompt).toHaveBeenCalledWith('lead-app', 'stalled:t1:a1', body)
    expect(leads.deliver).toHaveBeenCalledWith('message-1')
  })
})

describe('the executor settings', () => {
  it('no longer carries an orchestration switch: a project Ticket always runs under its Lead', () => {
    expect('orchestration' in ExecutorConfigSchema.parse({})).toBe(false)
  })
})
