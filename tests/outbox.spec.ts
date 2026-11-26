/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('drops a reply a person gave up on, so it stops retrying and stops being a problem', async () => {
  let calls = 0
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async () => { calls += 1; throw new Error('IM message has 277 words; maximum is 100') },
      link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.sources.register(probe)
  h.runtime.outbox.send({ id: 'doomed', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Too long', kind: 'reply' })
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('doomed'), calls]).toEqual(['pending', 1])
  // A person decides not to send it: the receipt settles, the queued effect is cancelled, and a later pass sends nothing.
  expect(h.runtime.outbox.drop('doomed')).toBe(true)
  expect(h.runtime.outbox.status('doomed')).toBe('dropped')
  expect(h.runtime.store.receipts.get('doomed')?.dropped?.reason).toBe('operatorDropped')
  expect(h.runtime.outbox.drop('doomed')).toBe(false)
  await h.runtime.pump(); await at(6000)
  expect([calls, h.runtime.outbox.status('doomed')]).toEqual([1, 'dropped'])
  // The decision leaves a durable line naming the reply, which is what the Logs page acts on.
  expect(h.runtime.logs.list({})).toContainEqual(expect.objectContaining({ scope: 'outbox', data: { reply: 'doomed' } }))
})
