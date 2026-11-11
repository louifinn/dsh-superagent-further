/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, ticketOutcome } from './model.ts'
import { reasonText } from './reasons.ts'
import type { ChannelRef, Decision, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it — or, for the question an answer Ticket started from, once its ready or
 * completed report answered it — the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). An answer needs the worker's registered answer, except the question an
 * answer Ticket started from, which its own ready or completed report answers. The Engine routes `reply` here; Tickets asks
 * it for the acknowledgement an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  /**
   * Answer a whitelisted person's explicit mention or direct message even when the Decision did not accept it (docs/012 D8):
   * one short notice on that Trigger's Channel saying what happened and why, under a deterministic id. Whether the Trigger
   * expects a reply is derived from the same Policy gate that admitted it — a whitelisted sender's addressed message — so no
   * stored flag can drift from the Policy. Accepted requests keep the acknowledgement and result replies; a Trigger that is
   * not a person's, is not addressed, has no Channel, or that the Policy no longer admits gets nothing.
   */
  answerExplicit(decision: Decision): void {
    if (decision.kind === 'accept') return
    for (const triggerId of new Set(decision.triggerIds)) {
      const trigger = this.repo.triggers.get(triggerId)
      if (!trigger?.human || !trigger.addressed || !trigger.channel) continue
      // A message the main Session already answered has its answer; the notice would repeat it.
      if (this.repo.triggers.disposition(triggerId)?.answered) continue
      const thread = this.thread(trigger.threads[0]!)
      const gate = this.policy().gate(trigger, thread, this.ticketsOnThread(thread))
      if (!gate.admissible || gate.basis.via !== 'addressed') continue
      const id = key('explicit-reply', decision.id, trigger.id)
      // A Decision is recorded once, but an outbox that already holds the notice keeps it (idempotent).
      if (this.options.outbox.status(id) !== undefined) continue
      this.options.outbox.send({ id, channel: trigger.channel, text: this.explicitText(decision, trigger), kind: 'notice' })
    }
  }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    // The worker takes up a person's question by reporting it answered (`answers`); the question an answer Ticket started from
    // is taken up by the report that is its deliverable, so a ready or completed report answers it with no named registration.
    const originAnswered = !!ticket && !!trigger && ticket.deliverable === 'answer' && ticket.origin.triggerId === trigger.id
      && (latestReport(ticket)?.state === 'ready' || ticketOutcome(ticket) === 'completed')
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id) || originAnswered
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    // An answer to a person's message is that message's answer: the explicit-decision notice must not repeat it.
    if (request.purpose === 'answer' && trigger) {
      const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
      this.repo.triggers.saveDisposition(trigger.id, { ...disposition, answered: this.now() })
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
  /** The notice answering a whitelisted person's explicit message, in that message's language: outcome and reason. */
  private explicitText(decision: Decision, trigger: Trigger): string {
    const chinese = /\p{Script=Han}/u.test(trigger.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trigger.text)
    const own = decision.reason.filter(reason => reason.triggerId === undefined || reason.triggerId === trigger.id)
    // The notice supplies its own full stop, so one already ending the recorded reason would double it.
    const detail = reasonText(own.length ? own : decision.reason).replace(/[。.]$/u, '')
    const outcome = chinese
      ? decision.kind === 'ignore' ? '你的请求未被采纳' : decision.kind === 'unavailable' ? '你的请求暂时无法处理' : '已按你的请求停止'
      : decision.kind === 'ignore' ? 'Your request was not taken up'
        : decision.kind === 'unavailable' ? 'Your request could not be processed' : 'The work was stopped as you asked'
    return `${outcome}${detail ? `${chinese ? '：' : ': '}${detail}` : ''}${chinese ? '。' : '.'}`
  }
}
