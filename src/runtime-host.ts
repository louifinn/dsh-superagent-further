/**
 * The frozen boundary between the stable supervisor and a versioned domain runtime: API v1.
 *
 * A runtime built by `src/runtime-entry.ts` receives one `RuntimeHost` and nothing else from the process: the live DSH context
 * (the frozen service channel), the DSH value exports it would otherwise import, the machine configuration, the
 * state-directory lock, the log ring and its durable sink, the process lifetime, and the drain/release hooks it must call in
 * order. The supervisor is the only writer of this object; a runtime must treat it as read-only apart from the explicit setters.
 *
 * The API is versioned as a whole (`HOST_API`). A runtime bundle declares the API it was built against in its packaged
 * manifest, and the supervisor refuses to load a bundle whose declaration does not match this constant. Adding, removing,
 * or changing the meaning of any member requires a new `HOST_API`; the package ships the supervisor and the packaged runtime
 * together, so the constant and the bundled runtime are always built from the same source revision.
 */
import type { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Machine } from './deployment.ts'
import type { LogFileSink } from './app/log-files.ts'
import type { HostLogger, Logs } from './app/logs.ts'
import type { SetupProblem } from './setup.ts'

/** The version of the `RuntimeHost` contract this package builds and accepts. Bump together with any contract change. */
export const HOST_API = 1

/** The file name of the packaged runtime entry inside `lib/`, and of its descriptor. */
export const PACKAGED_RUNTIME_ENTRY = 'runtime-entry.js'
export const PACKAGED_RUNTIME_MANIFEST = 'runtime-manifest.json'

/**
 * The DSH value exports the runtime used to import directly. Injecting them keeps the built runtime free of
 * `@deepseek-ai/*` runtime imports, so the supervisor can load a self-contained bundle from the state directory.
 */
export interface RuntimeHostValues {
  /** The Cordis service base class, used by the runtime's own service classes. */
  readonly Service: typeof Service
  /** `dsh-llm`'s message-id brand, used to build the IDs of messages the runtime delivers. */
  readonly MessageId: typeof import('@deepseek-ai/dsh-llm').MessageId
  /** `dsh-llm`'s reasoning-effort brand, used to resolve the model selection of a role. */
  readonly ReasoningEffortId: typeof import('@deepseek-ai/dsh-llm').ReasoningEffortId
  /** `dsh-llm`'s message freezer, used before a message is appended to a DSH Session. */
  readonly freezeMessage: typeof import('@deepseek-ai/dsh-llm').freezeMessage
  /** `dsh-scope`'s parent lookup, used to build the scope of a worker Session. */
  readonly scopeParentOf: typeof import('@deepseek-ai/dsh-scope').scopeParentOf
  /** The schema library used by the deployment configuration, kept available for a runtime that validates its own settings. */
  readonly schemastery: typeof import('@deepseek-ai/schemastery').default
}

/**
 * Everything the supervisor hands a versioned runtime.
 *
 * The runtime may call `setLogRetention` once it can read the operator's setting, and `onLogState` to report sink health.
 * It must call `flushLogs` and `releaseStateLock` in the drain order below, and must never close the state directory itself.
 */
export interface RuntimeHost {
  /** The contract version; equals `HOST_API`. */
  readonly hostApi: typeof HOST_API
  /** The version of the runtime bundle that is running, for logs and the update surface. */
  readonly version: string
  /** The live Cordis context: the frozen DSH service channel, plus effects, injection, optional services (`schedule`, `subagents`), and the service registration. */
  readonly context: Context
  /** The validated deployment configuration. */
  readonly machine: Machine
  /** Restarts the plugin after a deployment-account change, keeping volatile limits. */
  readonly restart: () => void
  /** Ends the host process after a requested shutdown (injected so tests can observe it). */
  readonly exit: (code: number) => void
  /** The Host logger beneath the ring. */
  readonly logger: HostLogger
  /** Aborted when the supervisor loses its state-directory lock, cancelling running reads and subprocesses. */
  readonly lifetime: AbortSignal
  /** The process-wide bounded log ring, owned and retained by the supervisor across runtime versions. */
  readonly logs: Logs
  /** The durable JSONL sink owned by the supervisor; the runtime attaches it once settings exist and flushes it while draining. */
  readonly logSink: LogFileSink
  /** The injected DSH value exports. */
  readonly values: RuntimeHostValues
  /** The state directory the supervisor locked; the runtime may open only its database beneath it. */
  readonly stateDir: string
  /** Reports the durable sink's state once the runtime has claimed its `logs` health entry. */
  onLogState(listener: (state: 'ready' | 'error', detail: string) => void): void
  /** Sets the retention reader the sink consults while pruning; the runtime supplies the setting it owns. */
  setLogRetention(read: () => number): void
  /** Stops accepting entries and writes the last batch, bounded; idempotent. */
  flushLogs(): Promise<void>
  /** Releases the state-directory lock exactly once; later calls resolve immediately. */
  releaseStateLock(): Promise<void>
}

/** One phase of a drain, in the order the runtime ran it. */
export type DrainPhase = 'intake' | 'cancel' | 'in-flight' | 'dispose' | 'logs' | 'store' | 'lock'
/** The outcome of one drain phase. */
export interface DrainPhaseReport {
  readonly phase: DrainPhase
  readonly status: 'done' | 'skipped' | 'failed'
  /** ISO timestamp when the phase started. */
  readonly startedAt: string
  readonly durationMs: number
  /** Why a phase was skipped or failed. */
  readonly detail?: string
}

/**
 * The ordered report of one drain. `completed` is false when any phase failed or was skipped; a failed phase never stops the
 * later phases, because closing the store and releasing the lock matter more than a clean report.
 */
export interface DrainReport {
  readonly reason: string
  readonly startedAt: string
  readonly durationMs: number
  readonly completed: boolean
  readonly phases: readonly DrainPhaseReport[]
}

/**
 * The object a versioned runtime returns from `createRuntime`. The supervisor uses only this shape, so a future runtime may
 * implement its own version of it. `drain` is idempotent: a second call returns the first report and does nothing.
 */
export interface RuntimeHandle {
  readonly ready: Promise<void>
  readonly drain: (reason: string, signal?: AbortSignal) => Promise<DrainReport>
  readonly dispose: () => Promise<void>
  /** Whether Setup completed; absent in a minimal runtime, in which case the supervisor reports not configured. */
  readonly configured?: () => boolean
  /** Why Setup is incomplete, for the plugin's startup log; absent in a minimal runtime. */
  readonly setupProblem?: SetupProblem
}

/** The module shape `createRuntime` is exported from; validated by the loader before anything is created. */
export interface RuntimeModule {
  readonly HOST_API?: unknown
  readonly SCHEMA_VERSION?: unknown
  readonly createRuntime?: unknown
}

/** A versioned runtime's descriptor, as written to `current.json` and the packaged manifest. */
export interface RuntimeDescriptor {
  /** Version of the runtime bundle, normally the package version. */
  readonly version: string
  /** Entry file, relative to the bundle's own version directory `<stateDir>/runtime/<version>/` for a deployed bundle. */
  readonly entry: string
  /** The `RuntimeHost` API the bundle was built against. */
  readonly hostApi: number
  /** SHA-256 of the entry file, hex. */
  readonly sha256: string
  /** The database schema the bundle supports; a runtime may never open a newer database. */
  readonly schema?: number
}
