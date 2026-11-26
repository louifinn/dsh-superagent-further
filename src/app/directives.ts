/**
 * Records and propagates a person's direct word (docs/016-information-discipline.md P8, issues #20–#22, ADR-0009 decisions
 * 3–5). The word is one Directive: recorded once, acted on inside the addressed layer's Mandate, and carried upward through
 * the adjacent hops as `information` records so the Lead and the Orchestrator know by their next turn. Nothing here is a
 * second message bus: the hops are the existing information records, and prompts go through the existing Sessions delivery.
 */
import type { Context } from '@deepseek-ai/cordis'
import { key, UserError, directiveChain, type DirectiveEffect, type DirectiveParty, type DirectiveRecord } from '../core/index.ts'
import type { BoundaryAudit } from './boundary.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

/** The Sessions and audit services a Directive needs, without importing the Sessions class (it attaches this service). */
export interface DirectiveHost {
  readonly masterId: string
  /** Who `sessionId` speaks for; undefined for a Session this installation does not manage. */
  roleOf(sessionId: string): DirectiveParty | undefined
  prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer'): Promise<void>
  ensureLead(projectId: string): Promise<{ id: string }>
  readonly boundary: BoundaryAudit
  /** True once the Runtime is draining: the Store closes under it, so the listeners stop reading. */
  closing(): boolean
  log?: { warn(format: string, ...args: unknown[]): void }
}

/** The upward prompt a Directive sends its parent; it names the original words and the one-shot limits. */
export function directivePrompt(record: DirectiveRecord, target: 'lead' | 'orchestrator'): string {
  const addressed = record.source.role === 'worker'
    ? `the worker of Ticket ${record.source.ticketId ?? '(unknown)'} in project ${record.source.project ?? '(unknown)'}`
    : record.source.role === 'lead' ? `the Lead of project ${record.source.project ?? '(unknown)'}` : 'the Orchestrator'
  const limits = target === 'orchestrator'
    ? 'You may adjust other projects and your own work once, with the reason, but not the source project, and you may not forward this word as a new request.'
    : 'You may adjust other workers and your own work once, with the reason, but not the addressed node: notifying it against this word is refused while the Directive is unconsumed.'
  return `A person addressed ${addressed} directly. Their original words:\n\n“${record.text}”\n\nThis is a one-shot Directive (issue #20): it is authoritative within the addressed layer's Mandate, it is already being acted on there, and it must reach you by your next turn. ${limits} Record the effect in your next report; do not send a separate acknowledgement, and do not ask the addressed node to confirm. If it cannot be carried out within the Mandate, report the concrete reason upward.`
}

/**
 * The Directive service. `record` is called from the Session event stream for a person's message to a managed Session;
 * the `directive` effect then records the upward information hops and prompts the parents once.
 */
export class Directives {
  constructor(private readonly store: Pick<Store, 'directives' | 'information'>, private readonly effects: Pick<Effects, 'enqueue' | 'handle'>,
    private readonly host: DirectiveHost, private readonly now: () => string = () => new Date().toISOString()) {
    this.effects.handle('directive', ({ id }: { id: string }) => this.propagate(id), { ordered: true, retry: [5000, 300_000] })
  }
  /** Subscribe to a person's messages and to the addressed layer's turn end. */
  install(ctx: Context): void {
    ctx.on('session/event', (session, event) => {
      if (this.host.closing()) return
      if (event.type !== 'user/message') return
      const data = event.data as { id?: string; text?: string; content?: readonly { type: string; text?: string }[]; source?: { kind?: string } } | undefined
      if (!data || data.source?.kind !== 'user') return
      const party = this.host.roleOf(session.id)
      if (!party) return
      const text = data.text ?? (data.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (!text.trim()) return
      const origin = data.id ?? key('person-message', session.id, text)
      const record = this.record(party, text, origin)
      // A redelivery is the same Directive: it never starts a second adjustment (issue #21).
      if (record.propagatedAt === undefined && this.store.directives.pending().some(item => item.id === record.id)) {
        this.effects.enqueue('directive', record.id, { id: record.id })
      }
    })
    // A Lead or the Orchestrator acts on a Directive within its own turn: its next turn end consumes it. A worker consumes
    // its Directive through its report, which carries the effect upward (issue #22).
    ctx.on('agent/status', ({ agent, status }) => {
      if (this.host.closing()) return
      if (status !== 'idle') return
      const record = this.store.directives.pendingForSource(agent.id)[0]
      if (!record || record.source.role === 'worker') return
      this.store.directives.markConsumed(record.id, this.now())
    })
  }
  /** Record one person's message as a Directive without propagating it; a redelivery returns the same record. */
  record(party: DirectiveParty, text: string, origin: string): DirectiveRecord {
    const record = this.store.directives.send({ text, origin, source: party, at: this.now() })
    // The origin information record is written with the Directive so the chain's root exists before any hop.
    this.store.information.send({ id: key('directive-record', record.id), kind: 'instruction', direction: 'in', source: { role: 'person' },
      target: { role: party.role, ...(party.project === undefined ? {} : { project: party.project }) }, audience: [party.role],
      hops: 0, oneShot: true, dedupe: key('directive-record', record.id), payload: { text, origin, session: party.sessionId,
        ...(party.project === undefined ? {} : { project: party.project }), ...(party.ticketId === undefined ? {} : { ticketId: party.ticketId }) },
      root: key('directive-record', record.id), createdAt: record.at })
    return record
  }
  /**
   * Carry one Directive upward once: worker → Lead → Orchestrator, or Lead → Orchestrator, recording each hop as an
   * information record whose parent is the previous hop. Re-running it after a restart is a no-op.
   */
  async propagate(id: string): Promise<void> {
    const record = this.store.directives.get(id)
    if (!record || record.propagatedAt) return
    const root = this.store.information.byDedupe(key('directive-record', record.id))
    if (!root) throw new Error(`The Directive ${record.id} has no origin information record`)
    let parent = root
    let previous: { role: 'worker' | 'lead' | 'orchestrator'; project?: string } = {
      role: record.source.role === 'worker' ? 'worker' : record.source.role === 'lead' ? 'lead' : 'orchestrator',
      ...(record.source.project === undefined ? {} : { project: record.source.project }) }
    const chain = directiveChain(record.source.role).slice(1)
    for (const target of chain) {
      const targetRole = target as 'lead' | 'orchestrator'
      const project = targetRole === 'lead' ? record.source.project : undefined
      const session = targetRole === 'lead'
        ? (project === undefined ? undefined : (await this.host.ensureLead(project)).id)
        : this.host.masterId
      if (!session) throw new Error(`The Directive ${record.id} cannot reach a ${targetRole}: the source names no project`)
      const dedupe = key('directive-hop', record.id, targetRole)
      const hop = this.store.information.send({ kind: 'instruction', direction: 'up', source: { role: previous.role,
        ...(previous.project === undefined ? {} : { project: previous.project }) },
        target: { role: targetRole, ...(project === undefined ? {} : { project }) }, audience: [targetRole], hops: parent.hops + 1,
        oneShot: true, dedupe, payload: { text: record.text, origin: record.origin, directive: record.id, session: record.source.sessionId,
          ...(record.source.project === undefined ? {} : { project: record.source.project }), ...(record.source.ticketId === undefined ? {} : { ticketId: record.source.ticketId }) },
        root: parent.root, parent: parent.id, createdAt: this.now() })
      await this.host.prompt(session, dedupe, directivePrompt(record, targetRole), 'queue')
      this.store.information.markDelivered(hop.id, this.now())
      parent = hop
      // Every hop is an adjacent-level exchange: the Lead carries the worker's words to the Orchestrator, never the worker directly.
      previous = { role: targetRole, ...(project === undefined ? {} : { project }) }
    }
    this.store.directives.markPropagated(record.id, this.now())
  }
  /** The unconsumed Directive addressed to `ticketId`, if any. */
  pendingForTicket(ticketId: string): DirectiveRecord | undefined { return this.store.directives.pendingForTicket(ticketId) }
  /** The unconsumed Directive whose source node is in `project`, so a higher layer cannot steer that project against it. */
  pendingForProject(project: string): DirectiveRecord | undefined {
    return this.store.directives.pending().find(record => record.consumedAt === undefined && record.source.project === project)
  }
  /** Every unconsumed Directive, for the `directives` read resource and the Orchestrator's list tool. */
  pending(): DirectiveRecord[] { return this.store.directives.pending() }
  /**
   * A worker's report of what it did with the person's Directive: records the original words and the effect as the
   * worker → Lead report hop, then consumes the Directive. A handback also prompts the Lead with the concrete reason.
   */
  report(ticketId: string, effect: DirectiveEffect): DirectiveRecord | undefined {
    const record = this.store.directives.pendingForTicket(ticketId)
    if (!record) return undefined
    const root = this.store.information.byDedupe(key('directive-record', record.id))
    if (root) {
      this.store.information.send({ kind: 'report', direction: 'up', source: { role: 'worker', ...(record.source.project === undefined ? {} : { project: record.source.project }) },
        target: { role: 'lead', ...(record.source.project === undefined ? {} : { project: record.source.project }) }, audience: ['lead'],
        hops: root.hops + 1, oneShot: false, dedupe: key('directive-report', record.id), payload: { text: record.text, effect, ticketId },
        root: root.root, parent: root.id, createdAt: this.now() })
    }
    this.store.directives.markConsumed(record.id, this.now(), effect)
    if (effect === 'handback' && record.source.project !== undefined) {
      void this.host.ensureLead(record.source.project).then(lead => this.host.prompt(lead.id, key('directive-handback', record.id),
        `The worker of Ticket ${ticketId} hands back the person's Directive as beyond its Mandate. The original words:\n\n“${record.text}”\n\nThe worker's concrete reason must be in its report. Decide whether to adjust the work or report upward; do not ask the person to repeat it.`, 'queue'))
        .catch(error => this.host.log?.warn('could not prompt the Lead about Directive %s: %s', record.id, String(error)))
    }
    return record
  }
  /**
   * Refuse a tool that would steer the source node against its unconsumed Directive, and write the refusal to the boundary
   * audit before throwing, as issue #37 does for other refused operations.
   */
  refuse(role: 'lead' | 'orchestrator', action: string, resource: string, project: string | undefined, target: string): never {
    this.host.boundary.record({ at: this.now(), role, action, resource, project: project ?? null, outcome: 'refused',
      detail: `A person's Directive addressed ${target} is still unconsumed; steering it is refused` })
    throw new UserError('directiveSourceLocked', { target })
  }
}
