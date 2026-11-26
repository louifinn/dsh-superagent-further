/** Persistence for durable user-notice requests and their approval (docs/016 notification section, issue #29, schema 28). */
import type { DatabaseSync } from 'node:sqlite'
import { userNoticeDedupe, type UserNoticeInput, type UserNoticeRecord, type UserNoticeStatus } from '../core/index.ts'
import { key } from '../core/ids.ts'

interface Row { id: string; value: string }

/**
 * One row per user-notice request. The raiser's words, approver, decision and delivery outcome live in the row so an
 * approval survives a restart and a failure stays visible instead of being retried silently forever.
 */
export class UserNoticeRecords {
  constructor(private readonly db: DatabaseSync) {}
  /** Record a request once per raiser and words; a duplicate returns the existing request. */
  add(input: UserNoticeInput): UserNoticeRecord {
    const dedupe = userNoticeDedupe(input.session, input.text)
    const existing = this.byDedupe(dedupe)
    if (existing) return existing
    const id = key('user-notice', input.session, input.text)
    const record: UserNoticeRecord = { id, dedupe, session: input.session, role: input.role, text: input.text,
      approver: input.approver, status: 'pending', createdAt: input.at, root: key('information', 'user-notice', id),
      ...(input.project === undefined ? {} : { project: input.project }), ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      ...(input.approverProject === undefined ? {} : { approverProject: input.approverProject }) }
    this.db.prepare(`INSERT INTO user_notice (id, dedupe, session, role, project, ticket, approver, approver_project, status, created_at, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, dedupe, record.session, record.role, record.project ?? '', record.ticketId ?? '',
      record.approver, record.approverProject ?? '', record.status, record.createdAt, JSON.stringify(record))
    return record
  }
  byDedupe(dedupe: string): UserNoticeRecord | undefined { const row = this.db.prepare('SELECT id, value FROM user_notice WHERE dedupe = ?').get(dedupe) as Row | undefined; return row ? JSON.parse(row.value) as UserNoticeRecord : undefined }
  get(id: string): UserNoticeRecord | undefined { const row = this.db.prepare('SELECT id, value FROM user_notice WHERE id = ?').get(id) as Row | undefined; return row ? JSON.parse(row.value) as UserNoticeRecord : undefined }
  /** Requests in one status, oldest first; omitted status lists every one. */
  list(status?: UserNoticeStatus): UserNoticeRecord[] {
    const rows = status === undefined ? this.rows('SELECT id, value FROM user_notice ORDER BY created_at, id')
      : this.rows('SELECT id, value FROM user_notice WHERE status = ? ORDER BY created_at, id', status)
    return rows
  }
  /** Pending requests whose approver is `approver`, oldest first. */
  pendingFor(approver: 'lead' | 'orchestrator', project?: string): UserNoticeRecord[] {
    return this.rows('SELECT id, value FROM user_notice WHERE status = ? AND approver = ? AND (? = \'\' OR project = ?) ORDER BY created_at, id',
      'pending', approver, project ?? '', project ?? '')
  }
  save(record: UserNoticeRecord): void {
    this.db.prepare(`UPDATE user_notice SET status = ?, value = ? WHERE id = ?`).run(record.status, JSON.stringify(record), record.id)
  }
  private rows(sql: string, ...values: string[]): UserNoticeRecord[] {
    return (this.db.prepare(sql).all(...values) as unknown as Row[]).map(row => JSON.parse(row.value) as UserNoticeRecord)
  }
}
