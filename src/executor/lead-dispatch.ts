/**
 * Starting an executor as a subagent of a project's Lead Session (`executor.orchestration = 'lead'`), and keeping the
 * activations so a stop or a shutdown can dispose them.
 *
 * A Lead's worker keeps the reserved Session id `worker-<ticketId>`, so the rest of the Executor (its prompt, its tools, the
 * panel's links and the report tool) finds it by the same id as a root worker. The Subagent service is DSH's own; this module
 * only describes the request and tracks the activations, so a caller can test both without a real host.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

/** DSH's subagent service, the part a Lead uses to start an executor. */
export interface SubagentService {
  startActivation(spec: ActivationSpec): Promise<Activation>
}

/** One managed activation, DSH's `SubagentActivation` as the Executor sees it. */
export interface Activation {
  readonly childId: string
  readonly result: Promise<unknown>
  dispose(): Promise<void>
}

/** The request a Lead makes for one executor. */
export interface ActivationSpec {
  /** The registered provider; the bundle mounts the spawn provider. */
  readonly provider: string
  /** The short label a catalog keeps for the child. */
  readonly label: string
  /** The reserved child Session id, always the worker id of the Ticket. */
  readonly childId: string
  readonly request: {
    readonly cwd: string
    /** The preset the child composes; an executor always runs the worker preset. */
    readonly agentPreset: string
    readonly prompt: [{ readonly type: 'text'; readonly text: string }]
    readonly parent: Agent
    /** Executors never delegate further. */
    readonly maxDepth: number
  }
  readonly signal: AbortSignal
  /** The parent is told when the child settles; the Lead's model then continues its turn. */
  readonly delivery: 'parent' | 'caller'
}

/** The provider name the bundle's subagent plugin registers. */
export const LEAD_PROVIDER = 'spawn'

/** The prompt an executor starts with, as one text block. */
export function executorActivation(input: { childId: string; title: string; cwd: string; text: string; lead: Agent; signal: AbortSignal,
  preset: string }): ActivationSpec {
  return {
    provider: LEAD_PROVIDER,
    label: input.title,
    childId: input.childId,
    request: { cwd: input.cwd, agentPreset: input.preset, prompt: [{ type: 'text', text: input.text }], parent: input.lead,
      maxDepth: 1 },
    signal: input.signal,
    delivery: 'parent',
  }
}

/** The activations a host started, by child Session id, so a stop and a shutdown dispose exactly those. */
export class LeadActivations {
  private readonly running = new Map<string, Activation>()

  constructor(private readonly service: () => SubagentService | undefined) {}

  /** Whether this host's runtime offers the subagent service at all. */
  get available(): boolean { return this.service() !== undefined }

  /** Starts one activation and keeps it until it settles or is disposed. */
  async start(spec: ActivationSpec): Promise<Activation> {
    const service = this.service()
    if (!service) throw new Error('This host has no subagent service, so a Lead cannot start an executor; use executor.orchestration root')
    const activation = await service.startActivation(spec)
    this.running.set(activation.childId, activation)
    // A settled activation needs no disposal; a failed one is disposed the same way, and its failure is the Lead's to see.
    void activation.result.catch(() => {}).then(() => { if (this.running.get(activation.childId) === activation) this.running.delete(activation.childId) })
    return activation
  }

  /** Removes an activation from the map and returns it, for its owner to dispose. */
  take(childId: string): Activation | undefined {
    const activation = this.running.get(childId)
    this.running.delete(childId)
    return activation
  }

  /** Number of activations this host still holds. */
  get size(): number { return this.running.size }

  /** Disposes one activation by child id, if it is still held. */
  async dispose(childId: string): Promise<void> {
    await this.take(childId)?.dispose().catch(() => {})
  }

  /** Disposes every activation; used when the host stops. */
  async disposeAll(): Promise<void> {
    const activations = [...this.running.values()]
    this.running.clear()
    await Promise.allSettled(activations.map(activation => activation.dispose()))
  }
}
