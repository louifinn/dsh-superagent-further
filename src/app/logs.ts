/**
 * A bounded in-memory log of the plugin host's own logging. The panel reads it through `GET logs`; nothing is written to
 * disk, so the state directory keeps its single SQLite artefact. Entries are formatted at capture time because the Host
 * logger takes printf-style arguments (`%s`) and the panel must not receive format strings.
 */
import { format } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LogEntry { at: string; level: LogLevel; scope: string; message: string }
export type LogFilter = 'all' | 'warn' | 'error'
export interface LogsQuery { level?: LogFilter; scope?: string; limit?: number }
export interface LogsView { entries: LogEntry[]; level: LogFilter; scope: string }

const LOG_LIMIT = 400
const LOG_DEFAULT = 120

/** The levels a caller may filter on; `warn` keeps warnings and errors, `error` keeps errors only. */
export class Logs {
  private readonly entries: LogEntry[] = []
  constructor(private readonly now: () => Date = () => new Date(), private readonly limit = LOG_LIMIT) {}

  record(level: LogLevel, scope: string, message: string): void {
    this.entries.push({ at: this.now().toISOString(), level, scope, message })
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
  }

  /** Newest last, so the panel can render a reversed list without losing the ordering of one millisecond. */
  list(query: LogsQuery = {}): LogEntry[] {
    const limit = Math.max(1, Math.min(query.limit ?? LOG_DEFAULT, this.limit))
    const scope = query.scope?.trim()
    const level = query.level ?? 'all'
    const kept = this.entries.filter(entry =>
      (scope === undefined || scope === '' || entry.scope === scope)
      && (level === 'all' || (level === 'warn' ? entry.level === 'warn' || entry.level === 'error' : entry.level === 'error')))
    return kept.slice(-limit)
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
