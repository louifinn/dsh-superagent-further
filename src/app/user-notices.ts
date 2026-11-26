/**
 * Durable user-notice requests and their per-level approval (docs/016 notification section, issue #29, ADR-0009 decision 7).
 *
 * A worker asks its project Lead; a Lead asks the Orchestrator. The direct superior answers once, with a reason on refusal.
 * An approved notice goes out through the same Outbox as every other message, to the origin Ticket's human channel, falling
 * back to the configured alert chat, and finally to `attention` when neither exists or delivery fails, so a notice never
 * disappears silently.
 */
import { key, UserError, userNoticeApprover, type ChannelRef, type OutboundMessage, type UserNoticeInput, type UserNoticeRecord, type UserNoticeRole } from '../core/index.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

/** The delivery and Session services a user-notice request needs; the Runtime binds them after composing Sessions and Outbox. */
export interface UserNoticeHost {
  readonly masterId: string
  prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer'): Promise<void>
  ensureLead(projectId: string): Promise<{ id: string }>
  send(message: OutboundMessage): void
  /** The operator's configured alert chat, the fallback when the origin Ticket has no human channel (ADR-0010). */
  fallbackChatId(): string | undefined
  alerts: { send(dedupeKey: string, text: string): Promise<boolean> }
  /** Wakes the main Session with a durable prompt, used when a notice can only be delivered as attention. */
  wake(requestId: string, text: string): void
  log?: { warn(format: string, ...args: unknown[]): void }
}

/** The channels a request may go out on, from its origin Ticket: the person's message channel first. */
const channelOf = (store: Pick<Store, 'tickets' | 'triggers'>, ticketId: string | undefined): ChannelRef | undefined => {
  const ticket = ticketId === undefined ? undefined : store.tickets.get(ticketId)
  const trigger = ticket?.origin.triggerId === undefined ? undefined : store.triggers.get(ticket.origin.triggerId)
  return trigger?.channel ?? ticket?.channels[0]
}

/**
 * The user-notice service: persistent requests, one approval per level, and delivery through the outbox with a visible
 * attention fallback. A duplicate raise returns the existing request; a decided request cannot be answered again.
 */
export class UserNotices {
  constructor(private readonly store: Pick<Store, 'userNotices' | 'information' | 'tickets' | 'triggers'>, private readonly effects: Pick<Effects, 'enqueue' | 'handle'>,
    private readonly host: UserNoticeHost, private readonly now: () => string = () => new Date().toISOString()) {
    this.effects.handle('user-notice', ({ id }: { id: string }) => this.deliver(id), { retry: [5000, 300_000] })
  }
  /** Raise a request once; the direct superior is prompted to answer it. */
  async raise(input: { session: string; role: UserNoticeRole; text: string; ticketId?: string; project?: string }): Promise<UserNoticeRecord> {
    const text = input.text.trim()
    const approver = userNoticeApprover(input.role)
    const record = this.store.userNotices.add({ text, session: input.session, role: input.role, approver, at: this.now(),
      ...(input.project === undefined ? {} : { project: input.project }), ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      ...(approver === 'lead' && input.project !== undefined ? { approverProject: input.project } : {}) })
    if (record.status === 'pending') {
      // The request is itself an information hop upward: the raiser's words reach the approver once.
      const root = key('user-notice-record', record.id)
      this.store.information.send({ id: root, kind: 'notice', direction: 'up',
        source: { role: record.role, ...(record.project === undefined ? {} : { project: record.project }) },
        target: { role: approver, ...(record.approverProject === undefined ? {} : { project: record.approverProject }) },
        audience: [approver], hops: 0, oneShot: false, dedupe: root,
        payload: { text, notice: record.id, ...(record.ticketId === undefined ? {} : { ticketId: record.ticketId }) }, root, createdAt: record.createdAt })
      await this.ask(record)
    }
    return record
  }
  /** Prompt the direct superior with the request and the tool that answers it. */
  private async ask(record: UserNoticeRecord): Promise<void> {
    const tool = record.approver === 'lead' ? 'lead_notice_decide' : 'orchestrator_notice_decide'
    const text = `A ${record.role}${record.ticketId === undefined ? '' : ` (Ticket ${record.ticketId})`} asks to notify the person:\n\n`
      + `“${record.text}”\n\nAnswer once with ${tool}(notice_id: "${record.id}", approve: true or false, reason: "…"). `
      + 'Approval sends these exact words on the person\'s channel; a refusal needs the reason the person is not being notified, which goes back to the raiser.'
    const requestId = key('user-notice-request', record.id)
    if (record.approver === 'orchestrator') await this.host.prompt(this.host.masterId, requestId, text, 'queue')
    else {
      if (record.approverProject === undefined) throw new Error(`User-notice request ${record.id} names no project for its Lead`)
      const lead = await this.host.ensureLead(record.approverProject)
      await this.host.prompt(lead.id, requestId, text, 'queue')
    }
  }
  /** Answer one pending request: approve (and enqueue delivery) or refuse with the concrete reason. */
  async decide(id: string, decision: { approve: boolean; reason?: string; by: string; role: 'lead' | 'orchestrator'; project?: string }): Promise<UserNoticeRecord> {
    const record = this.store.userNotices.get(id)
    if (!record) throw new UserError('unknownUserNotice', { notice: id })
    if (record.approver !== decision.role) throw new UserError('userNoticeApprover', { notice: id, approver: record.approver })
    if (decision.role === 'lead' && record.approverProject !== undefined && decision.project !== record.approverProject) {
      throw new UserError('userNoticeApprover', { notice: id, approver: `lead of ${record.approverProject}` })
    }
    if (record.status !== 'pending') throw new UserError('userNoticeDecided', { notice: id, status: record.status })
    const reason = decision.reason?.trim()
    if (!decision.approve && !reason) throw new UserError('userNoticeReason')
    const updated: UserNoticeRecord = { ...record, status: decision.approve ? 'approved' : 'refused', decidedAt: this.now(), decidedBy: decision.by,
      ...(reason === undefined ? {} : { reason }) }
    this.store.userNotices.save(updated)
    const raise = this.store.information.byDedupe(key('user-notice-record', record.id))
    if (raise) {
      this.store.information.send({ kind: 'notice', direction: 'down', source: { role: record.approver,
        ...(record.approverProject === undefined ? {} : { project: record.approverProject }) },
        target: { role: record.role, ...(record.project === undefined ? {} : { project: record.project }) }, audience: [record.role],
        hops: raise.hops + 1, oneShot: false, dedupe: key('user-notice-decision', record.id),
        payload: { notice: record.id, approved: decision.approve, ...(reason === undefined ? {} : { reason }) }, root: raise.root, parent: raise.id,
        createdAt: updated.decidedAt! })
    }
    if (decision.approve) this.effects.enqueue('user-notice', record.id, { id: record.id })
    else await this.refusal(updated)
    return updated
  }
  /** Tell the raiser why the person is not being notified; the reason is never dropped. */
  private async refusal(record: UserNoticeRecord): Promise<void> {
    const text = `Your request to notify the person was refused by the ${record.approver}: ${record.reason ?? '(no reason recorded)'}. `
      + 'Do not send it yourself; keep the fact in your next report or adjust the request and raise it again.'
    const requestId = key('user-notice-refusal', record.id)
    try {
      if (record.role === 'worker' || record.role === 'lead') await this.host.prompt(record.session, requestId, text, 'queue')
    } catch (error) { this.host.log?.warn('could not tell the raiser of user-notice %s: %s', record.id, String(error)) }
  }
  /**
   * Deliver an approved request through the Outbox, or as attention when no channel and no alert chat exist or the send
   * fails. The effect does not retry forever: the outcome is recorded on the request and surfaced to the main Session.
   */
  async deliver(id: string): Promise<void> {
    const record = this.store.userNotices.get(id)
    if (!record || (record.status !== 'approved' && record.status !== 'attention')) return
    const channel = channelOf(this.store, record.ticketId)
    if (channel) {
      try {
        this.host.send({ id: key('user-notice-message', record.id), channel, text: record.text, kind: 'notice',
          ...(record.ticketId === undefined ? {} : { ticketId: record.ticketId }) })
        this.store.userNotices.save({ ...record, status: 'sent', via: 'channel', deliveredAt: this.now() })
        return
      } catch (error) { await this.fail(record, `The channel send failed: ${String(error)}`) ; return }
    }
    const chat = this.host.fallbackChatId()
    if (chat) {
      try {
        await this.host.alerts.send(`user-notice:${record.id}`, record.text)
        this.store.userNotices.save({ ...record, status: 'sent', via: 'alert', deliveredAt: this.now() })
        return
      } catch (error) { await this.fail(record, `The alert-chat send failed: ${String(error)}`); return }
    }
    await this.fail(record, 'The origin Ticket has no human channel and no alert chat is configured')
  }
  /** Keep an undeliverable notice visible: `attention` on the request plus a durable wake to the main Session. */
  private async fail(record: UserNoticeRecord, error: string): Promise<void> {
    this.store.userNotices.save({ ...record, status: 'attention', error })
    this.host.wake(key('user-notice-attention', record.id), `A user notice could not be delivered (${error}). The raiser was ${record.role}`
      + `${record.project === undefined ? '' : ` of project ${record.project}`}; the words were:\n\n“${record.text}”\n\nDeliver them to the person by another route, or fix the channel configuration.`)
  }
  /** Pending requests an approver must answer, for the Lead list tool and the Orchestrator. */
  pendingFor(approver: 'lead' | 'orchestrator', project?: string): UserNoticeRecord[] {
    return this.store.userNotices.pendingFor(approver, project)
  }
  get(id: string): UserNoticeRecord | undefined { return this.store.userNotices.get(id) }
}
