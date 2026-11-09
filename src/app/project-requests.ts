/** SQLite persistence for root and derived Project Requests (docs/012 D1, schema 21). */
import type { DatabaseSync } from 'node:sqlite'
import type { ProjectRequest, ProjectRequestRepository } from '../core/index.ts'

/**
 * The `project_request` table: each request's JSON record with the project, status and update time its listings read,
 * written by the Engine's project-request commands through the Store's `Repositories.projectRequests` repository.
 */
export class ProjectRequests implements ProjectRequestRepository {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): ProjectRequest | undefined {
    const row = this.db.prepare('SELECT value FROM project_request WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as ProjectRequest : undefined
  }
  /** Saves a request, refreshing the project, status and update time its listings and queue read. */
  save(request: ProjectRequest): void {
    this.db.prepare(`INSERT INTO project_request (id, project, status, updated, value) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project=excluded.project, status=excluded.status, updated=excluded.updated, value=excluded.value`)
      .run(request.id, request.project, request.status, request.updated_at, JSON.stringify(request))
  }
  /** Oldest first; `project` narrows the list to one project's requests. */
  list(project?: string): ProjectRequest[] {
    const rows = project === undefined ? this.db.prepare('SELECT value FROM project_request ORDER BY rowid').all()
      : this.db.prepare('SELECT value FROM project_request WHERE project=? ORDER BY rowid').all(project)
    return rows.map(row => JSON.parse(String(row.value)) as ProjectRequest)
  }
}
