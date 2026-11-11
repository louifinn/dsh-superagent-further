// The durable JSONL log sink: one file per UTC day, size rotation, retention, a bounded queue, ACL-safe failures, and a close that flushes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LogFileSink } from '../src/app/log-files.ts'
import { Logs, type LogEntry } from '../src/app/logs.ts'

const dirs: string[] = []
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'dsh-log-files-')); dirs.push(dir); return dir }
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const lines = (path: string): LogEntry[] => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LogEntry)
const day = (date: Date): string => date.toISOString().slice(0, 10)

it('appends one JSON object per line and close() flushes the queue', async () => {
  const stateDir = scratch()
  const now = new Date(Date.UTC(2026, 10, 10, 9, 30))
  const sink = new LogFileSink({ stateDir, now: () => now, flushMs: 60_000 })
  const logs = new Logs(() => now)
  logs.attach(sink)
  logs.record('info', 'runtime', 'runtime ready', { ticket: 'ticket-1' })
  logs.record('warn', 'executor', 'assignment.retired')
  expect(sink.pending).toBe(2)
  await sink.close()

  const file = join(stateDir, 'logs', `${day(now)}.jsonl`)
  expect(existsSync(file)).toBe(true)
  const entries = lines(file)
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ at: now.toISOString(), level: 'info', scope: 'runtime', message: 'runtime ready', data: { ticket: 'ticket-1' } })
  expect(entries[1]).toMatchObject({ level: 'warn', scope: 'executor', message: 'assignment.retired' })
})

it('rotates by UTC day', async () => {
  const stateDir = scratch()
  let now = new Date(Date.UTC(2026, 10, 10, 23, 59))
  const sink = new LogFileSink({ stateDir, now: () => now, flushMs: 60_000 })
  const logs = new Logs(() => now)
  logs.attach(sink)
  logs.record('info', 'runtime', 'before midnight')
  sink.flush()
  now = new Date(Date.UTC(2026, 10, 11, 0, 1))
  logs.record('info', 'runtime', 'after midnight')
  sink.flush()
  await sink.close()

  expect(readdirSync(join(stateDir, 'logs')).sort()).toEqual(['2026-11-10.jsonl', '2026-11-11.jsonl'])
  expect(lines(join(stateDir, 'logs', '2026-11-10.jsonl'))[0]!.message).toBe('before midnight')
  expect(lines(join(stateDir, 'logs', '2026-11-11.jsonl'))[0]!.message).toBe('after midnight')
})

it('rotates a file that reaches its size limit into a numbered sibling', async () => {
  const stateDir = scratch()
  const now = new Date(Date.UTC(2026, 10, 10, 12))
  const sink = new LogFileSink({ stateDir, now: () => now, maxBytes: 80, flushMs: 60_000 })
  const logs = new Logs(() => now)
  logs.attach(sink)
  logs.record('info', 'runtime', 'first entry that fills the file')
  sink.flush()
  logs.record('info', 'runtime', 'second entry after rotation')
  sink.flush()
  await sink.close()

  expect(readdirSync(join(stateDir, 'logs')).sort()).toEqual(['2026-11-10.1.jsonl', '2026-11-10.jsonl'])
  expect(lines(join(stateDir, 'logs', '2026-11-10.jsonl'))[0]!.message).toBe('first entry that fills the file')
  expect(lines(join(stateDir, 'logs', '2026-11-10.1.jsonl'))[0]!.message).toBe('second entry after rotation')
})

it('prunes files older than the retention window at startup and day rollover', async () => {
  const stateDir = scratch()
  const logsDir = join(stateDir, 'logs')
  mkdirSync(logsDir)
  for (const name of ['2026-10-01.jsonl', '2026-11-03.2.jsonl', '2026-11-08.jsonl', '2026-11-09.jsonl', 'keep.txt']) writeFileSync(join(logsDir, name), '')
  let now = new Date(Date.UTC(2026, 10, 10, 12))
  const sink = new LogFileSink({ stateDir, now: () => now, retentionDays: () => 3, flushMs: 60_000 })
  expect(readdirSync(logsDir).sort()).toEqual(['2026-11-08.jsonl', '2026-11-09.jsonl', 'keep.txt'])

  // One more day ages 2026-11-08 out; the same sink prunes when the day changes.
  now = new Date(Date.UTC(2026, 10, 11, 0, 1))
  sink.append({ at: now.toISOString(), level: 'info', scope: 'runtime', message: 'new day', data: undefined })
  sink.flush()
  await sink.close()
  expect(readdirSync(logsDir).sort()).toEqual(['2026-11-09.jsonl', '2026-11-11.jsonl', 'keep.txt'])
})

it('drops entries beyond the bounded queue and counts them', async () => {
  const stateDir = scratch()
  const now = new Date(Date.UTC(2026, 10, 10, 12))
  const sink = new LogFileSink({ stateDir, now: () => now, maxQueue: 2, flushMs: 60_000 })
  const logs = new Logs(() => now)
  logs.attach(sink)
  logs.record('info', 'runtime', 'one')
  logs.record('info', 'runtime', 'two')
  logs.record('info', 'runtime', 'three')
  expect(sink.pending).toBe(2)
  expect(sink.dropped).toBe(1)
  await sink.close()
  expect(lines(join(stateDir, 'logs', `${day(now)}.jsonl`)).map(entry => entry.message)).toEqual(['one', 'two'])
})

it('never throws when the log directory cannot be created, and reports the failure once', async () => {
  const stateDir = scratch()
  // A file where the log directory belongs makes mkdir fail on every platform.
  writeFileSync(join(stateDir, 'logs'), 'not a directory')
  const states: string[] = []
  const now = new Date(Date.UTC(2026, 10, 10, 12))
  const sink = new LogFileSink({ stateDir, now: () => now, flushMs: 60_000, onState: state => states.push(state) })
  const logs = new Logs(() => now)
  logs.attach(sink)
  expect(() => logs.record('info', 'runtime', 'cannot be written')).not.toThrow()
  sink.flush()
  await sink.close()
  expect(states[0]).toBe('error')
  expect(sink.dropped).toBeGreaterThan(0)
})

it('escapes newlines and caps every line at 8 KiB', async () => {
  const stateDir = scratch()
  const now = new Date(Date.UTC(2026, 10, 10, 12))
  const sink = new LogFileSink({ stateDir, now: () => now, flushMs: 60_000 })
  sink.append({ at: now.toISOString(), level: 'info', scope: 'runtime', message: `line one\nline two\t${'x'.repeat(20_000)}` })
  await sink.close()
  const text = readFileSync(join(stateDir, 'logs', `${day(now)}.jsonl`), 'utf8').trim()
  expect(text.split('\n')).toHaveLength(1)
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8 * 1024)
  const entry = JSON.parse(text) as LogEntry
  expect(entry.message).not.toContain('\n')
})
