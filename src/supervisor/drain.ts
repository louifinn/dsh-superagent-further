/**
 * The supervisor side of the drain contract.
 *
 * The runtime owns the ordered phases (intake, cancel, in-flight, dispose, logs, store, lock); the supervisor records the
 * drain in the journal, then makes the last two supervisor-owned resources idempotent even if an older or failing bundle
 * skipped them. A second call returns the first report and does nothing, which is the contract normal shutdown and the
 * update path both rely on.
 */
import type { DrainReport, RuntimeDescriptor, RuntimeHandle } from '../runtime-host.ts'
import type { HostLogger } from '../app/logs.ts'
import type { Journal } from './journal.ts'

/** What the controller needs from the supervisor; all resources stay supervisor-owned. */
export interface DrainControllerOptions {
  readonly journal: Journal
  readonly logger: HostLogger
  /** Close the durable log sink and write its last batch, bounded. */
  flushLogs: () => Promise<void>
  /** Release the state-directory lock; the supervisor gates this so a failed start can try the next version. */
  releaseStateLock: () => Promise<void>
  /** The version the supervisor is draining, recorded for crash recovery. */
  current: () => RuntimeDescriptor | undefined
}

/**
 * Drives one drain for the supervisor. The first call begins a `drain` journal operation and awaits the runtime's report;
 * later calls share that same promise. The controller always flushes the sink and releases the lock afterwards, because a
 * runtime whose dispose threw may not have reached those phases.
 */
export class DrainController {
  private report?: Promise<DrainReport>
  constructor(private readonly options: DrainControllerOptions) {}

  /** True once a drain has been requested. */
  get draining(): boolean { return this.report !== undefined }

  /** Run the drain contract once; repeated or concurrent calls return the first report. */
  drain(handle: RuntimeHandle, reason: string, signal?: AbortSignal): Promise<DrainReport> {
    return this.report ??= this.run(handle, reason, signal)
  }

  private async run(handle: RuntimeHandle, reason: string, signal?: AbortSignal): Promise<DrainReport> {
    this.options.journal.begin('drain', this.options.current() ?? null)
    this.options.journal.mark('drain', 'done', `drain requested: ${reason}`)
    let report: DrainReport
    try {
      report = await handle.drain(reason, signal)
    } catch (error) {
      await this.finish()
      this.options.journal.fail('drain', `the runtime drain threw: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    await this.finish()
    if (report.completed) this.options.journal.commit({})
    else this.options.journal.fail('drain', 'the runtime drain did not complete every phase')
    return report
  }

  /** The supervisor-owned tail of the drain; each resource is idempotent, so a runtime that already closed them is unharmed. */
  private async finish(): Promise<void> {
    try {
      await this.options.flushLogs()
    } catch (error) {
      this.options.logger.warn('dsh-superagent-further could not flush the durable log during drain: %s', String(error))
    }
    try {
      await this.options.releaseStateLock()
    } catch (error) {
      this.options.logger.warn('dsh-superagent-further could not release the state-directory lock during drain: %s', String(error))
    }
  }
}
