/** Persistence for a person's one-shot Directives (docs/016 P8, issues #20–#22, schema 28). */
import type { DatabaseSync } from 'node:sqlite'
import { directiveChain, directiveDedupe, type DirectiveEffect, type DirectiveInput, type DirectiveRecord } from '../core/index.ts'
import { key } from '../core/ids.ts'

/** The columns a directive row keeps for lookup; the record itself is the JSON `value`. */
interface DirectiveRow { id: string; value: string }

/**
 * The durable record of every Directive a person gave a managed Session. One row per person's message (the dedupe key is
 * the Session and the message id), with its upward chain and consumption stamped in place; a redelivered message returns the
 * existing row and never starts a second adjustment.
 */
export class DirectiveRecords {
  constructor(private readonly db: DatabaseSync) {}
  /** Record a Directive once; a redelivery returns the existing record. */
  send(input: DirectiveInput): DirectiveRecord {
    const dedupe = directiveDedupe(input.source.sessionId, input.origin)
    const existing = this.byDedupe(dedupe)
    if (existing) return existing
    const id = input.id ?? key('directive', input.source.sessionId, input.origin)
    const record: DirectiveRecord = {
      id, text: input.text, origin: input.origin, source: input.source, at: input.at,
      ...(input.parent === undefined ? {} : { parent: input.parent.id, parentSession: input.parentSession }),
      root: input.parent?.root ?? id, hops: (input.parent?.hops ?? -1) + 1, audience: directiveChain(input.source.role),
    }
    this.db.prepare(`INSERT INTO directive (id, root, parent, source_role, source_project, source_session, source_ticket, parent_session, origin,
      dedupe, audience, created_at, propagated_at, consumed_at, effect, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.root, record.parent ?? '', record.source.role, record.source.project ?? '', record.source.sessionId,
        record.source.ticketId ?? '', record.parentSession ?? '', record.origin, dedupe, JSON.stringify(record.audience), record.at,
        record.propagatedAt ?? null, record.consumedAt ?? null, record.effect ?? null, JSON.stringify(record))
    return record
  }
  byDedupe(dedupe: string): DirectiveRecord | undefined { const row = this.db.prepare('SELECT id, value FROM directive WHERE dedupe = ?').get(dedupe) as DirectiveRow | undefined; return row ? JSON.parse(row.value) as DirectiveRecord : undefined }
  get(id: string): DirectiveRecord | undefined { const row = this.db.prepare('SELECT id, value FROM directive WHERE id = ?').get(id) as DirectiveRow | undefined; return row ? JSON.parse(row.value) as DirectiveRecord : undefined }
  /** Every unconsumed Directive, oldest first: the Orchestrator's pending queue. */
  pending(): DirectiveRecord[] { return this.rows('SELECT id, value FROM directive WHERE consumed_at IS NULL ORDER BY created_at, id') }
  /** The unconsumed Directive addressed to `ticketId`, if any: the source node the tool layer must not steer against. */
  pendingForTicket(ticketId: string): DirectiveRecord | undefined {
    return this.rows('SELECT id, value FROM directive WHERE consumed_at IS NULL AND source_ticket = ? ORDER BY created_at, id', ticketId)[0]
  }
  /** The unconsumed Directive whose parent hop is `session`, oldest first. */
  pendingForSession(session: string): DirectiveRecord[] {
    return this.rows('SELECT id, value FROM directive WHERE consumed_at IS NULL AND parent_session = ? ORDER BY created_at, id', session)
  }
  /** The unconsumed Directive a Session itself gave, oldest first: a Lead's or the Orchestrator's own turn consumes it. */
  pendingForSource(session: string): DirectiveRecord[] {
    return this.rows('SELECT id, value FROM directive WHERE consumed_at IS NULL AND source_session = ? ORDER BY created_at, id', session)
  }
  /** Every recorded Directive, oldest first, for the information/boundary audit. */
  all(): DirectiveRecord[] { return this.rows('SELECT id, value FROM directive ORDER BY created_at, id') }
  /** Whether `id` was consumed already. */
  consumed(id: string): boolean { return this.get(id)?.consumedAt !== undefined }
  markPropagated(id: string, at: string): void {
    const record = this.get(id)
    if (!record || record.propagatedAt) return
    this.save({ ...record, propagatedAt: at })
  }
  markConsumed(id: string, at: string, effect?: DirectiveEffect): void {
    const record = this.get(id)
    if (!record || record.consumedAt) return
    this.save({ ...record, consumedAt: at, ...(effect === undefined ? {} : { effect }) })
  }
  private save(record: DirectiveRecord): void {
    this.db.prepare(`UPDATE directive SET propagated_at = ?, consumed_at = ?, effect = ?, value = ? WHERE id = ?`)
      .run(record.propagatedAt ?? null, record.consumedAt ?? null, record.effect ?? null, JSON.stringify(record), record.id)
  }
  private rows(sql: string, ...values: (string | number)[]): DirectiveRecord[] {
    return (this.db.prepare(sql).all(...values) as unknown as DirectiveRow[]).map(row => JSON.parse(row.value) as DirectiveRecord)
  }
}
