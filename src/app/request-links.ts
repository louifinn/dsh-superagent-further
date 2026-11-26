/**
 * The durable `request_link` rows of a schema 26 Store (issue #32, decision 8 of ADR-0009): one row per Request of an
 * explicit same-need group, used for the audit trail and the panel's link line. The group itself also lives on
 * `Request.correlation`, so a reader that only has the Requests can still find the members.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { RequestLink, RequestLinksRepository } from '../core/correlation.ts'
import { key } from '../core/ids.ts'

/** The `request_link` rows of the Store, keyed by group and Request (issue #32, schema 26). */
export class RequestLinks implements RequestLinksRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(link: RequestLink): void {
    this.db.prepare(`INSERT INTO request_link (id, group_id, request, at, value) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id, request=excluded.request, at=excluded.at, value=excluded.value`)
      .run(key('request-link', link.group, link.request), link.group, link.request, link.at, JSON.stringify(link))
  }

  byGroup(group: string): string[] {
    return this.db.prepare('SELECT request FROM request_link WHERE group_id = ? ORDER BY rowid').all(group)
      .map(row => String((row as Record<string, unknown>).request))
  }

  groupOf(request: string): string | undefined {
    const row = this.db.prepare('SELECT group_id FROM request_link WHERE request = ? ORDER BY rowid DESC').get(request)
    return row === undefined ? undefined : String((row as Record<string, unknown>).group_id)
  }
}
