/**
 * The Host log ring as an operational record: startup, the Engine's lifecycle events, outbox delivery, health
 * transitions, and the per-scope capture factory. Entries are asserted by scope, level, message shape and order;
 * no test reads an absolute timestamp.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LogFileSink } from '../src/app/log-files.ts'
import { Logs, captureLogs, captureScopes } from '../src/app/logs.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { pollThreads } from '../src/sources/poll.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { vi.useRealTimers(); await h.stop() })

const messages = (level?: 'debug' | 'info' | 'warn' | 'error', scope?: string) =>
  h.runtime.logs.list(scope ? { scope } : {})
    .filter(entry => level === undefined || entry.level === level)
    .map(entry => entry.message)

it('records one startup summary for the claims that came up ready', async () => {
  const startup = messages('info', 'runtime').filter(message => message.startsWith('runtime ready'))
  expect(startup).toHaveLength(1)
  expect(startup[0]).toMatch(/^runtime ready: \d+ claims ready \(/)
})

it('records each Engine lifecycle event once, without message bodies', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')

  const trigger = messages('info', 'trigger')
  expect(trigger).toHaveLength(1)
  expect(trigger[0]).toMatch(/^trigger\.received trigger=\S+ threads=\d+$/)

  const created = messages('info', 'ticket').filter(message => message.startsWith('ticket.created'))
  expect(created).toHaveLength(1)
  expect(created[0]).toContain(`ticket=${ticket.id}`)
  expect(created[0]).toMatch(/decision=\S+ strength=\S+/)

  const started = messages('info', 'assignment').filter(message => message.startsWith('assignment.started'))
  expect(started).toHaveLength(1)
  expect(started[0]).toContain(`ticket=${ticket.id}`)
  expect(started[0]).toMatch(/assignment=\S+$/)

  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'the answer' })
  const ended = messages('info', 'ticket').filter(message => message.startsWith('ticket.ended'))
  expect(ended).toHaveLength(1)
  expect(ended[0]).toContain(`ticket=${ticket.id}`)
  expect(ended[0]).toContain('by=executor')
  expect(ended[0]).toContain('cause=report')
  expect(ended[0]).toContain('outcome=completed')
  expect(ended[0]).not.toContain('the answer')

  const request = messages('info', 'request')
  expect(request).toHaveLength(1)
  expect(request[0]).toMatch(/^request\.ended request=\S+ by=\S+ outcome=done$/)
})

it('records a retried Assignment ending with its reason', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('2', '@bot 修一下回归'), 'answer')
  const before = messages('info', 'assignment').filter(message => message.startsWith('assignment.ended')).length
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  await h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  const ended = messages('info', 'assignment').filter(message => message.startsWith('assignment.ended'))
  expect(ended).toHaveLength(before + 1)
  expect(ended.at(-1)).toContain(`ticket=${ticket.id}`)
  expect(ended.at(-1)).toContain('reason=retried')
})

it('reports a health transition only when the state changes', () => {
  const changes: [string, string | undefined, string][] = []
  const board = new HealthBoard((name, previous, next) => changes.push([name, previous?.state, next.state]))
  const entry = board.claim('github', { state: 'starting', detail: '' })

  entry.set({ state: 'starting', detail: 'probing' })
  entry.set({ state: 'ready', detail: 'polled' })
  entry.set({ state: 'ready', detail: 'polled again' })
  entry.set({ state: 'error', detail: 'The CLI is offline' })
  entry.set({ state: 'ready', detail: 'polled' })

  expect(changes).toEqual([
    ['github', 'starting', 'ready'],
    ['github', 'ready', 'error'],
    ['github', 'error', 'ready'],
  ])
})

it('turns a claim name into a health log entry and its recovery into another', () => {
  const entry = h.runtime.sources.healthEntries(['feishu']).get('feishu')
  expect(entry).toBeDefined()
  entry!.set({ state: 'error', detail: 'The CLI is offline' })

  const failed = h.runtime.logs.list({ level: 'warn', scope: 'feishu' }).map(entry => entry.message)
  expect(failed).toContain('feishu is error: The CLI is offline')

  entry!.set({ state: 'ready', detail: 'polled' })
  expect(messages('info', 'feishu')).toContain('feishu recovered: ready')
})

it('records an outbox delivery once, and a delivery failure once across its retry', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('3', '@bot 修一下回归'), 'answer')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'the answer' })
  await h.runtime.sendReplies()
  const delivered = messages('info', 'outbox').filter(message => message.startsWith('reply delivered'))
  expect(delivered.length).toBeGreaterThanOrEqual(1)
  expect(delivered.some(message => message.includes('source=feishu'))).toBe(true)

  const failing = vi.spyOn(h.runtime.sources, 'send').mockRejectedValue(new Error('lark exploded'))
  try {
    h.runtime.outbox.send({ id: 'reply-op-log-failure', channel: feishu('4', 'hello').channel!, text: 'hello', kind: 'notice' })
    await h.runtime.sendReplies()
    const failed = messages('warn', 'outbox').filter(message => message.startsWith('reply delivery failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('reply=reply-op-log-failure')
    expect(failed[0]).toContain('lark exploded')

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5_000 })
    try {
      await h.runtime.pump()
      await h.runtime.sendReplies()
    } finally {
      vi.useRealTimers()
    }
    expect(messages('warn', 'outbox').filter(message => message.startsWith('reply delivery failed'))).toHaveLength(1)
  } finally {
    failing.mockRestore()
  }
})

it('captures printf arguments per scope in one bounded ring while the Host logger sees the raw arguments', () => {
  const logs = new Logs(() => new Date(Date.UTC(2026, 10, 10)), 400)
  const host = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const capture = captureScopes(logs, host)

  capture('github').info('polled %s', 'ok')
  capture('feishu').warn('slow %d', 3)
  expect(logs.list().map(entry => [entry.level, entry.scope, entry.message])).toEqual([
    ['info', 'github', 'polled ok'],
    ['warn', 'feishu', 'slow 3'],
  ])
  expect(host.info).toHaveBeenCalledWith('polled %s', 'ok')
  expect(host.warn).toHaveBeenCalledWith('slow %d', 3)

  for (let index = 0; index < 400; index += 1) logs.record('debug', 'host', `entry ${index}`)
  const all = logs.list({ limit: 400 })
  expect(all).toHaveLength(400)
  // The two captured entries are the oldest, so they are the ones the cap trims.
  expect(all[0]!.message).toBe('entry 0')
  expect(all.some(entry => entry.message === 'polled ok')).toBe(false)
})

it('redacts credentials and environment values before the ring and the file', async () => {
  const day = new Date(Date.UTC(2026, 10, 10))
  const logs = new Logs(() => day, 20)
  const sink = new LogFileSink({ stateDir: h.directory, now: () => day, flushMs: 60_000 })
  logs.attach(sink)
  logs.record('info', 'source', 'Authorization: Bearer supersecret token=abc password=hunter2 env FOO=bar')
  logs.record('info', 'executor', 'report.recorded', { token: 'abc', ticket: 't1', nested: { password: 'x' } })
  await sink.close()

  const ring = logs.list()
  expect(ring[0]!.message).toContain('<redacted>')
  for (const secret of ['supersecret', 'abc', 'hunter2', 'FOO=bar']) expect(ring[0]!.message).not.toContain(secret)
  expect(ring[1]!.data).toMatchObject({ token: '<redacted>', ticket: 't1', nested: { password: '<redacted>' } })

  const text = readFileSync(join(h.directory, 'logs', `${day.toISOString().slice(0, 10)}.jsonl`), 'utf8')
  for (const secret of ['supersecret', 'abc', 'hunter2', 'FOO=bar']) expect(text).not.toContain(secret)
})

it('folds consecutive identical entries inside 60 seconds and summarizes the streak', () => {
  let clock = Date.UTC(2026, 10, 10, 0, 0, 0)
  const logs = new Logs(() => new Date(clock), 20)
  for (let index = 0; index < 3; index += 1) { logs.record('info', 'source', 'poll.succeeded thread=t'); clock += 1000 }
  logs.record('info', 'source', 'poll.succeeded thread=u')
  expect(logs.list().map(entry => entry.message)).toEqual([
    'poll.succeeded thread=t',
    'poll.succeeded thread=t (repeated 3 times)',
    'poll.succeeded thread=u',
  ])
  clock += 61_000
  logs.record('info', 'source', 'poll.succeeded thread=u')
  expect(logs.list().filter(entry => entry.message === 'poll.succeeded thread=u')).toHaveLength(2)
})

it('drops debug entries while the minimum level is info, and records them when it changes', () => {
  const logs = new Logs(() => new Date(Date.UTC(2026, 10, 10)), 20)
  logs.setMinLevel(() => 'info')
  logs.record('debug', 'host', 'hidden detail')
  expect(logs.list()).toHaveLength(0)
  logs.setMinLevel(() => 'debug')
  logs.record('debug', 'host', 'visible detail')
  expect(logs.list().map(entry => entry.message)).toEqual(['visible detail'])
})

it('records source polling success at debug, one failure detail at debug, and recovery at info', async () => {
  const logs = new Logs(() => new Date(Date.UTC(2026, 10, 10)), 50)
  const host = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const log = captureLogs(logs, host, 'feishu')
  const thread = { key: 'feishu:t1', subscriptions: [], lastAt: new Date().toISOString(), meta: {} as Record<string, unknown> }
  const ctx = { log, threads: {
    subscribed: () => [thread],
    patch: (_key: string, meta: Record<string, unknown>) => { Object.assign(thread.meta, meta) },
  }, tickets: { get: () => undefined } } as unknown as SourceContext

  await pollThreads(ctx, 'feishu', () => false, async () => {})
  await pollThreads(ctx, 'feishu', () => false, async () => { throw new Error('lark timeout') })
  await pollThreads(ctx, 'feishu', () => false, async () => {})

  expect(logs.list({ level: 'all', scope: 'feishu' }).filter(entry => entry.level === 'debug').map(entry => entry.message)).toEqual([
    'poll.succeeded thread=feishu:t1 source=feishu',
    'poll.failed thread=feishu:t1 source=feishu error=lark timeout',
  ])
  expect(logs.list({ scope: 'feishu' }).filter(entry => entry.level === 'info').map(entry => entry.message))
    .toEqual(['poll.recovered thread=feishu:t1 source=feishu'])
})

it('records executor launch, turn, job, report and agent-error metadata without content', async () => {
  const current = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...current, logLevel: 'debug' }, h.runtime.store.blockRevision('executor'), 'panel')
  const { ticket, sessionId } = await h.acceptedTicket(feishu('7', '@bot 修一下回归'), 'answer')
  await h.runtime.idle()
  expect(messages('info', 'executor').filter(message => message.startsWith('assignment.launched'))).toEqual([
    expect.stringContaining(`ticket=${ticket.id}`),
  ])

  h.ctx.emit('session/event', { id: sessionId } as never, { type: 'turn/start', data: { turn: 1 } } as never)
  h.ctx.emit('session/event', { id: sessionId } as never, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as never)
  expect(messages('debug', 'executor')).toContain(`turn.started ticket=${ticket.id} turn=1`)
  expect(messages('info', 'executor').find(message => message.startsWith('turn.ended'))).toMatch(
    new RegExp(`^turn\\.ended ticket=${ticket.id} turn=1 reason=completed duration=\\d+ms$`))

  const job = h.jobs.run(sessionId, 'sleep 1')
  h.jobs.end(job)
  await vi.waitFor(() => {
    expect(messages('debug', 'executor')).toContain(`job.settled ticket=${ticket.id} job=${job} status=completed cause=producer`)
  })

  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'the secret answer' })
  await h.runtime.idle()
  const report = messages('info', 'executor').filter(message => message.startsWith('report.recorded'))
  expect(report.some(message => message.includes(`ticket=${ticket.id}`) && message.includes('state=ready')
    && message.includes('outcome=completed'))).toBe(true)
  expect(report.join('\n')).not.toContain('the secret answer')
})

it('records an agent error by name, code, turn and step without its message', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('9', '@bot 修一下回归'), 'answer')
  const error = Object.assign(new Error('provider exploded'), { code: 'E_PROVIDER' })
  h.ctx.emit('agent/error', { agent: { id: sessionId }, turn: 1, step: 2, error } as never)
  await vi.waitFor(() => {
    const entry = messages('warn', 'executor').find(message => message.startsWith('agent.error'))
    expect(entry).toContain(`ticket=${ticket.id}`)
    expect(entry).toContain('name=Error')
    expect(entry).toContain('code=E_PROVIDER')
    expect(entry).toContain('turn=1 step=2')
    expect(entry).not.toContain('provider exploded')
  })
})

it('records a decision and a policy change as runtime metadata', async () => {
  await h.acceptedTicket(feishu('8', '@bot 修一下回归'), 'answer')
  expect(messages('info', 'runtime').some(message => message.startsWith('decision.recorded decision='))).toBe(true)

  const current = h.runtime.store.settings().policy
  const changed = { ...current, rules: current.rules.map((rule, index) => index === 0 ? { ...rule, enabled: !rule.enabled } : rule) }
  await h.runtime.settings.save('policy', changed, h.runtime.store.blockRevision('policy'), 'panel')
  expect(messages('info', 'runtime').some(message => message.startsWith('policy.changed from='))).toBe(true)
})
