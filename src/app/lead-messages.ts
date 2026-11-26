/**
 * Records the durable messages exchanged between a project's Lead Session and the Orchestrator (or a person writing to
 * the Lead): assignments, reports, questions, and notices. The records are authoritative — delivery is an effect that
 * reads them, never a second source of truth (docs/010-project-orchestrator.md).
 *
 * A message is written once per `(recipient, requestId)`: sending the same request again returns the stored record, so a
 * retried assignment or report cannot duplicate. `deliveredAt` says the recipient's Session has the text; `ackAt` says
 * the recipient's answer arrived, and the record stays for audit and for the panel.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { Information, factParentDedupe, informationOf } from './information.ts'

/** Who a record is from or to: the Orchestrator, a project's Lead, its Executor, or a person. */
export type LeadParty = 'orchestrator' | 'lead' | 'executor' | 'person'
/** What a record carries: work to start, a fact to release, a settled report, a question, or a notice. */
export type LeadMessageKind = 'assignment' | 'fact' | 'report' | 'question' | 'notice' | 'instruction'
/** A durable message between the Orchestrator and a project's Lead. */
export interface LeadMessage {
  id: string
  /** The registered project whose Lead the record concerns, by its project id. */
  project: string
  kind: LeadMessageKind
  from: LeadParty
  to: LeadParty
  /** The idempotency key of the message: the same request to the same recipient is one record. */
  requestId: string
  /** The Ticket the message concerns, when it concerns one. */
  ticketId?: string
  /** The text the recipient receives. */
  body: string
  at: string
  /** When the recipient's Session took the text, if it has. */
  deliveredAt?: string
  /** When the recipient's answer arrived, if it has. */
  ackAt?: string
}
/** The request id of the dispatch message that asks a Lead to start an Assignment; a re-dispatch adds its attempt. */
export const assignmentRequest = (assignmentId: string, again = 0): string =>
  `lead-assignment:${assignmentId}${again === 0 ? '' : `:again:${again}`}`
/** The Assignment id an assignment dispatch message names, or undefined when the request id is not one. */
export const assignmentOfRequest = (requestId: string): string | undefined => {
  if (!requestId.startsWith('lead-assignment:')) return undefined
  return requestId.slice('lead-assignment:'.length).split(':')[0] || undefined
}
/** The request id of the message that asks a Lead to release a Ticket's waiting Input to its running worker (issue #41). */
export const factRequest = (assignmentId: string, inputId: string): string => `lead-fact:${assignmentId}:${inputId}`
/** The Assignment and Input ids a fact grant message names, or undefined when the request id is not one. */
export const factOfRequest = (requestId: string): { assignmentId: string; inputId: string } | undefined => {
  if (!requestId.startsWith('lead-fact:')) return undefined
  const rest = requestId.slice('lead-fact:'.length)
  const cut = rest.indexOf(':')
  if (cut <= 0 || cut === rest.length - 1) return undefined
  return { assignmentId: rest.slice(0, cut), inputId: rest.slice(cut + 1) }
}
/** The fields a sender supplies; the Store stamps `id` and `at`. */
export type LeadMessageInput = Omit<LeadMessage, 'id' | 'at' | 'deliveredAt' | 'ackAt'>

const LeadMessageSchema = z.object({ id: z.string(), project: z.string(), kind: z.enum(['assignment', 'fact', 'report', 'question', 'notice', 'instruction']),
  from: z.enum(['orchestrator', 'lead', 'executor', 'person']), to: z.enum(['orchestrator', 'lead', 'executor', 'person']), requestId: z.string(),
  ticketId: z.string().optional(), body: z.string(), at: z.string(), deliveredAt: z.string().optional(), ackAt: z.string().optional() }).strict()

/** The row shape the `lead_message` table stores: a JSON record plus the columns reads and uniqueness use. */
interface Row { id: string; value: string }

/**
 * Reads and writes the `lead_message` table. The table and its indexes are created by `Store`, which keeps one instance
 * and exposes it as `store.leads`; all writes are single statements, so a caller's surrounding transaction can include them.
 */
export class LeadMessages {
  constructor(private readonly db: DatabaseSync, private readonly information?: Information) {}
  private parse(row: Row | undefined): LeadMessage | undefined {
    return row === undefined ? undefined : LeadMessageSchema.parse(JSON.parse(row.value))
  }
  /** Stores `input` unless the same recipient already has a message with its `requestId`, and returns the stored record. */
  send(input: LeadMessageInput, at = new Date().toISOString()): LeadMessage {
    const existing = this.getByRequest(input.to, input.requestId)
    if (existing) return existing
    const message: LeadMessage = { ...input, id: randomUUID(), at }
    // The authoritative record is written before the message: a lost delivery still leaves one source of the fact
    // (docs/016 P1, issue #13), and a redelivery of the same request finds it by its dedupe key.
    if (this.information) {
      const request = factParentDedupe(message)
      const parent = request === undefined ? undefined : this.information.byDedupe(request)
      this.information.send(informationOf(message, parent), at)
    }
    this.db.prepare('INSERT INTO lead_message (id, project, recipient, request, at, value) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, message.project, message.to, message.requestId, message.at, JSON.stringify(message))
    return message
  }
  /** Returns the message stored for `recipient` and `requestId`, if any. */
  getByRequest(recipient: LeadParty, requestId: string): LeadMessage | undefined {
    return this.parse(this.db.prepare('SELECT id, value FROM lead_message WHERE recipient = ? AND request = ?').get(recipient, requestId) as unknown as Row | undefined)
  }
  /** Returns a message by id, if it exists. */
  get(id: string): LeadMessage | undefined {
    return this.parse(this.db.prepare('SELECT id, value FROM lead_message WHERE id = ?').get(id) as unknown as Row | undefined)
  }
  /** Returns a project's messages, newest first, up to `limit`. */
  list(project: string, limit = 50): LeadMessage[] {
    return this.db.prepare('SELECT id, value FROM lead_message WHERE project = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(project, limit)
      .map(row => this.parse(row as unknown as Row)!)
  }
  /** Returns undelivered messages for `recipient`, oldest first, optionally for one project. */
  waiting(recipient: LeadParty, project?: string): LeadMessage[] {
    return this.db.prepare(`SELECT id, value FROM lead_message WHERE recipient = ? AND json_type(value, '$.deliveredAt') IS NULL
      ORDER BY at, rowid`).all(recipient)
      .map(row => this.parse(row as unknown as Row)!)
      .filter(message => project === undefined || message.project === project)
  }
  /** Returns every message oldest first, for the schema 27 backfill and audits. */
  all(): LeadMessage[] {
    return this.db.prepare('SELECT id, value FROM lead_message ORDER BY rowid').all()
      .map(row => this.parse(row as unknown as Row)!)
  }
  /** Records that the recipient's Session took the message; a later delivery attempt is a no-op. */
  deliver(id: string, at = new Date().toISOString()): void {
    this.update(id, message => message.deliveredAt === undefined ? { ...message, deliveredAt: at } : message)
    this.information?.markDelivered(id, at)
  }
  /** Records that the recipient's answer arrived; a later acknowledgement is a no-op. */
  ack(id: string, at = new Date().toISOString()): void {
    this.update(id, message => message.ackAt === undefined ? { ...message, ackAt: at } : message)
    this.information?.markAck(id, at)
  }
  private update(id: string, change: (message: LeadMessage) => LeadMessage): void {
    const message = this.get(id)
    if (!message) return
    const next = change(message)
    if (next === message) return
    this.db.prepare('UPDATE lead_message SET value = ? WHERE id = ?').run(JSON.stringify(next), id)
  }
}
