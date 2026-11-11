/**
 * Durable, owner-only JSONL log files under `<stateDir>/logs`. One file per UTC day named `YYYY-MM-DD.jsonl`; when a file
 * reaches 20 MiB it rotates to `YYYY-MM-DD.N.jsonl`. Files older than the retention window are pruned at startup and on each
 * day rollover. `Logs.record` only enqueues; a 50 ms unref timer flushes batches so logging never blocks the caller. Every
 * failure (a full disk, a denied ACL, a missing directory) is counted and reported once through the `logs` health claim, and
 * no path in this module throws into its caller or writes a log entry itself.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { restrictToOwner } from '../infra/acl.ts'
import type { LogEntry, LogSink } from './logs.ts'

const DAY_MS = 86_400_000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_QUEUE = 10_000
const DEFAULT_FLUSH_MS = 50
/** One JSON line never exceeds this; longer messages are shortened and their structured data dropped. */
const LINE_MAX = 8 * 1024

export interface LogFileSinkOptions {
  readonly stateDir: string
  readonly now?: () => Date
  /** Current retention window, read on every prune so a settings edit applies without a restart. */
  readonly retentionDays?: () => number
  readonly maxBytes?: number
  readonly maxQueue?: number
  readonly flushMs?: number
  /** Reports a write failure once, and the first success after it, for the Runtime's `logs` health claim. */
  readonly onState?: (state: 'ready' | 'error', detail: string) => void
}

/** The UTC day of an ISO timestamp, or of `now` when the timestamp is malformed. */
const utcDay = (value: string | Date): string => (typeof value === 'string' ? new Date(value) : value).toISOString().slice(0, 10)

/** The durable sink behind `Logs`: batches entries into UTC day files, rotates at 20 MiB, prunes by retention and reports a failure once. */
export class LogFileSink implements LogSink {
  readonly dir: string
  private readonly now: () => Date
  private readonly retention: () => number
  private readonly maxBytes: number
  private readonly maxQueue: number
  private readonly flushMs: number
  private readonly onState?: (state: 'ready' | 'error', detail: string) => void
  private readonly pendingEntries: LogEntry[] = []
  private timer?: ReturnType<typeof setTimeout>
  private fd?: number
  private path?: string
  private openDay?: string
  private slot = 0
  private closed = false
  private failing = false
  private aclWarned = false
  private droppedCount = 0
  /** The retention window the last prune applied, so a settings edit re-prunes on the next flush. */
  private prunedFor = 0

  constructor(options: LogFileSinkOptions) {
    this.dir = join(options.stateDir, 'logs')
    this.now = options.now ?? (() => new Date())
    this.retention = options.retentionDays ?? (() => 7)
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES)
    this.maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_MAX_QUEUE)
    this.flushMs = Math.max(1, options.flushMs ?? DEFAULT_FLUSH_MS)
    this.onState = options.onState
    this.prepare()
  }

  /** How many accepted entries are waiting for the next flush. */
  get pending(): number { return this.pendingEntries.length }
  /** How many entries were dropped because the queue was full, the write failed, or the sink was closed. */
  get dropped(): number { return this.droppedCount }

  /** Enqueue one accepted entry; this is the only hot path and it never throws or waits on disk. */
  append(entry: LogEntry): void {
    if (this.closed || this.pendingEntries.length >= this.maxQueue) { this.droppedCount += 1; return }
    this.pendingEntries.push(entry)
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, this.flushMs)
    this.timer.unref?.()
  }

  /** Write everything queued, grouping entries by their UTC day; failures drop that group and count every line. */
  flush(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    // A retention edit applies on the next flush even when no entry arrived, so the setting needs no restart.
    const retention = this.retentionWindow()
    if (retention !== this.prunedFor) {
      try { this.prune(utcDay(this.now()), retention) } catch (error) { this.fail(error) }
    }
    if (!this.pendingEntries.length) return
    const batch = this.pendingEntries.splice(0)
    const groups = new Map<string, string[]>()
    for (const entry of batch) {
      try {
        const day = utcDay(entry.at)
        const lines = groups.get(day)
        if (lines) lines.push(this.line(entry))
        else groups.set(day, [this.line(entry)])
      } catch {
        this.droppedCount += 1
      }
    }
    for (const [day, lines] of groups) {
      if (!lines.length) continue
      try {
        this.ensureDay(day)
        if (this.fd === undefined) throw new Error('the log file is not open')
        writeSync(this.fd, lines.join('\n') + '\n')
        this.afterWrite()
        this.recover()
      } catch (error) {
        this.droppedCount += lines.length
        this.fail(error)
      }
    }
  }

  /** Flush synchronously and stop accepting entries; the Runtime awaits this before closing its Store. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.flush()
    this.closed = true
    this.closeFile()
    return Promise.resolve()
  }

  private prepare(): void {
    try {
      this.ensureDir()
      this.prune(utcDay(this.now()))
    } catch (error) {
      this.fail(error)
    }
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try { restrictToOwner(this.dir, true) } catch (error) { this.warnAcl(error) }
  }

  /** Opens the day's file (or the next numbered rotation) and applies the owner-only file mode. */
  private ensureDay(day: string): void {
    if (this.openDay !== day) {
      this.closeFile()
      this.openDay = day
      this.slot = 0
      this.ensureDir()
      this.prune(day)
    }
    if (this.fd !== undefined) return
    let path = this.pathFor(day, this.slot)
    if (existsSync(path) && statSync(path).size >= this.maxBytes) {
      this.slot += 1
      path = this.pathFor(day, this.slot)
    }
    while (existsSync(path) && statSync(path).size >= this.maxBytes) {
      this.slot += 1
      path = this.pathFor(day, this.slot)
    }
    this.fd = openSync(path, 'a', 0o600)
    this.path = path
    // openSync's mode applies only when it creates the file; chmod and the Windows ACL also cover an existing one.
    try { chmodSync(path, 0o600) } catch { /* Windows has no POSIX mode. */ }
    try { restrictToOwner(path, false) } catch (error) { this.warnAcl(error) }
  }

  /** Closes the current file once it reached the size limit, so the next flush rotates. */
  private afterWrite(): void {
    if (this.fd === undefined || this.path === undefined) return
    try { if (statSync(this.path).size >= this.maxBytes) this.closeFile() } catch { /* The next flush retries. */ }
  }

  private pathFor(day: string, slot: number): string { return join(this.dir, slot === 0 ? `${day}.jsonl` : `${day}.${slot}.jsonl`) }

  private closeFile(): void {
    const fd = this.fd
    this.fd = undefined
    if (fd === undefined) return
    try { closeSync(fd) } catch { /* Nothing left to do with a descriptor that already failed. */ }
  }

  /** Deletes this day's and older files outside the retention window; malformed names are left alone. */
  private prune(day: string, days = this.retentionWindow()): void {
    this.prunedFor = days
    const cutoff = new Date(Date.parse(`${day}T00:00:00.000Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10)
    for (const name of readdirSync(this.dir)) {
      const match = /^(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl$/.exec(name)
      if (!match) continue
      if (match[1]! >= cutoff) continue
      try { unlinkSync(join(this.dir, name)) } catch (error) { this.fail(error) }
    }
  }

  /** The configured retention clamped to the supported window; a throwing callback falls back to seven days. */
  private retentionWindow(): number {
    try { return Math.max(1, Math.min(30, Math.floor(this.retention()))) } catch { return 7 }
  }

  /**
   * Renders one entry as a single JSON line. A line over 8 KiB drops structured data and halves the message until it fits, so
   * an error body, a newline or a control character can never break the file format.
   */
  private line(entry: LogEntry): string {
    const base = { at: entry.at, level: entry.level, scope: entry.scope }
    const render = (message: string, data?: Record<string, unknown>): string =>
      JSON.stringify({ ...base, message, ...(data === undefined ? {} : { data }) })
    let message = entry.message.replace(/[\u0000-\u001f\u007f]+/g, ' ')
    let data = entry.data
    if (Buffer.byteLength(render(message, data), 'utf8') <= LINE_MAX) return render(message, data)
    data = undefined
    message = message.slice(0, Math.min(message.length, 4000))
    while (message.length > 0 && Buffer.byteLength(render(message, data), 'utf8') > LINE_MAX) {
      message = message.slice(0, Math.floor(message.length / 2))
    }
    return render(`${message}...`)
  }

  private fail(error: unknown): void {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()
    if (this.failing) return
    this.failing = true
    this.report('error', detail || 'the log file could not be written')
  }

  private recover(): void {
    if (!this.failing) return
    this.failing = false
    this.report('ready', '')
  }

  private report(state: 'ready' | 'error', detail: string): void {
    try { this.onState?.(state, detail) } catch { /* Health reporting never breaks logging. */ }
  }

  private warnAcl(error: unknown): void {
    if (this.aclWarned) return
    this.aclWarned = true
    // A denied ACL degrades to the process's inherited access; it must not stop startup or the sink.
    try { process.emitWarning(`Could not restrict the log files to the owner: ${error instanceof Error ? error.message : String(error)}`, 'LogFileSink') } catch { /* A warning is best effort. */ }
  }
}
