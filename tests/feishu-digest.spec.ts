/** The Feishu daily digest: what it says and when it sends, through a fake Source context. */
import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { SOURCE } from '../src/sources/feishu-trigger.ts'
import { digestDay, digestText, digestTick, nextDigest } from '../src/sources/feishu-digest.ts'
import type { FeishuConfig } from '../src/sources/feishu.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'

/** A local noon, so a digest hour of 12 is inside the hour and 13 is not, whatever the machine's zone is. */
const noon = () => new Date(2026, 10, 7, 12, 30, 0, 0)
const ticket = (overrides: Partial<Ticket>): Ticket => ({
  id: 'ticket-1', title: 'Fix it', decisionId: 'decision-1', mandate: {} as Ticket['mandate'], channels: [],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
  assignments: [], inputs: [], undelivered: [], ...overrides,
})
const config = (overrides: Partial<FeishuConfig> = {}): FeishuConfig =>
  ({ cli: 'lark', readPageSize: 20, linkTimeoutMs: 5000, chats: [], directMessages: true, otherChats: 'none',
    digestChat: 'oc_agents', digestHour: 12, ...overrides }) as FeishuConfig

const context = (options: { tickets?: Ticket[]; config?: FeishuConfig; sent?: string } = {}) => {
  const health: { digest?: Health } = {}
  const state = new Map<string, unknown>()
  const lark = vi.fn<(args: string[], cwd?: string, stdin?: string) => Promise<unknown>>(async () => ({}))
  const ctx = {
    config: () => options.config ?? config(),
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
    tickets: { open: () => options.tickets ?? [] },
    commands: { lark },
    report: (entry: string, value: Health) => { if (entry === 'digest') health.digest = value },
  }
  if (options.sent) state.set('feishu-digest', { day: options.sent })
  return { ctx: ctx as unknown as SourceContext, health, lark, state }
}

describe('Feishu digest', () => {
  it('names the local day and the next due instant at the configured hour', () => {
    const now = new Date(2026, 10, 7, 9, 0)
    expect(digestDay(now)).toBe('2026-11-07')
    expect(nextDigest(9, new Date(2026, 10, 7, 8, 30)).getTime()).toBe(new Date(2026, 10, 7, 9, 0).getTime())
    expect(nextDigest(9, now).getTime()).toBe(new Date(2026, 10, 8, 9, 0).getTime())
    expect(nextDigest(9, new Date(2026, 10, 7, 10, 0)).getTime()).toBe(new Date(2026, 10, 8, 9, 0).getTime())
  })

  it('groups the waiting Tickets under the project names when a project is named', () => {
    const ready = { id: 'as-9', state: 'ended' as const, createdAt: '2026-11-01T00:00:00.000Z',
      report: { state: 'ready' as const, summary: 'Done', at: '2026-11-01T00:00:00.000Z' } }
    const text = digestText([
      ticket({ id: 'a', title: 'Ship the widget', project: 'widgets', updatedAt: '2026-11-02T00:00:00.000Z', assignments: [ready] }),
      ticket({ id: 'b', title: 'Write the handbook', updatedAt: '2026-11-03T00:00:00.000Z', assignments: [ready] }),
      ticket({ id: 'c', title: 'Fix the app', project: 'app', updatedAt: '2026-11-04T00:00:00.000Z', assignments: [ready] }),
    ], noon(), { widgets: 'Widgets', app: 'App' })
    expect(text).toContain('Project App\n· Fix the app')
    expect(text).toContain('Project Widgets\n· Ship the widget')
    expect(text).toContain('No project\n· Write the handbook')
    expect(text.indexOf('Project App')).toBeLessThan(text.indexOf('Project Widgets'))
    expect(text.indexOf('Project Widgets')).toBeLessThan(text.indexOf('No project'))
  })

  it("lists what each waiting Ticket needs, how long it waited, and its link, in the Tickets' language", () => {
    const text = digestText([
      ticket({ id: 'a', title: '添加 FEISHU-TEST-2.md', updatedAt: new Date(2026, 10, 4, 12, 0).toISOString(),
        channels: [{ source: SOURCE, thread: 'feishu:oc_agents:om_1', address: { chatId: 'oc_agents', messageId: 'om_1', url: 'https://github.com/o/r/pull/7' } }],
        assignments: [{ id: 'as-1', state: 'ended', createdAt: new Date(2026, 10, 4, 12, 0).toISOString(), report: { state: 'ready', summary: 'Done', at: new Date(2026, 10, 4, 12, 0).toISOString() } }] }),
      ticket({ id: 'b', title: 'Release 1.0', updatedAt: '2026-11-07T12:00:00.000Z' }),
    ], noon())
    expect(text.split('\n')[0]).toBe('每日摘要 · 2026-11-07')
    expect(text).toContain('待你处理 1 单：')
    expect(text).toContain('添加 FEISHU-TEST-2.md — 审阅结果，必要时合并 PR，已等 3 天')
    expect(text).toContain('https://github.com/o/r/pull/7')
    expect(text).toContain('另外 1 单在进行。')
    const ready = { id: 'as-2', state: 'ended' as const, createdAt: new Date(2026, 10, 7, 12, 0).toISOString(),
      report: { state: 'ready' as const, summary: 'Done', at: new Date(2026, 10, 7, 12, 0).toISOString() } }
    expect(digestText([ticket({ title: 'Fix the flaky test', assignments: [ready] })], noon())).toContain('1 Ticket waits for you:')
  })

  it('says a quiet day in both languages, so the daily message still arrives', () => {
    const text = digestText([], noon())
    expect(text).toContain('今天没有待你处理的工单。Nothing waits for you today.')
    expect(text.split('\n')[0]).toBe('Daily digest · 2026-11-07')
  })

  it('sends once inside the hour, records the day, and reports the next one', async () => {
    const first = context()
    await expect(digestTick(first.ctx, new Date(2026, 10, 7, 12, 5))).resolves.toBe('sent')
    expect(first.lark).toHaveBeenCalledTimes(1)
    expect(first.lark.mock.calls[0]?.[0]).toEqual(['im', '+messages-send', '--chat-id', 'oc_agents', '--markdown', '-', '--idempotency-key', 'digest-2026-11-07'])
    expect(first.health.digest).toMatchObject({ state: 'ready', detail: 'Sent today' })
    expect(first.health.digest?.nextAt).toBe(new Date(2026, 10, 8, 12, 0).toISOString())
    expect(first.state.get('feishu-digest')).toMatchObject({ day: '2026-11-07', at: new Date(2026, 10, 7, 12, 5).toISOString() })
    const second = context({ sent: '2026-11-07' })
    await expect(digestTick(second.ctx, new Date(2026, 10, 7, 12, 6))).resolves.toBe('skipped')
    expect(second.lark).not.toHaveBeenCalled()
    expect(second.health.digest?.detail).toBe('Next digest at 12:00')
  })

  it('waits outside the hour, sends nothing when no chat is configured, and retries after a failed send', async () => {
    const early = context()
    await expect(digestTick(early.ctx, new Date(2026, 10, 7, 11, 59))).resolves.toBe('skipped')
    expect(early.lark).not.toHaveBeenCalled()
    const off = context({ config: config({ digestChat: '' }) })
    await expect(digestTick(off.ctx, new Date(2026, 10, 7, 12, 5))).resolves.toBe('off')
    expect(off.health.digest).toMatchObject({ state: 'paused', detail: 'The daily digest is off' })
    const failing = context()
    failing.lark.mockRejectedValueOnce(new Error('lark-cli: no such chat'))
    await expect(digestTick(failing.ctx, new Date(2026, 10, 7, 12, 5))).resolves.toBe('failed')
    expect(failing.health.digest).toMatchObject({ state: 'error', detail: 'The daily digest failed: Error: lark-cli: no such chat' })
    expect(failing.state.get('feishu-digest')).toBeUndefined()
    await expect(digestTick(failing.ctx, new Date(2026, 10, 7, 12, 6))).resolves.toBe('sent')
    expect(failing.lark).toHaveBeenCalledTimes(2)
  })
})
