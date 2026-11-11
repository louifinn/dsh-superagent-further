// The bounded Host log: ordering, level and scope filters, limits, and the logger capture wrapper.
import { expect, it, vi } from 'vitest'
import { Logs, captureLogs } from '../src/app/logs.ts'

const at = (logs: Logs, level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string) => logs.record(level, scope, message)

it('keeps entries newest-last, trims to its limit, and filters by level and scope', () => {
  let tick = 0
  const logs = new Logs(() => new Date(Date.UTC(2026, 10, 10, 0, 0, tick++)), 4)
  at(logs, 'info', 'github', 'polled')
  at(logs, 'warn', 'feishu', 'slow')
  at(logs, 'error', 'github', 'failed')
  at(logs, 'debug', 'host', 'detail')
  at(logs, 'info', 'host', 'trimmed out')
  expect(logs.list().map(entry => entry.message)).toEqual(['slow', 'failed', 'detail', 'trimmed out'])
  expect(logs.list({ level: 'warn' }).map(entry => entry.message)).toEqual(['slow', 'failed'])
  expect(logs.list({ level: 'error' }).map(entry => entry.message)).toEqual(['failed'])
  expect(logs.list({ scope: 'github' }).map(entry => entry.message)).toEqual(['failed'])
  expect(logs.list({ scope: ' github ' }).map(entry => entry.message)).toEqual(['failed'])
  expect(logs.list({ limit: 2 }).map(entry => entry.message)).toEqual(['detail', 'trimmed out'])
  expect(logs.list({ limit: 99 }).length).toBe(4)
  expect(logs.list()[0]).toEqual({ at: '2026-11-10T00:00:01.000Z', level: 'warn', scope: 'feishu', message: 'slow' })
})

it('searches message, scope and structured data case-insensitively, and returns everything with an empty query', () => {
  const logs = new Logs(() => new Date(Date.UTC(2026, 10, 10)), 20)
  logs.record('info', 'assignment', 'assignment.launched ticket=t1')
  logs.record('warn', 'feishu', 'poll failed: timeout')
  logs.record('info', 'runtime', 'decision.recorded', { ticket: 'ticket-42', kind: 'Policy' })

  expect(logs.list({ q: 'LAUNCHED' }).map(entry => entry.message)).toEqual(['assignment.launched ticket=t1'])
  expect(logs.list({ q: 'feishu' }).map(entry => entry.message)).toEqual(['poll failed: timeout'])
  // The keyword is only in the structured data, so this proves data is searched too.
  expect(logs.list({ q: 'POLICY' }).map(entry => entry.message)).toEqual(['decision.recorded'])
  expect(logs.list({ q: 'ticket-42' }).map(entry => entry.message)).toEqual(['decision.recorded'])
  expect(logs.list({ q: '' })).toHaveLength(3)
  expect(logs.list({ q: '  ' })).toHaveLength(3)
  expect(logs.list({ q: 'missing' })).toHaveLength(0)
})

it('captures printf-style arguments for the panel while still calling the Host logger', () => {
  const logs = new Logs()
  const host = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const capture = captureLogs(logs, host, 'host')
  capture.info('polled %s at %d', 'github', 3)
  capture.warn('slow round')
  capture.debug?.('debug detail')
  capture.error('failed %o', { code: 42 })
  expect(logs.list().map(entry => [entry.level, entry.scope, entry.message])).toEqual([
    ['info', 'host', 'polled github at 3'],
    ['warn', 'host', 'slow round'],
    ['debug', 'host', 'debug detail'],
    ['error', 'host', "failed { code: 42 }"],
  ])
  expect(host.info).toHaveBeenCalledWith('polled %s at %d', 'github', 3)
  expect(host.warn).toHaveBeenCalledWith('slow round')
  expect(host.error).toHaveBeenCalledWith('failed %o', { code: 42 })
})
