/**
 * A bounded in-memory log of the plugin host's own logging, with an optional durable sink. The panel reads the ring through
 * `GET logs`; when a sink is attached, every accepted entry is also appended to the rolling JSONL files under
 * `<stateDir>/logs`. Entries are formatted, redacted and folded at capture time because the Host logger takes printf-style
 * arguments (`%s`) and the panel must not receive format strings, credentials or a wall of identical lines.
 */
import { format } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LogEntry {
  at: string
  level: LogLevel
  scope: string
  message: string
  /** Structured metadata the operation recorded; never a message body, tool argument/result, report summary or setting value. */
  data?: Record<string, unknown>
}
export type LogFilter = 'all' | 'warn' | 'error'
/** The minimum level the ring and its sink accept; `info` drops debug events entirely. */
export type LogMinLevel = 'debug' | 'info'
export interface LogsQuery { level?: LogFilter; scope?: string; limit?: number; q?: string }
export interface LogsView { entries: LogEntry[]; level: LogFilter; scope: string; q?: string }
/** The write side of the durable log: one synchronous, non-throwing call per accepted entry. */
export interface LogSink { append(entry: LogEntry): void }

export const LOG_LIMIT = 2000
export const LOG_DEFAULT = 200
/** Consecutive identical entries inside this window are folded into the first plus a repeated-count summary. */
export const FOLD_WINDOW_MS = 60_000
/** Error and message text is capped; the durable sink independently caps a whole JSON line. */
export const TEXT_MAX = 500

const SECRET_WORD = /(?:authorization|token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i
const SECRET_PAIR = /(\b(?:authorization|token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)\b\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const ENV_PAIR = /\b([A-Z][A-Z0-9_]{2,})\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g

/** Caps text at `max` characters so one error cannot dominate the ring or a JSONL line. */
export function truncateText(text: string, max = TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`
}

/** Removes credentials and environment-variable values from one string; shared by the ring and the sink through `Logs.record`. */
export function redactText(text: string): string {
  return truncateText(text
    .replace(BEARER, 'Bearer <redacted>')
    .replace(SECRET_PAIR, '$1<redacted>')
    .replace(ENV_PAIR, '$1=<redacted>'))
}

/** Recursively redacts string values and secret-named keys of structured metadata. */
export function redactData(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(item => redactData(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, SECRET_WORD.test(key) ? '<redacted>' : redactData(item)]))
  }
  return value
}

/** The levels a caller may filter on; `warn` keeps warnings and errors, `error` keeps errors only. */
export class Logs {
  private readonly entries: LogEntry[] = []
  private sink?: LogSink
  /** Read on every entry, so a settings change takes effect without a restart. */
  private minimum: () => LogMinLevel = () => 'debug'
  /** The consecutive streak being folded: its first time, its last time, and how many entries it holds. */
  private fold?: { at: number; lastAt: number; level: LogLevel; scope: string; message: string; data?: Record<string, unknown>; count: number }
  constructor(private readonly now: () => Date = () => new Date(), private readonly limit = LOG_LIMIT) {}

  /** Attaches the durable sink; entries recorded before this call stay in the ring only. */
  attach(sink: LogSink): void { this.sink = sink }

  /** Sets the minimum accepted level. The callback is read per entry so settings edits apply immediately. */
  setMinLevel(read: () => LogMinLevel): void { this.minimum = read }

  record(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
    // Debug is a verbosity opt-in: when it is off, no debug event is created in the ring or on disk.
    let minimum: LogMinLevel = 'debug'
    try { minimum = this.minimum() } catch { minimum = 'info' }
    if (level === 'debug' && minimum === 'info') return
    const at = this.now()
    const clean = redactText(message)
    const cleanData = data === undefined ? undefined : redactData(data) as Record<string, unknown>
    const entry: LogEntry = { at: at.toISOString(), level, scope, message: clean }
    if (cleanData !== undefined) entry.data = cleanData
    // The sink only enqueues; it must never break a caller or feed a message back into the ring.
    try { this.sink?.append(entry) } catch { /* A log sink never fails its caller. */ }
    this.push(entry, at.getTime())
  }

  /** Newest last, so the panel can render a reversed list without losing the ordering of one millisecond. */
  list(query: LogsQuery = {}): LogEntry[] {
    const limit = Math.max(1, Math.min(query.limit ?? LOG_DEFAULT, this.limit))
    const scope = query.scope?.trim()
    const level = query.level ?? 'all'
    const q = query.q?.trim().toLowerCase() ?? ''
    const kept = this.entries.filter(entry =>
      (scope === undefined || scope === '' || entry.scope === scope)
      && (level === 'all' || (level === 'warn' ? entry.level === 'warn' || entry.level === 'error' : entry.level === 'error'))
      && (q === '' || entry.message.toLowerCase().includes(q) || entry.scope.toLowerCase().includes(q)
        || JSON.stringify(entry.data ?? {}).toLowerCase().includes(q)))
    return kept.slice(-limit)
  }

  /** Pushes one entry, folding a consecutive identical scope+message inside the window instead of growing the ring. */
  private push(entry: LogEntry, at: number): void {
    const fold = this.fold
    if (fold && fold.scope === entry.scope && fold.message === entry.message && at - fold.lastAt <= FOLD_WINDOW_MS) {
      fold.lastAt = at
      fold.count += 1
      return
    }
    this.flushFold()
    this.entries.push(entry)
    this.fold = { at, lastAt: at, level: entry.level, scope: entry.scope, message: entry.message, count: 1,
      ...(entry.data === undefined ? {} : { data: entry.data }) }
    this.trim()
  }

  /** Appends the repeated-count summary for the streak that just ended, if it repeated. */
  private flushFold(): void {
    const fold = this.fold
    this.fold = undefined
    if (!fold || fold.count <= 1) return
    this.entries.push({ at: new Date(fold.at).toISOString(), level: fold.level, scope: fold.scope,
      message: `${fold.message} (repeated ${fold.count} times)`, data: { ...fold.data, repeated: fold.count } })
    this.trim()
  }

  private trim(): void {
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
  }
}

export interface HostLogger {
  debug?(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
export type CaptureLogs = Required<Pick<HostLogger, 'debug' | 'info' | 'warn' | 'error'>>

/**
 * Wrap the Host logger so every plugin message is also kept for the panel. `format()` is what the Host logger itself does
 * with the trailing arguments; the original logger still receives the raw arguments, so console output is unchanged.
 */
export function captureLogs(logs: Logs, host: HostLogger, scope: string): CaptureLogs {
  const at = (level: LogLevel, args: unknown[]): void => {
    logs.record(level, scope, format(...args))
    const print = host[level]
    // Call through the logger object: a Host logger method may rely on its receiver.
    if (typeof print === 'function') print.apply(host, args)
  }
  return {
    debug: (...args) => at('debug', args),
    info: (...args) => at('info', args),
    warn: (...args) => at('warn', args),
    error: (...args) => at('error', args),
  }
}

/**
 * One capture factory over a single ring and Host logger, so every part of the plugin writes into the same bounded log
 * under its own scope. Each call returns a logger shaped like `captureLogs`.
 */
export function captureScopes(logs: Logs, host: HostLogger): (scope: string) => CaptureLogs {
  return scope => captureLogs(logs, host, scope)
}
