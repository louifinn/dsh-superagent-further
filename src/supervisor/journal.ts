/**
 * Crash-safety journal for runtime version changes and drains.
 *
 * Every step writes the whole journal to a temporary file, fsyncs it, and renames it over `<stateDir>/runtime/journal.json`,
 * so a crash leaves either the previous or the new record, never a torn one. A record whose `status` is still `running` when
 * the supervisor starts means the previous process stopped between steps: the supervisor treats the recorded current version
 * as a recovery candidate, prefers a verified `current.json`, then `previous.json`, then the packaged runtime, and records
 * which one it recovered to. The journal never selects a runtime with a schema below the database's.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RuntimeDescriptor } from '../runtime-host.ts'

/** The steps of a runtime start, update, drain, or rollback. */
export type JournalPhase = 'prepare' | 'stage' | 'backup' | 'drain' | 'swap' | 'load' | 'init' | 'commit' | 'rollback'
/** One recorded step. `started` is written before the step runs; `done`/`failed` after it. */
export interface JournalStep {
  readonly phase: JournalPhase
  readonly state: 'started' | 'done' | 'failed' | 'skipped'
  readonly at: string
  readonly detail?: string
}
/** Why the supervisor did not start the recorded current version. */
export interface JournalRecovery {
  readonly at: string
  readonly from: string
  readonly to: string
  readonly reason: string
}
/** The whole on-disk journal. */
export interface JournalState {
  readonly api: 1
  readonly status: 'running' | 'committed' | 'failed'
  readonly operation: 'startup' | 'drain' | 'update'
  readonly phase: JournalPhase
  readonly updatedAt: string
  readonly steps: readonly JournalStep[]
  readonly current?: RuntimeDescriptor
  readonly previous?: RuntimeDescriptor | null
  /**
   * The pre-swap database backup (`runtime/backups/<version>-<timestamp>.sqlite`) made by the update engine. Recovery uses it
   * only when an interrupted update's candidate already migrated the database past the recorded baseline's schema.
   */
  readonly backup?: string
  readonly recovery?: JournalRecovery
}

const API = 1 as const

/**
 * Reads and writes the runtime journal, one operation at a time. Only the supervisor constructs this class; a runtime never
 * sees the file path, so a future runtime cannot write outside its contract.
 */
export class Journal {
  constructor(readonly path: string, private readonly now: () => string = () => new Date().toISOString()) {}

  /** Read the journal, or undefined when it is missing or unreadable (a torn file is treated as an interrupted start). */
  read(): JournalState | undefined {
    let text: string
    try { text = readFileSync(this.path, 'utf8') } catch { return undefined }
    try {
      const value = JSON.parse(text) as JournalState
      if (value === null || typeof value !== 'object' || !Array.isArray(value.steps)) return undefined
      return value
    } catch {
      return undefined
    }
  }

  /** The journal of a process that stopped between steps, if any. */
  interrupted(): JournalState | undefined {
    const state = this.read()
    return state !== undefined && state.status === 'running' ? state : undefined
  }

  /** Start a new operation: the record becomes `running` at `prepare`. */
  begin(operation: JournalState['operation'], current?: RuntimeDescriptor | null, previous?: RuntimeDescriptor | null): void {
    this.write({ api: API, status: 'running', operation, phase: 'prepare', updatedAt: this.now(),
      steps: [{ phase: 'prepare', state: 'started', at: this.now() }],
      ...(current === undefined ? {} : { current: current ?? undefined }), ...(previous === undefined ? {} : { previous }) })
  }

  /** Record the state of a phase around the step it names, keeping the earlier steps. */
  mark(phase: JournalPhase, state: JournalStep['state'], detail?: string): void {
    const state0 = this.read()
    if (state0 === undefined) return
    const steps = [...state0.steps, { phase, state, at: this.now(), ...(detail === undefined ? {} : { detail }) }]
    this.write({ ...state0, phase, updatedAt: this.now(), steps })
  }

  /**
   * Record the path of the pre-swap database backup, keeping every other field. The engine calls this right after the backup
   * succeeds; boot recovery reads it when an interrupted update's candidate migrated the database before the crash.
   */
  noteBackup(path: string): void {
    const state0 = this.read()
    if (state0 === undefined) return
    this.write({ ...state0, backup: path, updatedAt: this.now() })
  }

  /** Finish the operation: the recorded versions become the recovery baseline and the status becomes committed. */
  commit(info: { current?: RuntimeDescriptor | null; previous?: RuntimeDescriptor | null; recovery?: JournalRecovery }): void {
    const previous = this.read()
    const steps = [...(previous?.steps ?? []), { phase: 'commit' as const, state: 'done' as const, at: this.now() }]
    // An omitted version keeps what the journal already recorded (a drain commit has no new versions); an explicit null clears it.
    const current = info.current === undefined ? previous?.current : info.current
    const prior = info.previous === undefined ? previous?.previous : info.previous
    this.write({ api: API, status: 'committed', operation: previous?.operation ?? 'startup', phase: 'commit', updatedAt: this.now(), steps,
      ...(current === undefined || current === null ? {} : { current }),
      ...(prior === undefined || prior === null ? {} : { previous: prior }),
      ...(info.recovery === undefined ? {} : { recovery: info.recovery }) })
  }

  /** Finish a failed operation: the record stays recoverable and names the phase that failed. */
  fail(phase: JournalPhase, detail: string): void {
    const previous = this.read()
    const steps = [...(previous?.steps ?? []), { phase, state: 'failed' as const, at: this.now(), detail }]
    this.write({ api: API, status: 'failed', operation: previous?.operation ?? 'startup', phase, updatedAt: this.now(), steps,
      ...(previous?.current === undefined ? {} : { current: previous.current }),
      ...(previous?.previous === undefined ? {} : { previous: previous.previous }) })
  }

  /**
   * Write the record atomically: a synced temporary file in the same directory, renamed over the target, then the directory
   * is synced best-effort (Windows cannot fsync a directory; the rename is still atomic there).
   */
  private write(state: JournalState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    const descriptor = openSync(temporary, 'w', 0o600)
    try {
      writeSync(descriptor, `${JSON.stringify(state, null, 2)}\n`)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, this.path)
    let directory: number | undefined
    try {
      directory = openSync(dirname(this.path), 'r')
      fsyncSync(directory)
    } catch {
      // A directory handle cannot be fsynced on every platform (notably Windows); the rename above is still atomic.
    } finally {
      if (directory !== undefined) try { closeSync(directory) } catch { /* Already closed. */ }
    }
  }
}
