/** Incident alerts (issue #19): a person hears about an incident change once, within the configured caps. */
import { describe, expect, it, vi } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { Alerts } from '../src/app/alerts.ts'
import { Logs } from '../src/app/logs.ts'
import type { Incident } from '../src/core/incidents.ts'

const incident = (overrides: Partial<Incident> = {}): Incident => ({
  id: 'incident-1', fingerprint: 'fingerprint-1', rule: 'health-error', scope: {}, severity: 'high', status: 'detected',
  first_at: '2026-11-11T10:00:00.000Z', last_at: '2026-11-11T10:00:00.000Z', occurrences: 1, title: 'The host stopped',
  detail: 'The host exited unexpectedly.', evidence_dir: '', updated_at: '2026-11-11T10:00:00.000Z', ...overrides,
})

const harness = (overrides: { alertChatId?: string; alertMinimumSeverity?: 'low' | 'medium' | 'high' | 'critical'
  alertDailyLimit?: number; alertRecovery?: boolean } = {}) => {
  const base = SettingsSchema.parse({})
  const settings = { ...base, executor: { ...base.executor,
    incidents: { ...base.executor.incidents, alertChatId: 'oc_alerts', ...overrides } } }
  const state = new Map<string, unknown>()
  const lark = vi.fn(async (_args: string[], _cwd?: string, _stdin?: string): Promise<unknown> => ({}))
  const logs: { level: string; scope: string; message: string }[] = []
  const alerts = new Alerts({ settings: () => settings, commands: { lark: lark as unknown as Pick<import('../src/infra/commands.ts').Commands, 'lark'>['lark'] },
    state: { get: value => state.get(value) as never, set: (value, next) => { if (next === undefined) state.delete(value); else state.set(value, next) } },
    logs: { record: ((level: string, scope: string, message: string) => { logs.push({ level, scope, message }) }) as unknown as Logs['record'] } })
  return { alerts, lark, state, logs, settings }
}

describe('incident alerts', () => {
  it('sends one message per incident change to the configured chat, with the idempotency key', async () => {
    const { alerts, lark, state } = harness()
    expect(await alerts.notify(incident(), 'opened')).toBe(true)
    expect(lark).toHaveBeenCalledTimes(1)
    const [args, cwd, text] = lark.mock.calls[0]!
    expect(args).toEqual(['im', '+messages-send', '--chat-id', 'oc_alerts', '--markdown', '-', '--idempotency-key', expect.any(String)])
    expect(String(args.at(-1))).toHaveLength(32)
    expect(cwd).toBeUndefined()
    expect(text).toContain('Incident opened')
    expect(text).toContain('The host stopped')
    expect(state.size).toBe(2)
    // The same incident and change never pages twice.
    expect(await alerts.notify(incident(), 'opened')).toBe(false)
    expect(lark).toHaveBeenCalledTimes(1)
  })

  it('keeps alerts off without a chat and below the alert severity', async () => {
    expect(await harness({ alertChatId: '' }).alerts.notify(incident(), 'opened')).toBe(false)
    const silent = harness({ alertMinimumSeverity: 'critical' })
    expect(await silent.alerts.notify(incident({ severity: 'high' }), 'opened')).toBe(false)
    expect(silent.lark).not.toHaveBeenCalled()
  })

  it('respects the recovery switch and tells a resolved incident apart', async () => {
    const quiet = harness({ alertRecovery: false })
    expect(await quiet.alerts.notify(incident({ status: 'resolved' }), 'resolved')).toBe(false)
    const loud = harness()
    expect(await loud.alerts.notify(incident({ status: 'resolved' }), 'resolved')).toBe(true)
    expect(String(loud.lark.mock.calls[0]![2])).toContain('Incident resolved')
  })

  it('caps the alerts per UTC day and only counts sent messages', async () => {
    const { alerts, lark } = harness({ alertDailyLimit: 1 })
    expect(await alerts.notify(incident({ id: 'a' }), 'opened')).toBe(true)
    expect(await alerts.notify(incident({ id: 'b' }), 'opened')).toBe(false)
    expect(lark).toHaveBeenCalledTimes(1)
    const off = harness({ alertDailyLimit: 0 })
    expect(await off.alerts.notify(incident(), 'opened')).toBe(false)
  })

  it('logs a failed send and leaves the change unsent for the next attempt', async () => {
    const { alerts, lark, state, logs } = harness()
    lark.mockRejectedValueOnce(new Error('lark exploded'))
    expect(await alerts.notify(incident(), 'opened')).toBe(false)
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', scope: 'alerts' }))
    expect(state.size).toBe(0)
    lark.mockResolvedValueOnce({})
    expect(await alerts.notify(incident(), 'opened')).toBe(true)
  })
})
