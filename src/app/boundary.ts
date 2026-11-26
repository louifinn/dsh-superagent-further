/**
 * The boundary audit of a schema 26 Store (issue #37, ADR-0011): an in-process read that crossed a role or project
 * boundary is recorded with who asked, for what and whether it was refused. The boundary itself is operational — a
 * worker runs under danger-full-access and can bypass tools — but every tool-layer crossing is discoverable here and in
 * the operational log's `boundary` scope.
 */
import type { DatabaseSync } from 'node:sqlite'

/** One recorded boundary crossing: the role, what it read, and whether the read was allowed or refused. */
export interface BoundaryRecord {
  at: string
  role: string
  action: string
  resource: string
  project: string | null
  outcome: 'allowed' | 'refused'
  detail: string
}

/** The `audit_boundary` rows of the Store, plus an optional sink that mirrors each row into the operational log. */
export class BoundaryAudit {
  /** Installed by the Runtime once its logger exists, so a refusal also shows in panel Logs (scope `boundary`). */
  sink?: (entry: BoundaryRecord) => void

  constructor(private readonly db: DatabaseSync) {}

  /** Record one crossing; the detail is a short line that never carries a message body. */
  record(entry: BoundaryRecord): void {
    this.db.prepare(`INSERT INTO audit_boundary (at, role, action, resource, project, outcome, detail, value)
      VALUES (?,?,?,?,?,?,?,?)`).run(entry.at, entry.role, entry.action, entry.resource, entry.project ?? '',
      entry.outcome, entry.detail, JSON.stringify(entry))
    this.sink?.(entry)
  }

  /** The newest records first, optionally only refusals. */
  list(options: { limit?: number; outcome?: 'allowed' | 'refused' } = {}): BoundaryRecord[] {
    const limit = options.limit ?? 50
    const rows = options.outcome === undefined
      ? this.db.prepare('SELECT value FROM audit_boundary ORDER BY id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT value FROM audit_boundary WHERE outcome = ? ORDER BY id DESC LIMIT ?').all(options.outcome, limit)
    return rows.flatMap(row => {
      try { return [JSON.parse(String((row as Record<string, unknown>).value)) as BoundaryRecord] } catch { return [] }
    })
  }

  /** How many rows the audit holds, for a cheap health or panel count. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM audit_boundary').get() as Record<string, unknown> | undefined
    return Number(row?.n ?? 0)
  }
}
