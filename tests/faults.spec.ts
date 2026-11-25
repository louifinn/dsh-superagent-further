/** Model-failure and rootless-request alerts (issues #26 and #30): every path reaches a person once, or records why not. */
import { describe, expect, it, vi } from 'vitest'
import { Faults, modelFaultRole, modelFaultText } from '../src/app/faults.ts'
import type { BudgetRetryStatus } from '../src/app/retry-health.ts'
import type { ProjectRequest } from '../src/core/model.ts'

const retry = (overrides: Partial<BudgetRetryStatus> = {}): BudgetRetryStatus => ({ sessionId: 'worker-1', provider: 'provider-1',
  attempts: 3, since: '2026-11-25T10:00:00.000Z', lastAt: '2026-11-25T10:05:00.000Z', ...overrides })

const request = (overrides: Partial<ProjectRequest> = {}): ProjectRequest => ({ id: 'request-1', project: 'app', kind: 'escalation',
  title: 'Work outside this project', instruction: 'Move it', raised_by: { session: 'lead-app' } as ProjectRequest['raised_by'],
  status: 'pending', replies: [], tickets: [], derived: [], created_at: '2026-11-25T10:00:00.000Z', updated_at: '2026-11-25T10:00:00.000Z', ...overrides })

const harness = (options: { recovery?: boolean; send?: boolean } = {}) => {
  const state = new Map<string, unknown>()
  const sent: { key: string; text: string }[] = []
  const logs: { level: string; scope: string; message: string }[] = []
  const send = vi.fn(async (key: string, text: string) => {
    sent.push({ key, text })
    return options.send ?? true
  })
  const faults = new Faults({ alerts: { send },
    state: { get: value => state.get(value) as never, set: (value, next) => { if (next === undefined) state.delete(value); else state.set(value, next) } },
    logs: { record: ((level: string, scope: string, message: string) => { logs.push({ level, scope, message }) }) as never },
    recovery: () => options.recovery ?? true })
  return { faults, send, sent, state, logs }
}

describe('model failure alerts', () => {
  it('reports every failing level once and sends one recovery message when the set clears', async () => {
    const { faults, send, sent, state, logs } = harness()
    const retries = [retry({ sessionId: 'worker-1', provider: 'a' }), retry({ sessionId: 'lead-app', provider: 'b' }),
      retry({ sessionId: 'orchestrator', provider: 'c' })]
    await faults.modelRetries(retries)
    expect(send).toHaveBeenCalledTimes(1)
    const text = sent[0]!.text
    expect(text).toContain('Executor session worker-1')
    expect(text).toContain('Lead session lead-app')
    expect(text).toContain('Orchestrator session orchestrator')
    expect(text).toContain('provider a')
    expect(text).toContain('attempt 3')
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', scope: 'faults' }))
    expect(state.size).toBe(1)
    // The same failure set never pages twice.
    await faults.modelRetries(retries)
    expect(send).toHaveBeenCalledTimes(1)
    // Clearing the set keeps the fact in the log and sends one recovery.
    await faults.modelRetries([])
    expect(send).toHaveBeenCalledTimes(2)
    expect(sent[1]!.text).toContain('Recovery')
    expect(state.size).toBe(0)
  })

  it('does not send a recovery when recovery alerts are off, and records an unreachable chat', async () => {
    const quiet = harness({ recovery: false })
    await quiet.faults.modelRetries([retry()])
    await quiet.faults.modelRetries([])
    expect(quiet.send).toHaveBeenCalledTimes(1)
    const unreachable = harness({ send: false })
    await unreachable.faults.modelRetries([retry()])
    expect(unreachable.logs).toContainEqual(expect.objectContaining({ scope: 'faults',
      message: expect.stringContaining('no alert chat could be reached') }))
    expect(unreachable.state.size).toBe(0)
  })

  it('names the session level and its provider without inspecting model output', () => {
    expect(modelFaultRole('worker-1')).toBe('Executor')
    expect(modelFaultRole('lead-app')).toBe('Lead')
    expect(modelFaultRole('orchestrator')).toBe('Orchestrator')
    expect(modelFaultText([retry()])).toContain('provider provider-1')
  })
})

describe('rootless request alerts', () => {
  it('reports a decided escalation that has no root Channel', async () => {
    const { faults, send, sent, logs } = harness()
    await faults.escalationDecided(request({ id: 'escalation-1' }), 'accept')
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0]!.text).toContain('escalated')
    expect(sent[0]!.text).toContain('accept')
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', scope: 'faults' }))
    // An escalation with a root Channel is reported by the Lead's own path, not twice here.
    await faults.escalationDecided(request({ id: 'escalation-2', root: { trigger_id: 'trigger-1', thread_key: 'feishu:oc_1' } }), 'accept')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reports a completed project request with no root Channel', async () => {
    const { faults, send, sent } = harness()
    await faults.projectCompletedNoRoot(request({ id: 'request-2', kind: 'work', title: 'Done thing' }), ['ticket-1', 'ticket-2'])
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0]!.text).toContain('Done thing')
    expect(sent[0]!.text).toContain('2 Tickets')
  })
})
