/**
 * The stable supervisor shell: the DSH plugin entry's only long-lived component.
 *
 * It owns everything that must survive a domain-runtime swap: the state-directory lock, the log ring and its durable sink,
 * the machine/config validation already performed by the plugin entry, version resolution, the loader and its packaged
 * fallback, the crash journal, and the drain controller. The runtime it starts receives all of them through the frozen
 * `RuntimeHost`; the runtime owns the database and the application composition and hands them back on drain.
 *
 * Order matters. The lock is taken before the database is even inspected, so a second host on the same state directory
 * fails with the "already hosted" message and migrates nothing. The database schema is read without opening the Store, so an
 * older deployed or packaged runtime is refused before it can touch a newer database.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import type { Context } from '@deepseek-ai/cordis'
import type { Machine } from '../deployment.ts'
import { bounded } from '../infra/bounded.ts'
import { restrictToOwner } from '../infra/acl.ts'
import type { LogFileSink } from '../app/log-files.ts'
import { Logs, type HostLogger } from '../app/logs.ts'
import type { SetupProblem } from '../setup.ts'
import { HOST_API, type DrainReport, type RuntimeDescriptor, type RuntimeHandle, type RuntimeHost } from '../runtime-host.ts'
import { VERSION } from '../version.ts'
import { DrainController } from './drain.ts'
import { buildRuntimeHost, type BuiltHost } from './host.ts'
import { Journal, type JournalRecovery } from './journal.ts'
import { loadRuntime, packagedRuntime, type LoadedRuntime, type PackagedRuntime } from './loader.ts'
import {
  databaseSchema, previousPointer, readDescriptorFile, resolveVersions, runtimeDirectory, type RuntimeCandidate, type RuntimeSource,
} from './versions.ts'

/** How long the supervisor waits for a runtime's `ready` before disposing it and trying the next candidate. */
export const READY_TIMEOUT_MS = 30_000
/** How long the supervisor waits for the durable log sink to close before continuing without it. */
export const FLUSH_LOGS_MS = 10_000
/** How long the supervisor waits for a state-directory lock release before warning and continuing with the journal. */
export const LOCK_RELEASE_MS = 10_000
/** How long the supervisor waits for a failed candidate's `dispose` before warning and trying the next candidate. */
export const DISPOSE_MS = 10_000

/** The resolved runtime and where it came from; the read-only version surface M36 exposes to the panel. */
export interface SupervisorStatus {
  readonly version: string
  readonly source: RuntimeSource
  readonly hostApi: number
  readonly schema?: number
  /** The recovery note, when startup had to abandon an interrupted journal's recorded version. */
  readonly recovery?: string
}

/** The plugin entry supplies the live Cordis context and the machine config; everything else has a production default. */
export interface SupervisorOptions {
  readonly context: Context
  readonly machine: Machine
  /** Restarts the DSH fiber after a Source account is saved. */
  readonly restart?: () => void
  /** Ends the host process after a management-API stop request. */
  readonly exit?: (code: number) => void
  readonly version?: string
  /** Test seam for the packaged runtime; production discovers it beside the installed package. */
  readonly packaged?: () => PackagedRuntime
  /** Test seam for the state-directory lock, which production takes with proper-lockfile. */
  readonly lock?: (stateDir: string) => () => Promise<void>
  /** Bound for a runtime's `ready`; tests shorten it. */
  readonly readyTimeoutMs?: number
  /** Bound for a failed runtime's `dispose`; tests shorten it. */
  readonly disposeMs?: number
  /** Bound for the durable log sink's close; tests shorten it. */
  readonly flushLogsMs?: number
  /** Bound for releasing the state-directory lock; tests shorten it. */
  readonly lockReleaseMs?: number
  /** Test seam: the supervisor-owned durable sink, shared across candidates instead of built beneath the state directory. */
  readonly logSink?: LogFileSink
  /** Journal timestamps. */
  readonly now?: () => string
}

/**
 * Starts exactly one runtime and keeps the shell stable around it. `start()` resolves after the runtime's `ready`; `stop()`
 * drives the drain contract, flushes the sink, and releases the lock even if a deployment failed mid-start.
 */
export class Supervisor {
  private readonly log: HostLogger
  private readonly now: () => string
  /** One process-wide ring for every candidate and every version; it outlives a failed start by design (ADR-0006). */
  private readonly logsRing = new Logs()
  private readonly lockLost = new AbortController()
  private ready?: Promise<void>
  private stopping?: Promise<void>
  private runtime?: RuntimeHandle
  private logSink?: LogFileSink
  private journal?: Journal
  private drainer?: DrainController
  private release?: () => Promise<void>
  private releaseTask?: Promise<void>
  private flushTask?: Promise<void>
  private releasing = false
  private record?: RuntimeDescriptor
  private statusValue?: SupervisorStatus

  constructor(private readonly options: SupervisorOptions) {
    this.log = options.context.logger as HostLogger
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** Resolve, load, and await the configured runtime. Rejects only when no candidate (including the packaged one) starts. */
  start(): Promise<void> {
    return this.ready ??= this.boot()
  }

  /** The current runtime's settings gate, as the plugin entry's startup log reports it. */
  configured(): boolean { return this.runtime?.configured?.() ?? false }
  /** The current runtime's setup problem, if the Host is paused waiting for an operator. */
  setupProblem(): SetupProblem | undefined { return this.runtime?.setupProblem }
  /** The runtime and version currently serving; M36 reads this for the Updates surface. */
  versionStatus(): SupervisorStatus | undefined { return this.statusValue }
  /** The supervisor-owned ring, for tests and a future diagnostics surface. It is the same instance for every attempt. */
  get logs(): Logs { return this.logsRing }
  /** The current runtime handle, for tests; production code goes through the plugin entry and the Host services. */
  get handle(): RuntimeHandle | undefined { return this.runtime }

  /**
   * Run the drain contract once through the supervisor's controller. Normal shutdown and the M36 update path share it; a
   * second call returns the first report and does nothing.
   */
  async drain(reason: string, signal?: AbortSignal): Promise<DrainReport> {
    this.releasing = true
    const runtime = this.runtime
    if (runtime === undefined) {
      await this.flushLogs()
      await this.releaseLock()
      const at = this.now()
      return { reason, startedAt: at, durationMs: 0, completed: false,
        phases: [{ phase: 'intake', status: 'skipped', startedAt: at, durationMs: 0,
          detail: 'no runtime was running; the supervisor flushed the log sink and released the state-directory lock' }] }
    }
    this.drainer ??= this.makeDrainer()
    return await this.drainer.drain(runtime, reason, signal)
  }

  /** Stop the runtime and release every supervisor resource. Safe to call twice; failures are logged, not rethrown. */
  stop(): Promise<void> {
    return this.stopping ??= this.shutdown()
  }

  private async shutdown(): Promise<void> {
    this.releasing = true
    try {
      if (this.runtime !== undefined) {
        this.drainer ??= this.makeDrainer()
        await this.drainer.drain(this.runtime, 'shutdown')
      }
    } catch (error) {
      this.log.warn('dsh-superagent-further drain failed during shutdown: %s', String(error))
    } finally {
      await this.flushLogs()
      await this.releaseLock()
    }
  }

  private makeDrainer(): DrainController {
    return new DrainController({
      journal: this.journal as Journal,
      logger: this.log,
      flushLogs: () => this.flushLogs(),
      releaseStateLock: () => this.releaseGated(),
      current: () => this.record,
    })
  }

  private async boot(): Promise<void> {
    const stateDir = this.options.machine.stateDir
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      try {
        restrictToOwner(stateDir, true)
      } catch (error) {
        this.log.warn('dsh-superagent-further cannot restrict the state directory to its owner: %s', String(error))
      }
      const release = this.acquireLock(stateDir)
      this.release = release
      const runtimeDir = runtimeDirectory(stateDir)
      const journal = this.journal = new Journal(join(runtimeDir, 'journal.json'), this.now)
      const interrupted = journal.interrupted()
      if (interrupted !== undefined) {
        this.log.warn('dsh-superagent-further found an interrupted %s at %s; recovery will prefer the recorded runtime only if it verifies',
          interrupted.operation, interrupted.phase)
      }
      const database = databaseSchema(join(stateDir, 'orchestrator.sqlite'))
      let packaged: PackagedRuntime | undefined
      let packagedProblem: unknown
      try {
        packaged = (this.options.packaged ?? (() => packagedRuntime()))()
      } catch (error) {
        packagedProblem = error
        this.log.warn('dsh-superagent-further cannot discover its packaged runtime: %s; deployed versions may still start',
          message(error))
      }
      const resolution = resolveVersions(runtimeDir, packaged, database, interrupted?.current)
      for (const rejected of resolution.rejected) {
        this.log.warn('dsh-superagent-further will not start the %s runtime: %s', rejected.source, rejected.reason)
      }
      const previous = readDescriptorFile(previousPointer(runtimeDir)).descriptor
      let last: unknown
      for (const candidate of resolution.candidates) {
        try {
          await this.attempt(candidate, database, previous, interrupted)
          return
        } catch (error) {
          last = error
          this.log.warn('dsh-superagent-further could not start the %s runtime %s: %s; trying the next candidate',
            candidate.source, candidate.descriptor.version, message(error))
        }
      }
      const hint = packaged === undefined
        ? `; the packaged runtime is unavailable (${message(packagedProblem)}), so the package is probably not built: run pnpm build`
        : ''
      const reason = last === undefined ? 'no candidate runtime could be resolved' : message(last)
      throw new Error(`dsh-superagent-further could not start a runtime for ${stateDir}: ${reason}${hint}`, { cause: last ?? packagedProblem })
    } catch (error) {
      this.releasing = true
      await this.flushLogs()
      await this.releaseLock()
      throw error
    }
  }

  /** Load and initialize one verified candidate. A failure disposes what it created and leaves the lock for the next try. */
  private async attempt(candidate: RuntimeCandidate, database: number | undefined, previous: RuntimeDescriptor | undefined,
    interrupted: ReturnType<Journal['interrupted']>): Promise<void> {
    const built = buildRuntimeHost({
      context: this.options.context,
      machine: this.options.machine,
      restart: this.options.restart ?? (() => {}),
      exit: this.options.exit ?? (() => {}),
      version: candidate.descriptor.version,
      logger: this.log,
      lifetime: this.lockLost.signal,
      flushLogs: () => this.flushLogs(),
      releaseStateLock: () => this.releaseGated(),
      logs: this.logsRing,
      ...(this.options.logSink === undefined ? {} : { logSink: this.options.logSink }),
    })
    this.apply(built)
    const journal = this.journal as Journal
    journal.begin('startup', candidate.descriptor, previous)
    journal.mark('load', 'started', `loading the ${candidate.source} runtime ${candidate.descriptor.version}`)
    let loaded: LoadedRuntime
    try {
      loaded = await loadRuntime({ host: built.host, entry: candidate.entry, databaseSchema: database })
    } catch (error) {
      journal.fail('load', message(error))
      await this.closeBuilt()
      throw error
    }
    journal.mark('load', 'done')
    this.runtime = loaded.handle
    journal.mark('init', 'started')
    try {
      await bounded(loaded.handle.ready, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS,
        `the ${candidate.descriptor.version} runtime readiness`)
    } catch (error) {
      journal.fail('init', message(error))
      this.runtime = undefined
      try {
        await bounded(loaded.handle.dispose(), this.options.disposeMs ?? DISPOSE_MS,
          `the ${candidate.descriptor.version} runtime dispose`)
      } catch (disposeError) {
        this.log.warn('dsh-superagent-further could not dispose the failed %s runtime: %s; continuing with the next candidate',
          candidate.descriptor.version, message(disposeError))
      }
      await this.closeBuilt()
      throw error
    }
    journal.mark('init', 'done')
    this.record = { ...candidate.descriptor, schema: loaded.schema }
    const recovery: JournalRecovery | undefined = interrupted === undefined ? undefined : {
      at: this.now(),
      from: interrupted.current?.version ?? interrupted.previous?.version ?? 'unknown',
      to: candidate.descriptor.version,
      reason: `an interrupted ${interrupted.operation} stopped at ${interrupted.phase}; recovery started ${candidate.descriptor.version}`,
    }
    journal.commit({ current: this.record, ...(recovery === undefined ? {} : { recovery }) })
    this.statusValue = {
      version: candidate.descriptor.version, source: candidate.source, hostApi: HOST_API, schema: loaded.schema,
      ...(recovery === undefined ? {} : { recovery: recovery.reason }),
    }
    this.log.info('dsh-superagent-further runtime %s started from the %s runtime (host API %s, schema %s)',
      candidate.descriptor.version, candidate.source, HOST_API, loaded.schema)
  }

  private apply(built: BuiltHost): void {
    this.logSink = built.logSink
    this.flushTask = undefined
  }

  /** Close a failed candidate's sink so its last entries land before the next candidate reuses the same ring. */
  private async closeBuilt(): Promise<void> {
    await this.flushLogs()
  }

  private flushLogs(): Promise<void> {
    return this.flushTask ??= (async () => {
      const sink = this.logSink
      if (sink === undefined) return
      try {
        await bounded(sink.close(), this.options.flushLogsMs ?? FLUSH_LOGS_MS, 'the durable log sink close')
      } catch (error) {
        this.log.warn('dsh-superagent-further could not close the durable log: %s', String(error))
      }
    })()
  }

  private acquireLock(stateDir: string): () => Promise<void> {
    const compromised = (error: Error): void => {
      this.log.error('dsh-superagent-further lost the state-directory lock: %s', String(error))
      this.lockLost.abort()
    }
    try {
      const release = this.options.lock === undefined
        ? lockSync(stateDir, { stale: 30_000, onCompromised: compromised })
        : this.options.lock(stateDir)
      let done = false
      return async () => {
        if (done) return
        done = true
        await release()
      }
    } catch (error) {
      throw new Error(`dsh-superagent-further is already hosted for ${stateDir}. Stop the other host: scripts/dsh-superagent-further stop for the service, or disable the dsh-superagent-further plugin in the profile that runs it, then start this one.`, { cause: error })
    }
  }

  /** The runtime may release the lock only once the supervisor is actually stopping or draining. */
  private async releaseGated(): Promise<void> {
    if (!this.releasing) return
    await this.releaseLock()
  }

  private releaseLock(): Promise<void> {
    if (this.releaseTask !== undefined) return this.releaseTask
    const release = this.release
    this.release = undefined
    if (release === undefined) return Promise.resolve()
    this.releaseTask = bounded(Promise.resolve().then(release), this.options.lockReleaseMs ?? LOCK_RELEASE_MS,
      'the state-directory lock release').catch(error => {
      this.log.warn('dsh-superagent-further could not release the state-directory lock: %s', message(error))
    })
    return this.releaseTask
  }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
