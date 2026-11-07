/**
 * Starting an executor as a subagent of a project's Lead Session, and keeping the
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
  /** Wakes a durable direct child (or cold-resumes it) instead of starting a second one with the same id. */
  sendMessage(sender: Agent, targetId: string, content: [{ readonly type: 'text'; readonly text: string }],
    options: { readonly signal: AbortSignal }): Promise<unknown>
  interrupt?(targetId: string, authority: { readonly kind: 'ancestor'; readonly agent: Agent }): void
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
  /** The request each activation was started with, so a later delivery can steer the same child from its Lead. */
  private readonly started = new Map<string, ActivationSpec>()

  constructor(private readonly service: () => SubagentService | undefined) {}

  /** Whether this host's runtime offers the subagent service at all. */
  get available(): boolean { return this.service() !== undefined }

  /** Starts one activation and keeps it until it settles or is disposed. */
  async start(spec: ActivationSpec): Promise<Activation> {
    const service = this.service()
    if (!service) throw new Error('This host has no subagent service, so a project Ticket cannot start its executor here')
    let activation: Activation
    try {
      activation = await service.startActivation(spec)
    } catch (error) {
      // A Ticket that runs again (a retry, or a launch after a restart) keeps its durable child Session; its id is the
      // reserved worker id, so starting a second child with it is refused. Wake the existing child with this message instead.
      if (!/already exists/.test(String(error))) throw error
      await service.sendMessage(spec.request.parent, spec.childId, spec.request.prompt, { signal: spec.signal })
      activation = { childId: spec.childId, result: new Promise(() => {}), dispose: async () => {
        service.interrupt?.(spec.childId, { kind: 'ancestor', agent: spec.request.parent })
      } }
    }
    this.running.set(activation.childId, activation)
    this.started.set(activation.childId, spec)
    // A settled activation needs no disposal; a failed one is disposed the same way, and its failure is the Lead's to see.
    void activation.result.catch(() => {}).then(() => {
      if (this.running.get(activation.childId) === activation) { this.running.delete(activation.childId); this.started.delete(activation.childId) }
    })
    return activation
  }

  /** Whether this host started (and still holds) the child with this id. */
  holds(childId: string): boolean { return this.started.has(childId) }

  /**
   * Steers one message into a child this host started. A subagent-owned Session refuses a root `prompt`, so input deliveries
   * go through the Lead that owns the child.
   * @returns whether the child was one this host started and the message was accepted.
   */
  async steer(childId: string, text: string, signal: AbortSignal): Promise<boolean> {
    const spec = this.started.get(childId)
    const service = this.service()
    if (!spec || !service) return false
    await service.sendMessage(spec.request.parent, childId, [{ type: 'text', text }], { signal })
    return true
  }

  /** Sends one message from a Lead to its child, for a delivery after a restart lost the activation map. */
  async send(lead: Agent, childId: string, text: string, signal: AbortSignal): Promise<void> {
    const service = this.service()
    if (!service) throw new Error('This host has no subagent service, so a Lead cannot reach its executor here')
    await service.sendMessage(lead, childId, [{ type: 'text', text }], { signal })
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
