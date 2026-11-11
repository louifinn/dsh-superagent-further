/**
 * The runtime's read-only view of the supervisor's update pipeline. The supervisor owns the state machine and writes every
 * artefact under the state directory; this service only reads the pointers, the journal and the history, and it writes one
 * kind of file: a rollback request the supervisor's engine claims on its next poll (docs/adr/0007). It never uploads or
 * loads code, and it holds no mutable update state of its own.
 */
import { randomUUID } from 'node:crypto'
import type { UpdateRequest, UpdateSnapshot } from '../supervisor/update-state.ts'
import { isUpdateRequestConflict, updateSnapshot, writeUpdateRequest } from '../supervisor/update-state.ts'
import type { Logs } from './logs.ts'

/** What Overview needs to raise the update pipeline to the operator's attention. */
export interface UpdateAttention {
  /** True while a request is pending or the engine is applying one. */
  pending: boolean
  /** True when the last recorded outcome is a failure the engine could not roll back. */
  failed: boolean
  /** The version the pending request targets, or the version of the last recorded outcome. */
  version: string | null
  /** The last journal phase, when the journal shows an update was running or failed. */
  phase: string | null
  /** A short operator-facing reason, when there is one. */
  reason: string | null
}

export type RollbackRequestResult =
  | { ok: true; request: UpdateRequest; status: UpdateSnapshot }
  | { ok: false; reason: string }

export interface UpdatesHost {
  readonly stateDir: string
  readonly logs: Pick<Logs, 'record'>
}

/** The panel-facing façade over `src/supervisor/update-state.ts`; every read comes from disk. */
export class Updates {
  constructor(private readonly host: UpdatesHost) {}

  /** The serializable snapshot the panel polls. */
  status(): UpdateSnapshot {
    return updateSnapshot(this.host.stateDir)
  }

  /** Overview's needs-attention projection. */
  attention(): UpdateAttention {
    const status = this.status()
    const last = status.history.at(-1)
    const failed = last?.outcome === 'failed'
    const pending = status.pending !== null || status.busy
    const phase = status.journal?.phase ?? last?.phase ?? null
    return {
      pending,
      failed,
      version: status.pending?.version ?? last?.version ?? null,
      phase,
      reason: failed ? last?.reason ?? null : status.busy ? 'An update is in progress' : status.pending ? 'An update request is pending' : null,
    }
  }

  /**
   * Write one rollback request for the supervisor to claim. Eligibility is checked against the same on-disk state the panel
   * shows, so a stale page cannot ask for a rollback the engine would refuse anyway. The request file is the only output;
   * the caller audits the operator's action.
   */
  rollback(): RollbackRequestResult {
    const status = this.status()
    if (status.busy) return { ok: false, reason: 'An update is already in progress; wait for it to finish before rolling back.' }
    if (status.pending !== null) return { ok: false, reason: 'An update request is already pending; wait for it to be claimed before rolling back.' }
    if (!status.rollback.eligible) return { ok: false, reason: status.rollback.reason ?? 'There is no previous runtime to roll back to.' }
    const request: UpdateRequest = { api: 1, id: randomUUID(), action: 'rollback', at: new Date().toISOString(), by: 'operator' }
    try {
      writeUpdateRequest(this.host.stateDir, request)
    } catch (error) {
      // The check above is a courtesy to the operator; the exclusive create is the real guard against a concurrent writer.
      if (isUpdateRequestConflict(error)) {
        return { ok: false, reason: 'An update request is already pending; wait for it to be claimed or removed before rolling back.' }
      }
      throw error
    }
    this.host.logs.record('info', 'update', `update.requested action=rollback id=${request.id} actor=operator`)
    return { ok: true, request, status: this.status() }
  }
}
