/**
 * Builds the frozen `RuntimeHost` v1 from the live Cordis context.
 *
 * This is the only module that imports the `@deepseek-ai/*` value exports the runtime needs (`Service`, the message and
 * reasoning-effort brands, the message freezer, the scope parent lookup, and schemastery). The runtime source keeps type-only
 * imports, which the build erases, so the self-contained bundle has no DSH runtime imports.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { freezeMessage, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import schemastery from '@deepseek-ai/schemastery'
import type { Machine } from '../deployment.ts'
import { LogFileSink } from '../app/log-files.ts'
import { Logs, type HostLogger } from '../app/logs.ts'
import { HOST_API, type RuntimeHost, type RuntimeHostServices, type RuntimeHostValues } from '../runtime-host.ts'

/** Everything the supervisor supplies; the ring, the sink, and the forwarding hooks are built here. */
export interface HostBuildOptions {
  readonly context: Context
  readonly machine: Machine
  readonly restart: () => void
  readonly exit: (code: number) => void
  /** The version of the runtime bundle about to start, for logs and the version surface. */
  readonly version: string
  /** The Host logger beneath the ring. */
  readonly logger: HostLogger
  /** Aborted when the supervisor loses the state-directory lock. */
  readonly lifetime: AbortSignal
  /** Stops accepting and writes the last batch of the durable sink, bounded. */
  flushLogs: () => Promise<void>
  /** Releases the state-directory lock exactly once. */
  releaseStateLock: () => Promise<void>
  /** Retention used before the runtime supplies the setting it owns. */
  readonly defaultLogRetention?: number
  /** Clock used by the sink's day files. */
  readonly now?: () => Date
}

/** The built host and the supervisor-owned instances the supervisor keeps using. */
export interface BuiltHost {
  readonly host: RuntimeHost
  readonly logs: Logs
  readonly logSink: LogFileSink
}

/**
 * Create the ring and the durable sink, then the host that exposes them. The runtime attaches the sink once settings exist;
 * the supervisor never attaches it itself, so entries recorded before the runtime's settings load stay in the ring only,
 * exactly as they did when the runtime owned the sink.
 */
export function buildRuntimeHost(options: HostBuildOptions): BuiltHost {
  const logs = new Logs()
  let logState: ((state: 'ready' | 'error', detail: string) => void) | undefined
  let retention: (() => number) | undefined
  const logSink = new LogFileSink({
    stateDir: options.machine.stateDir,
    retentionDays: () => retention?.() ?? options.defaultLogRetention ?? 30,
    onState: (state, detail) => { logState?.(state, detail) },
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const services: RuntimeHostServices = {
    agents: options.context.get('agents') as RuntimeHostServices['agents'],
    sessionController: options.context.get('sessionController') as RuntimeHostServices['sessionController'],
    sessionPersistence: options.context.get('sessionPersistence') as RuntimeHostServices['sessionPersistence'],
    workspaceRegistry: options.context.get('workspaceRegistry') as RuntimeHostServices['workspaceRegistry'],
    permissionPresets: options.context.get('permissionPresets') as RuntimeHostServices['permissionPresets'],
    tools: options.context.get('tools') as RuntimeHostServices['tools'],
    systemPrompt: options.context.get('systemPrompt') as RuntimeHostServices['systemPrompt'],
    skills: options.context.get('skills') as RuntimeHostServices['skills'],
    webServer: options.context.get('webServer') as RuntimeHostServices['webServer'],
    llm: options.context.get('llm') as RuntimeHostServices['llm'],
    subprocess: options.context.get('subprocess') as RuntimeHostServices['subprocess'],
    settings: options.context.get('settings') as RuntimeHostServices['settings'],
  }
  const values: RuntimeHostValues = { Service, MessageId, ReasoningEffortId, freezeMessage, scopeParentOf, schemastery }
  const host: RuntimeHost = {
    hostApi: HOST_API,
    version: options.version,
    context: options.context,
    machine: options.machine,
    restart: options.restart,
    exit: options.exit,
    logger: options.logger,
    lifetime: options.lifetime,
    logs,
    logSink,
    services,
    values,
    stateDir: options.machine.stateDir,
    onLogState: listener => { logState = listener },
    setLogRetention: read => { retention = read },
    flushLogs: options.flushLogs,
    releaseStateLock: options.releaseStateLock,
  }
  return { host, logs, logSink }
}
