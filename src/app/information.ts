/**
 * Persists the authoritative information records of issue #13 (ADR-0009 decision 1, docs/016 P1–P5). A record is written
 * once per fact — delivery is an effect that reads it — and the `information` read resource plus `GET information` expose
 * the chain to the Orchestrator.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { InformationInput, InformationRole, InfoRecord } from '../core/information.ts'
import { ONE_SHOT_KINDS, directionOf, informationProblem } from '../core/information.ts'
import type { LeadMessage, LeadParty } from './lead-messages.ts'

/** Maps a durable-message party to a record role; an Executor is the worker of its Ticket. */
const roleOf = (party: LeadParty): InformationRole => party === 'executor' ? 'worker' : party
/** The information record a durable message stands for; `parent` is the record it answers (a fact answers its assignment). */
export const informationOf = (message: LeadMessage, parent?: InfoRecord): InformationInput => {
  const source = { role: roleOf(message.from), project: message.project }
  const target = { role: roleOf(message.to), project: message.project }
  const direction = directionOf(source.role, target.role)
  return {
    id: message.id, kind: message.kind, direction, source, target, audience: [target.role],
    hops: parent === undefined ? 0 : parent.hops + 1, oneShot: ONE_SHOT_KINDS.includes(message.kind),
    dedupe: informationDedupe(message.to, message.requestId), payload: { body: message.body, ticketId: message.ticketId, project: message.project },
    root: parent === undefined ? message.id : parent.root, ...(parent === undefined ? {} : { parent: parent.id }), createdAt: message.at,
  }
}
/** The idempotency key of a durable message's record: one record per recipient and request id. */
export const informationDedupe = (recipient: LeadParty, requestId: string): string => `${recipient}:${requestId}`
/** The dedupe key of the assignment a fact record answers, when the message is a fact. */
export const factParentDedupe = (message: LeadMessage): string | undefined => {
  if (message.kind !== 'fact' || !message.requestId.startsWith('lead-fact:')) return undefined
  const rest = message.requestId.slice('lead-fact:'.length)
  const cut = rest.indexOf(':')
  if (cut <= 0) return undefined
  return informationDedupe('lead', `lead-assignment:${rest.slice(0, cut)}`)
}
interface Row { id: string; value: string }

/**
 * Reads and writes the `information` table. Writes are single statements, so a caller's surrounding transaction can
 * include them; `send` returns the already-stored record for a duplicate dedupe key instead of creating a second source.
 */
export class Information {
  constructor(private readonly db: DatabaseSync) {}
  private parse(row: Row | undefined): InfoRecord | undefined {
    return row === undefined ? undefined : JSON.parse(row.value) as InfoRecord
  }
  /** Records one fact, or returns the record already stored for its dedupe key. */
  send(input: InformationInput, at = new Date().toISOString()): InfoRecord {
    const existing = this.byDedupe(input.dedupe)
    if (existing) return existing
    const record: InfoRecord = { ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? at }
    const problem = informationProblem(record)
    if (problem !== undefined) throw new Error(`The information record is invalid: ${problem}`)
    this.db.prepare('INSERT INTO information (id, root, parent, kind, direction, dedupe, created_at, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.root, record.parent ?? '', record.kind, record.direction, record.dedupe, record.createdAt, JSON.stringify(record))
    return record
  }
  /** Returns the record stored for a dedupe key, if any. */
  byDedupe(dedupe: string): InfoRecord | undefined {
    return this.parse(this.db.prepare('SELECT id, value FROM information WHERE dedupe = ?').get(dedupe) as unknown as Row | undefined)
  }
  /** Returns a record by id, if it exists. */
  byId(id: string): InfoRecord | undefined {
    return this.parse(this.db.prepare('SELECT id, value FROM information WHERE id = ?').get(id) as unknown as Row | undefined)
  }
  /** Returns records newest first, paged. */
  list(limit = 50, offset = 0): InfoRecord[] {
    return this.db.prepare('SELECT id, value FROM information ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?').all(limit, offset)
      .map(row => this.parse(row as unknown as Row)!)
  }
  /** Returns every record oldest first, for migration checks and invariants. */
  all(): InfoRecord[] {
    return this.db.prepare('SELECT id, value FROM information ORDER BY rowid').all()
      .map(row => this.parse(row as unknown as Row)!)
  }
  /** The number of recorded facts. */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM information').get() as unknown as { count: number }).count
  }
  /** Mirrors that the target's Session took the message; a later delivery is a no-op. */
  markDelivered(id: string, at = new Date().toISOString()): void {
    this.update(id, record => record.deliveredAt === undefined ? { ...record, deliveredAt: at } : record)
  }
  /** Mirrors that the target's answer arrived; a later acknowledgement is a no-op. */
  markAck(id: string, at = new Date().toISOString()): void {
    this.update(id, record => record.ackAt === undefined ? { ...record, ackAt: at } : record)
  }
  private update(id: string, change: (record: InfoRecord) => InfoRecord): void {
    const record = this.byId(id)
    if (!record) return
    const next = change(record)
    if (next === record) return
    this.db.prepare('UPDATE information SET value = ? WHERE id = ?').run(JSON.stringify(next), id)
  }
}
