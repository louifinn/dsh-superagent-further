/** The `session` Source kind, its global submission tool, and the always-reply/completion path back to the Session. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { key, type Decision } from '../../src/core/index.ts'
import {
  SESSION_ROW, SESSION_TOOL, SessionSubmitSchema, SOURCE, sessionDecisionText, sessionKind, sessionSubmitTool,
  sessionTrigger, sessionTriggerId, sessionThread, type SessionToolHost,
} from '../../src/sources/session.ts'
import { startRuntime, type Host } from '../fixtures/host.ts'

const signal = new AbortController().signal

const submission = (extra: Record<string, unknown> = {}) =>
  SessionSubmitSchema.parse({ title: 'Update the architecture notes', instruction: 'Describe the session Source in docs/007.', ...extra })

const decision = (kind: Decision['kind'], extra: Partial<Decision> = {}): Decision => ({
  id: 'decision-1', evalId: 'eval-1', threadKey: 'session:external-1:call-1', triggerIds: ['trigger-1'], policyVersion: '1',
  at: '2026-01-01T00:00:00.000Z', kind, reason: [{ code: 'admission_ignored' }], strength: 'inferred', ...extra,
})

it('normalizes one tool call into a Trigger with its own Thread and the Session as Channel', () => {
  const input = submission({ project: 'default' })
  const trigger = sessionTrigger(input, 'call-1', 'external-1', '2026-01-01T00:00:00.000Z')
  expect(trigger).toMatchObject({
    id: sessionTriggerId('external-1', 'call-1'),
    source: SOURCE,
    threads: [{ source: SOURCE, id: sessionThread('external-1', 'call-1') }],
    actor: { source: SOURCE, id: '' },
    human: false,
    at: '2026-01-01T00:00:00.000Z',
    channel: { source: SOURCE, thread: `session:${sessionThread('external-1', 'call-1')}`, address: { sessionId: 'external-1' } },
    meta: { sessionId: 'external-1', title: input.title, callId: 'call-1', project: 'default' },
  })
  expect(trigger.text).toContain(input.title)
  expect(trigger.text).toContain(input.instruction)
  expect(trigger.text).toContain('Project: default')
  // Different calls from one Session are different Threads, so independent requests cannot share an evaluation.
  expect(sessionTrigger(submission(), 'call-2', 'external-1').id).not.toBe(trigger.id)
  expect(sessionTrigger(sessionSubmissionWithoutProject(), 'call-1', 'external-1').text).not.toContain('Project:')
})

function sessionSubmissionWithoutProject() { return SessionSubmitSchema.parse({ title: 't', instruction: 'i' }) }

it('describes the Session Source scope, channel and admission row', async () => {
  const deliver = vi.fn(async () => {})
  const kind = sessionKind(deliver)
  expect(kind.schema.parse({})).toEqual({})
  expect(kind.scope!({ meta: { sessionId: 'external-1' } }, {})).toEqual({ listened: true, observed: true, row: SESSION_ROW })
  expect(kind.scope!({ meta: {} }, {})).toEqual({ listened: false, reason: 'session_missing' })
  expect(kind.channel!.allowed!({ sessionId: 'external-1' }, {})).toBe(true)
  expect(kind.channel!.allowed!({}, {})).toBe(false)
  const message = { id: 'notice-1', channel: { source: SOURCE, thread: 'session:x', address: { sessionId: 'external-1' } },
    text: 'hello', kind: 'notice' as const }
  expect(await kind.channel!.send({} as never, message)).toBe('sent')
  expect(deliver).toHaveBeenCalledWith('external-1', 'notice-1', 'hello')
  expect(await kind.channel!.send({} as never, { ...message, channel: { ...message.channel, address: {} } })).toBe('gone')
  // A deleted Session is gone; anything else may be retried.
  deliver.mockRejectedValueOnce({ code: 'session/not-found' })
  expect(await kind.channel!.send({} as never, message)).toBe('gone')
  deliver.mockRejectedValueOnce(new Error('transport down'))
  await expect(kind.channel!.send({} as never, message)).rejects.toThrow('transport down')
  expect(kind.channel!.link({ sessionId: 'external-1' }, {})).toEqual({ url: '', label: { zh: 'DSH 会话', en: 'DSH Session' } })
  expect(kind.policy!.schema.parse({})).toEqual({ allowed: [] })
  const rows = kind.policy!.rows!({})
  expect(rows).toEqual([expect.objectContaining({ id: SESSION_ROW,
    cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } })])
})

it('writes the always-reply notice in the request language and names the ticket on accept', () => {
  const trigger = sessionTrigger(submission(), 'call-1', 'external-1')
  const accept = sessionDecisionText(decision('accept', { ticketId: 'ticket-1' }), trigger)
  expect(accept).toContain('Request accepted as ticket ticket-1')
  expect(accept).toContain('reported in this Session')
  expect(sessionDecisionText(decision('ignore'), trigger)).toContain('Your request was not taken up')
  expect(sessionDecisionText(decision('unavailable'), trigger)).toContain('could not be processed')
  expect(sessionDecisionText(decision('stop'), trigger)).toContain('The work was stopped as requested')
  const chinese = sessionTrigger(SessionSubmitSchema.parse({ title: '更新文档', instruction: '把会话来源写进架构文档。' }), 'call-2', 'external-1')
  expect(sessionDecisionText(decision('ignore'), chinese)).toContain('请求未被采纳')
})

it('refuses a submission the bridge cannot serve and passes a valid one to the ordinary intake', async () => {
  const received: unknown[] = []
  const host = (over: Partial<SessionToolHost> = {}): SessionToolHost => ({
    receive: trigger => { received.push(trigger); return 'stored' },
    accepting: () => ({ ok: true }),
    projects: () => [{ id: 'default' }],
    managed: () => false,
    ...over,
  })
  const agent = (id = 'external-1', header: Record<string, unknown> = { id }) => ({ id, session: { header } }) as never
  const execute = async (tool: ToolDefinition, args: unknown, context: unknown) => tool.execute(args, context as never) as Promise<Record<string, unknown>>

  await expect(sessionSubmitTool(host()).execute(submission(), { callId: 'call-1', signal } as never))
    .rejects.toThrow('only works from a DSH Session')
  await expect(execute(sessionSubmitTool(host()), submission(), { agent: agent('external-1', { id: 'external-1', parentSession: 'parent' }), callId: 'call-1' }))
    .rejects.toThrow('A subagent cannot submit')
  await expect(execute(sessionSubmitTool(host({ managed: id => id === 'external-1' })), submission(), { agent: agent(), callId: 'call-1' }))
    .rejects.toThrow('managed by dsh-superagent-further')
  await expect(execute(sessionSubmitTool(host()), submission({ session_id: 'other' }), { agent: agent(), callId: 'call-1' }))
    .rejects.toThrow('session_id must name the calling Session')
  await expect(execute(sessionSubmitTool(host({ accepting: () => ({ ok: false, reason: 'The Source is off.' }) })), submission(), { agent: agent(), callId: 'call-1' }))
    .rejects.toThrow('The Source is off.')
  await expect(execute(sessionSubmitTool(host()), submission({ project: 'missing' }), { agent: agent(), callId: 'call-1' }))
    .rejects.toThrow('Unknown project missing')
  expect(received).toEqual([])

  const result = await execute(sessionSubmitTool(host()), submission({ session_id: 'external-1' }), { agent: agent(), callId: 'call-1' })
  expect(result).toMatchObject({ trigger_id: sessionTriggerId('external-1', 'call-1'), state: 'stored' })
  expect(received).toHaveLength(1)
})

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Registers the Host's root tools service after startup, which loads the plugin's waiting global-tool provider. */
async function globalTool(host: Host): Promise<ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  host.ctx.reflect.provide('tools', {
    register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } },
  })
  await vi.waitFor(() => expect(tools.has(SESSION_TOOL)).toBe(true))
  return tools.get(SESSION_TOOL)!
}

it('registers the session Source and its global tool, and always answers an inadmissible submission', async () => {
  expect(h.runtime.sources.kind(SOURCE)).toBeDefined()
  const tool = await globalTool(h)
  await h.controller.create({ sessionId: 'external-1' })
  const agent = h.agents.get('external-1')!
  const result = await tool.execute({ title: 'Update the architecture notes', instruction: 'Describe the session Source.' },
    { agent, callId: 'call-1', signal } as never) as { trigger_id: string; state: string }
  expect(result.state).toBe('stored')
  await h.runtime.idle()
  const trigger = h.runtime.store.triggers.get(result.trigger_id)!
  const disposition = h.runtime.store.triggers.disposition(trigger.id)!
  const decided = h.runtime.store.decisions.get(disposition.decisionId!)!
  expect(decided.kind).toBe('ignore')
  expect(decided.reason).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'admission_ignored' })]))
  expect(h.runtime.outbox.status(key('session-reply', decided.id, trigger.id))).toBe('sent')
  const texts = h.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery => delivery.sessionId === 'external-1').map(delivery => delivery.text)
  expect(texts).toEqual(expect.arrayContaining([expect.stringContaining('Your request was not taken up')]))
})

it('reports an accepted request and its completion back into the submitting Session', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { ...settings.policy.sources,
      session: { allowed: [], admission: { [SESSION_ROW]: { unlistedUnaddressed: 'inferred' } } } } } })
  const tool = await globalTool(h)
  await h.controller.create({ sessionId: 'external-2' })
  const result = await tool.execute({ title: 'Update docs/012', instruction: 'Record the actual Session bridge.', project: 'default' },
    { agent: h.agents.get('external-2')!, callId: 'call-1', signal } as never) as { trigger_id: string; state: string }
  expect(result.state).toBe('stored')
  await h.runtime.idle()
  const trigger = h.runtime.store.triggers.get(result.trigger_id)!
  expect(h.runtime.store.triggers.disposition(trigger.id)!.evalId).toBeDefined()
  const accepted = h.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Update docs/012', scope: 'docs/012 D9',
    reason: 'asked through superagent_submit', project: 'default', name: 'session-docs', rules: ['docs'] })
  expect(accepted.kind).toBe('accept')
  const ticket = h.runtime.store.tickets.get(accepted.ticketId!)!
  await h.runtime.idle()
  expect(h.runtime.outbox.status(key('session-reply', accepted.id, trigger.id))).toBe('sent')
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'dropped', summary: 'The architecture notes already say it.' })
  await h.runtime.idle()
  const done = h.runtime.store.tickets.get(ticket.id)!
  expect(done.ended?.outcome).toBe('dropped')
  const request = h.runtime.store.requests.get(ticket.requestId!)!
  const receipt = key('request-result', request.id, SOURCE, JSON.stringify(trigger.channel!.address))
  expect(h.runtime.outbox.status(receipt)).toBe('sent')
  const texts = h.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery => delivery.sessionId === 'external-2').map(delivery => delivery.text)
  expect(texts).toEqual(expect.arrayContaining([expect.stringContaining('Request accepted as ticket')]))
  expect(texts).toEqual(expect.arrayContaining([expect.stringContaining('Update docs/012')]))
})
