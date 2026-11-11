/**
 * The supervisor-owned runtime update engine (ADR-0007).
 *
 * An operator stages a built runtime under `<stateDir>/runtime/<version>/` and writes
 * `<stateDir>/updates/request.json`. While the supervisor runs, this engine polls that file on an unref'd timer, claims it
 * with an atomic rename, and drives one journaled operation:
 *
 *   prepare → stage (verify the candidate and refuse a schema downgrade) → backup (`VACUUM INTO`) → drain → swap
 *   (previous.json = old current, then current.json = new) → load → init (readiness + self-check) → commit.
 *
 * A failure after the backup restores the database, restores both pointers, and starts the previous runtime (or the
 * packaged fallback); the journal records `rollback` and the history records the outcome. Nothing is ever rethrown into the
 * DSH fiber: an update failure is an incident and a status, not a host crash. The journal remains the crash truth: a
 * `running` update found at startup is reported as `interrupted` and its stale claim is cleared, never re-run.
 */
import { existsSync, renameSync } from 'node:fs'
import type { HostLogger, Logs } from '../app/logs.ts'
import type { DrainReport, RuntimeDescriptor } from '../runtime-host.ts'
import type { Journal, JournalPhase } from './journal.ts'
import type { LoadedRuntime, PackagedRuntime } from './loader.ts'
import { currentPointer, previousPointer, runtimeDirectory, type RuntimeSource } from './versions.ts'
import {
  appendUpdateHistory, backupDatabase, claimUpdateRequest, readPointerBytes, readUpdateRequest, releaseUpdateClaim,
  removeDescriptorFile, restoreDatabase, restorePointerBytes, shortReason, stagedDescriptor, updateProcessingPath, updateRequestPath,
  writeDescriptorFile, type UpdateHistoryEntry, type UpdateOutcome, type UpdateRequest,
} from './update-state.ts'

/** The supervisor side of the update engine; the engine owns the state machine, the supervisor owns the runtime. */
export interface UpdateEnvironment {
  readonly stateDir: string
  readonly journal: Journal
  /** The supervisor's process-wide ring: every update phase is visible to the panel and to incident detection. */
  readonly logs: Logs
  readonly logger: HostLogger
  readonly now: () => string
  readonly readyTimeoutMs: number
  readonly disposeMs: number
  /** The descriptor currently serving, if any. */
  current(): RuntimeDescriptor | undefined
  /** The recorded previous descriptor, if any. */
  previous(): RuntimeDescriptor | undefined
  /** Verify one staged descriptor against the runtime directory and the database's schema. */
  verify(descriptor: RuntimeDescriptor): { entry?: string; reason?: string }
  /** The packaged runtime, the last-resort recovery candidate. */
  packaged(): PackagedRuntime | undefined
  /** Build a host and load one verified entry; the thrown error is the loader's own refusal. */
  load(descriptor: RuntimeDescriptor, entry: string): Promise<LoadedRuntime>
  /** Bound the candidate's readiness and run the configured()/setupProblem self-check; a failure disposes it. */
  ready(loaded: LoadedRuntime, version: string): Promise<void>
  /** Make a loaded, ready runtime the one serving: record, status and version pointer in memory. */
  serve(loaded: LoadedRuntime, descriptor: RuntimeDescriptor): void
  /** Dispose a candidate that never served, bounded, without touching the serving runtime. */
  discard(loaded: LoadedRuntime, version: string): Promise<void>
  /** Drain the serving runtime with the update reason, flush the sink, and clear the serving slot. */
  drain(reason: string): Promise<DrainReport>
  /** Clear the serving status when even the rollback could not start a runtime. */
  unserved(): void
}

/** Test seam: the poll interval; production uses two seconds. */
export interface UpdateEngineOptions { readonly pollMs?: number }

/** The engine is a single-flight state machine: one request at a time, one poll timer, one stop promise. */
export class UpdateEngine {
  private timer?: ReturnType<typeof setInterval>
  private inflight?: Promise<void>
  private stopping?: Promise<void>
  private readonly pollMs: number
  /** Set while `stop()` runs, so an in-flight attempt is not extended by a new poll. */
  private stopped = false

  constructor(private readonly env: UpdateEnvironment, options: UpdateEngineOptions = {}) {
    this.pollMs = options.pollMs ?? 2_000
  }

  /** True while a claim is being processed; the panel reports it and a second request is refused. */
  get busy(): boolean { return this.inflight !== undefined }

  /**
   * Start polling and recover a crash left behind by a previous process. Recovery only cleans the claim and records an
   * `interrupted` history entry; the journal's recovery during boot already chose which version serves, so a failed swap
   * is never re-run.
   */
  start(interrupted?: ReturnType<Journal['interrupted']>): void {
    this.recoverStale(interrupted)
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.tick() }, this.pollMs)
    this.timer.unref?.()
    void this.tick()
  }

  /** Stop polling and let an in-flight attempt finish; safe to call twice and safe before `start()`. */
  stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined }
    return this.stopping ??= (async () => { try { await this.inflight } catch { /* Poll failures are logged by the attempt. */ } })()
  }

  /**
   * Process at most one pending request. The timer calls this; tests call it directly. Every failure is converted to a
   * journal failure, a history entry and a ring line, so this promise never rejects.
   */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.poll().catch(error => {
      this.line('error', `update.tick-error reason=${shortReason(error instanceof Error ? error.message : String(error))}`)
    }).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    const claim = claimUpdateRequest(this.env.stateDir)
    if (claim.request !== undefined) { await this.run(claim.request); return }
    if (claim.reason === 'none') return
    if (claim.reason === 'processing') {
      // A claim left by this process would be in flight; one found by a poll is stale (a crash during the hand-off).
      this.recoverStale(undefined)
      return
    }
    this.reject(claim.detail ?? (claim.reason === 'unsupported' ? 'the request file could not be claimed' : 'the request is invalid'))
  }

  /** Refuse a malformed or unclaimable request: record it, keep a copy beside it, and leave the serving runtime untouched. */
  private reject(reason: string): void {
    const requestPath = updateRequestPath(this.env.stateDir)
    const parsed = readUpdateRequest(requestPath)
    const id = parsed.request?.id ?? 'unknown'
    const action = parsed.request?.action ?? 'unknown'
    if (existsSync(requestPath)) {
      try { renameSync(requestPath, `${requestPath}.rejected-${Date.now()}`) } catch { /* The history entry still records the refusal. */ }
    }
    this.line('warn', `update.rejected id=${id} reason=${shortReason(reason)}`)
    appendUpdateHistory(this.env.stateDir, { id, action, outcome: 'rejected', version: parsed.request?.version ?? null,
      from: this.env.current()?.version ?? null, phase: null, reason: shortReason(reason), durationMs: null })
  }

  /** A crash left a claimed request and/or a running update journal; clear the claim, never re-run the swap. */
  private recoverStale(interrupted: ReturnType<Journal['interrupted']>): void {
    const processing = updateProcessingPath(this.env.stateDir)
    const claimed = readUpdateRequest(processing)
    if (interrupted === undefined && !claimed.present) return
    const journal = interrupted ?? this.env.journal.read()
    const request = claimed.request
    releaseUpdateClaim(this.env.stateDir)
    // A process that committed and then died before deleting the claim completed the update; do not report a failure.
    if (interrupted === undefined && journal?.status === 'committed') {
      this.line('info', `update.claim-cleared phase=commit id=${request?.id ?? 'unknown'}`)
      return
    }
    const id = request?.id ?? (journal === undefined ? 'interrupted' : `interrupted-${Date.parse(journal.updatedAt) || 0}`)
    const phase = journal?.phase ?? null
    const reason = journal === undefined
      ? 'a stale update request claim was found without a running journal'
      : `an interrupted update stopped at ${journal.phase}`
    this.line('warn', `update.interrupted phase=${phase ?? 'unknown'} reason=${shortReason(reason)}`)
    appendUpdateHistory(this.env.stateDir, { id, action: request?.action ?? 'unknown', outcome: 'interrupted',
      version: journal?.current?.version ?? request?.version ?? null, from: journal?.previous?.version ?? null, phase,
      reason: shortReason(reason), durationMs: null })
  }

  /** Drive one claimed request through the phases. */
  private async run(request: UpdateRequest): Promise<void> {
    const env = this.env
    const stateDir = env.stateDir
    const runtimeDir = runtimeDirectory(stateDir)
    const journal = env.journal
    const startedAt = env.now()
    const startedMs = Date.now()
    const current = env.current()
    const previous = env.previous()
    let phase: JournalPhase = 'prepare'
    let target: RuntimeDescriptor | undefined
    let entry: string | undefined
    let loaded: LoadedRuntime | undefined
    let backup: string | undefined
    let pointersSaved = false
    let currentBytes: Buffer | undefined
    let previousBytes: Buffer | undefined
    let swapped = false
    let served = false
    try {
      journal.begin('update', current ?? null, previous ?? null)
      journal.mark('prepare', 'done', `update ${request.id} requested by ${request.by} at ${request.at}`)
      phase = 'stage'
      journal.mark('stage', 'started', `verifying the ${request.action} request`)
      target = this.target(request, current)
      const verified = env.verify(target)
      if (verified.entry === undefined) throw new Error(verified.reason ?? `the ${target.version} runtime does not verify`)
      entry = verified.entry
      journal.mark('stage', 'done', `version ${target.version} verified (schema ${target.schema ?? 'unknown'})`)
      this.line('info', `update.staged version=${target.version} action=${request.action} id=${request.id}`)

      phase = 'backup'
      journal.mark('backup', 'started', 'copying the database before the swap')
      backup = backupDatabase(stateDir, target.version, env.now())
      journal.mark('backup', backup === undefined ? 'skipped' : 'done',
        backup === undefined ? 'no database exists yet, so there is nothing to back up' : `database backed up to ${backup}`)

      phase = 'drain'
      journal.mark('drain', 'started', 'draining the running runtime: update')
      const report = await env.drain('update')
      if (!report.completed) throw new Error('the runtime drain did not complete every phase')
      journal.mark('drain', 'done', 'the running runtime drained')

      phase = 'swap'
      journal.mark('swap', 'started', 'writing the version pointers')
      pointersSaved = true
      currentBytes = readPointerBytes(currentPointer(runtimeDir))
      previousBytes = readPointerBytes(previousPointer(runtimeDir))
      const baseline = current ?? previous ?? null
      if (baseline !== null) writeDescriptorFile(previousPointer(runtimeDir), baseline)
      else removeDescriptorFile(previousPointer(runtimeDir))
      writeDescriptorFile(currentPointer(runtimeDir), target)
      swapped = true
      journal.mark('swap', 'done', `current=${target.version} previous=${baseline?.version ?? 'none'}`)

      phase = 'load'
      journal.mark('load', 'started', `loading the ${target.version} runtime`)
      loaded = await env.load(target, entry)
      journal.mark('load', 'done')

      phase = 'init'
      journal.mark('init', 'started', 'waiting for the runtime to become ready')
      await env.ready(loaded, target.version)
      journal.mark('init', 'done')

      phase = 'commit'
      journal.mark('commit', 'started', 'publishing the new runtime')
      env.serve(loaded, target)
      served = true
      loaded = undefined
      try {
        journal.commit({ current: env.current() ?? target, previous: current ?? previous ?? null })
      } catch (error) {
        // The runtime is already serving and the phases are on disk; a journal write failure must not undo it. The next
        // boot sees the phases and recovers by verification.
        this.line('warn', `update.journal-write-failed id=${request.id} reason=${shortReason(message(error))}`)
      }
      releaseUpdateClaim(stateDir)
      this.record(request, target.version, current?.version ?? null, 'applied', 'commit', null, startedAt, startedMs)
      this.line('info', `update.applied version=${target.version} from=${current?.version ?? 'none'} id=${request.id} durationMs=${Date.now() - startedMs}`)
    } catch (error) {
      const reason = shortReason(message(error))
      let restored = false
      let rollbackProblem: string | undefined
      if (loaded !== undefined && !served) {
        try { await env.discard(loaded, target?.version ?? 'failed') } catch (discardError) {
          rollbackProblem = message(discardError)
        }
        loaded = undefined
      }
      if (backup !== undefined || swapped) {
        try {
          if (backup !== undefined) restoreDatabase(stateDir, backup)
          if (pointersSaved) {
            restorePointerBytes(currentPointer(runtimeDir), currentBytes)
            restorePointerBytes(previousPointer(runtimeDir), previousBytes)
          }
          restored = await this.restoreRuntime(current)
          if (!restored) throw new Error('the previous runtime could not be restarted after the rollback')
        } catch (rollbackError) {
          rollbackProblem = rollbackProblem === undefined ? message(rollbackError) : `${rollbackProblem}; ${message(rollbackError)}`
          restored = false
        }
        try {
          journal.fail('rollback', rollbackProblem === undefined ? reason : `${reason}; the rollback could not complete: ${rollbackProblem}`)
        } catch (journalError) {
          this.line('error', `update.journal-write-failed id=${request.id} reason=${shortReason(message(journalError))}`)
        }
      } else {
        try { journal.fail(phase, reason) } catch (journalError) {
          this.line('error', `update.journal-write-failed id=${request.id} reason=${shortReason(message(journalError))}`)
        }
      }
      if (!restored && swapped) env.unserved()
      releaseUpdateClaim(stateDir)
      const outcome: UpdateOutcome = restored ? 'rolledback' : 'failed'
      this.record(request, target?.version ?? null, current?.version ?? null, outcome, restored ? 'rollback' : phase,
        rollbackProblem === undefined ? reason : `${reason}; rollback: ${rollbackProblem}`, startedAt, startedMs)
      this.line('error', `update.failed phase=${phase} version=${target?.version ?? 'unknown'} id=${request.id} reason=${reason}`)
      if (restored) this.line('info', `update.rolledback version=${current?.version ?? 'unknown'} from=${target?.version ?? 'unknown'} id=${request.id}`)
    }
  }

  /** Resolve what to apply: a staged version for `apply`, the recorded previous runtime for `rollback`. */
  private target(request: UpdateRequest, current: RuntimeDescriptor | undefined): RuntimeDescriptor {
    if (request.action === 'rollback') {
      const previous = this.env.previous()
      if (previous === undefined) throw new Error('no previous runtime is recorded, so there is nothing to roll back to')
      if (previous.version === current?.version) throw new Error(`version ${previous.version} is already running`)
      return previous
    }
    const version = request.version
    if (version === undefined) throw new Error('an apply request must name a version')
    const staged = stagedDescriptor(this.env.stateDir, version)
    if (staged.descriptor === undefined) {
      throw new Error(`version ${version} is not staged under ${runtimeDirectory(this.env.stateDir)}: ${staged.reason ?? 'runtime-manifest.json is missing'}`)
    }
    if (staged.descriptor.version !== version) {
      throw new Error(`the staged directory ${version} contains version ${staged.descriptor.version}`)
    }
    if (version === current?.version) throw new Error(`version ${version} is already running`)
    return staged.descriptor
  }

  /** Start the previous (else packaged) runtime after a rollback; every attempt is verified and bounded. */
  private async restoreRuntime(fallback: RuntimeDescriptor | undefined): Promise<boolean> {
    const attempts: { descriptor: RuntimeDescriptor; entry: string; source: RuntimeSource }[] = []
    if (fallback !== undefined) {
      const verified = this.env.verify(fallback)
      if (verified.entry !== undefined) attempts.push({ descriptor: fallback, entry: verified.entry, source: 'previous' })
      else this.line('warn', `update.rollback-unavailable version=${fallback.version} reason=${shortReason(verified.reason ?? 'does not verify')}`)
    }
    const packaged = this.env.packaged()
    if (packaged !== undefined) attempts.push({ descriptor: packaged.descriptor, entry: packaged.entry, source: 'packaged' })
    for (const attempt of attempts) {
      let loaded: LoadedRuntime | undefined
      try {
        loaded = await this.env.load(attempt.descriptor, attempt.entry)
        await this.env.ready(loaded, attempt.descriptor.version)
        this.env.serve(loaded, attempt.descriptor)
        this.line('info', `update.recovery version=${attempt.descriptor.version} source=${attempt.source}`)
        return true
      } catch (error) {
        this.line('warn', `update.recovery-failed version=${attempt.descriptor.version} source=${attempt.source} reason=${shortReason(message(error))}`)
        if (loaded !== undefined) {
          try { await this.env.discard(loaded, attempt.descriptor.version) } catch { /* Already disposed by readiness. */ }
        }
      }
    }
    return false
  }

  private record(request: UpdateRequest, version: string | null, from: string | null, outcome: UpdateOutcome,
    phase: JournalPhase | null, reason: string | null, at: string, startedMs: number): UpdateHistoryEntry {
    try {
      return appendUpdateHistory(this.env.stateDir, { id: request.id, action: request.action, outcome, version, from, phase,
        reason: reason === null ? null : shortReason(reason), durationMs: Math.max(0, Date.now() - startedMs), at })
    } catch (error) {
      this.line('warn', `update.history-write-failed id=${request.id} reason=${shortReason(message(error))}`)
      return { api: 1, id: request.id, action: request.action, outcome, version, from, phase, reason, at,
        durationMs: Math.max(0, Date.now() - startedMs) }
    }
  }

  /** Record one line in the supervisor's ring; the panel and update-failure detection read the same entries. */
  private line(level: 'info' | 'warn' | 'error', text: string): void {
    try { this.env.logs.record(level, 'update', shortReason(text)) } catch { /* A ring write never fails an update. */ }
  }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
