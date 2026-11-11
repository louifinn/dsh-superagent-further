/**
 * The runtime update pipeline's on-disk contract: the operator request file, the append-only history, the database backup
 * and the read-only status snapshot the panel shows. Everything here is a plain file operation so the supervisor, the
 * deployment CLI and the panel can share one format without one importing another's process.
 *
 * The journal remains the source of truth for a crash in progress (see `journal.ts`); this module only adds the request
 * hand-off, the history of finished attempts, and the serializable view. No function uploads or downloads code: an
 * operator stages a built package on disk and writes a request that names it.
 */
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync,
  writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RuntimeDescriptor } from '../runtime-host.ts'
import { Journal, type JournalPhase, type JournalState } from './journal.ts'
import { currentPointer, databaseSchema, previousPointer, readDescriptorFile, runtimeDirectory, verifyDescriptor,
  type VersionRejection } from './versions.ts'

/** Request format version; a request with any other value is refused, never guessed at. */
export const UPDATE_API = 1 as const
/** How often a running supervisor looks for a request. The timer is unref'd so it never keeps the host alive. */
export const UPDATE_POLL_MS = 2_000
/** The history file is pruned to this many bytes, keeping the newest entries. */
export const UPDATE_HISTORY_MAX_BYTES = 256 * 1024
/** How many entries pruning keeps. */
export const UPDATE_HISTORY_KEEP = 200
/** How many entries the panel and `status` show. */
export const UPDATE_HISTORY_SHOWN = 12
/** SQLite's busy timeout while a backup reads a database the old runtime may still be writing. */
export const BACKUP_BUSY_TIMEOUT_MS = 30_000

/** The two actions an operator request may name. */
export type UpdateAction = 'apply' | 'rollback'
/** What an operator writes into `<stateDir>/updates/request.json`. */
export interface UpdateRequest {
  readonly api: typeof UPDATE_API
  readonly id: string
  readonly action: UpdateAction
  readonly version?: string
  readonly at: string
  readonly by: 'operator'
}
/** How an attempt ended, as recorded in the history and shown in the panel. */
export type UpdateOutcome = 'applied' | 'rolledback' | 'failed' | 'interrupted' | 'rejected'
/** One finished attempt. The journal carries the phases of an attempt still running; this file carries the outcomes. */
export interface UpdateHistoryEntry {
  readonly api: typeof UPDATE_API
  readonly id: string
  readonly action: UpdateAction | 'unknown'
  readonly outcome: UpdateOutcome
  readonly version: string | null
  readonly from: string | null
  readonly phase: JournalPhase | null
  readonly reason: string | null
  readonly at: string
  readonly durationMs: number | null
}
/** The journal's read-only projection in the status snapshot. */
export interface UpdateJournalView {
  readonly status: JournalState['status']
  readonly operation: JournalState['operation']
  readonly phase: JournalPhase
  readonly updatedAt: string
  readonly steps: JournalState['steps']
}
/** Whether the previous version can be started without a schema downgrade, and why not when it cannot. */
export interface UpdateRollbackView {
  readonly eligible: boolean
  readonly version: string | null
  readonly reason: string
}
/** The operator commands for this state directory, shown by the panel and printed by the CLI. */
export interface UpdateDeployView {
  readonly command: string
  readonly status: string
  readonly apply: string
  readonly rollback: string
  readonly watch: string
}
/** Everything the panel's Updates page reads, and the CLI prints. Read-only and serializable. */
export interface UpdateSnapshot {
  readonly api: typeof UPDATE_API
  readonly stateDir: string
  readonly current: RuntimeDescriptor | null
  readonly previous: RuntimeDescriptor | null
  readonly journal: UpdateJournalView | null
  readonly pending: UpdateRequest | null
  /** A request is claimed or an update is running: a new request must wait. */
  readonly busy: boolean
  readonly rollback: UpdateRollbackView
  readonly deploy: UpdateDeployView
  readonly history: UpdateHistoryEntry[]
  readonly databaseSchema: number | null
}
/** The result of atomically claiming the request file: one request, or why there is none. */
export interface UpdateClaim {
  readonly request?: UpdateRequest
  readonly reason?: 'none' | 'processing' | 'malformed' | 'unsupported'
  readonly detail?: string
}
/** The fields a descriptor pointer keeps; mirrors `RuntimeDescriptor` so a staged manifest can carry extras. */
export interface UpdateStatusOptions { readonly historyLimit?: number }

/** `<stateDir>/updates`, owned by the operator and 0700. */
export const updatesDirectory = (stateDir: string): string => join(stateDir, 'updates')
/** The request an operator writes and the supervisor claims. */
export const updateRequestPath = (stateDir: string): string => join(updatesDirectory(stateDir), 'request.json')
/** The claimed request; its presence means an update is running or a process died during one. */
export const updateProcessingPath = (stateDir: string): string => join(updatesDirectory(stateDir), 'request.processing.json')
/** The append-only outcome history. */
export const updateHistoryPath = (stateDir: string): string => join(runtimeDirectory(stateDir), 'history.jsonl')
/** Backups made before a swap, one file per attempt. */
export const updateBackupsDirectory = (stateDir: string): string => join(runtimeDirectory(stateDir), 'backups')
/** The journal the supervisor writes for startup, drain, and update operations. */
export const updateJournalPath = (stateDir: string): string => join(runtimeDirectory(stateDir), 'journal.json')

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]*$/
const MAX_ID = 64
const MAX_VERSION = 80
const MAX_REASON = 800

/** A short, bounded one-line reason safe to write into a log message and the history. */
export function shortReason(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1)}…`
}
const iso = (value: string): boolean => Number.isFinite(Date.parse(value))

/**
 * Strictly validate one request. Unknown keys, another `api`, an unknown action, a missing/extra `version` for the action,
 * and any unsafe version string are all refused: a supervisor and a CLI built at different times must not silently
 * reinterpret each other's files.
 */
export function parseUpdateRequest(value: unknown): { request?: UpdateRequest; reason?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { reason: 'the request is not an object' }
  const record = value as Record<string, unknown>
  const known = new Set(['api', 'id', 'action', 'version', 'at', 'by'])
  for (const key of Object.keys(record)) if (!known.has(key)) return { reason: `the request has an unknown field ${key}` }
  if (record.api !== UPDATE_API) return { reason: `the request api is ${String(record.api)}, not ${UPDATE_API}` }
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > MAX_ID) return { reason: 'the request has no usable id' }
  if (record.action !== 'apply' && record.action !== 'rollback') return { reason: 'the request action must be apply or rollback' }
  if (typeof record.at !== 'string' || !iso(record.at)) return { reason: 'the request has no ISO timestamp' }
  if (record.by !== 'operator') return { reason: 'the request must be written by an operator' }
  if (record.action === 'apply') {
    if (typeof record.version !== 'string' || !SAFE_VERSION.test(record.version) || record.version.length > MAX_VERSION) {
      return { reason: 'an apply request needs a safe version' }
    }
  } else if (record.version !== undefined) return { reason: 'a rollback request does not name a version' }
  return { request: {
    api: UPDATE_API, id: record.id, action: record.action, at: record.at, by: 'operator',
    ...(record.action === 'apply' ? { version: record.version as string } : {}),
  } }
}

/** Make a directory for operator files: recursive and 0700 where the platform honours it. */
function ownerDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}
/** Write one whole file atomically: a synced temporary file beside it, then a rename. */
function atomicWrite(path: string, body: string | Buffer): void {
  ownerDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}`
  const descriptor = openSync(temporary, 'w', 0o600)
  try {
    if (typeof body === 'string') writeSync(descriptor, body)
    else writeSync(descriptor, body)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
}
/** Read a request file and validate it; a missing file reports `present: false` without a reason. */
export function readUpdateRequest(path: string): { present: boolean; request?: UpdateRequest; reason?: string } {
  if (!existsSync(path)) return { present: false }
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { return { present: true, reason: `${path} is not valid JSON` } }
  const parsed = parseUpdateRequest(value)
  return parsed.request === undefined ? { present: true, reason: parsed.reason } : { present: true, request: parsed.request }
}

/** Write a request atomically as 0600 under the 0700 updates directory. */
export function writeUpdateRequest(stateDir: string, request: UpdateRequest): void {
  const checked = parseUpdateRequest(request)
  if (checked.request === undefined) throw new Error(`The update request is not valid: ${checked.reason ?? 'unknown reason'}`)
  atomicWrite(updateRequestPath(stateDir), `${JSON.stringify(checked.request, null, 2)}\n`)
}

/**
 * Claim the request with an atomic rename. A processing file that already exists means another process (or a crashed one)
 * owns the request; the caller must not process it again. A malformed file is left in place for the operator to inspect.
 */
export function claimUpdateRequest(stateDir: string): UpdateClaim {
  const requestPath = updateRequestPath(stateDir)
  const processing = updateProcessingPath(stateDir)
  if (!existsSync(requestPath)) {
    return existsSync(processing) ? { reason: 'processing' } : { reason: 'none' }
  }
  const read = readUpdateRequest(requestPath)
  if (read.request === undefined) return { reason: 'malformed', detail: read.reason ?? 'the request is invalid' }
  try {
    renameSync(requestPath, processing)
  } catch (error) {
    if (existsSync(processing)) return { reason: 'processing' }
    return { reason: 'unsupported', detail: error instanceof Error ? error.message : String(error) }
  }
  return { request: read.request }
}

/** Remove the claimed marker after a commit or a rollback; returns whether one was present. */
export function releaseUpdateClaim(stateDir: string): boolean {
  const processing = updateProcessingPath(stateDir)
  if (!existsSync(processing)) return false
  rmSync(processing, { force: true })
  return true
}

/** Read the newest `limit` valid history lines, oldest first. A torn line is skipped, never fatal. */
export function readUpdateHistory(stateDir: string, limit = UPDATE_HISTORY_SHOWN): UpdateHistoryEntry[] {
  let text: string
  try { text = readFileSync(updateHistoryPath(stateDir), 'utf8') } catch { return [] }
  const entries: UpdateHistoryEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line) as UpdateHistoryEntry
      if (value !== null && typeof value === 'object' && value.api === UPDATE_API && typeof value.id === 'string'
        && typeof value.at === 'string' && typeof value.outcome === 'string') entries.push(value)
    } catch { /* A torn last line from a crash is skipped; the journal still records the attempt. */ }
  }
  return entries.slice(-limit)
}

/** Keep the file bounded by rewriting its newest entries; only called when the file exceeded its budget. */
function pruneHistory(path: string): void {
  const kept = readUpdateHistoryFrom(path).slice(-UPDATE_HISTORY_KEEP)
  atomicWrite(path, kept.map(entry => `${JSON.stringify(entry)}\n`).join(''))
}
function readUpdateHistoryFrom(path: string): UpdateHistoryEntry[] {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  const entries: UpdateHistoryEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { entries.push(JSON.parse(line) as UpdateHistoryEntry) } catch { /* Torn line. */ }
  }
  return entries
}

/** Append one outcome as a single synced line; the file is pruned first when it has grown past its budget. */
export function appendUpdateHistory(stateDir: string, entry: Omit<UpdateHistoryEntry, 'api' | 'at'> & { at?: string }): UpdateHistoryEntry {
  const path = updateHistoryPath(stateDir)
  ownerDirectory(dirname(path))
  const complete: UpdateHistoryEntry = { api: UPDATE_API, at: entry.at ?? new Date().toISOString(), ...entry }
  if (existsSync(path) && statSync(path).size > UPDATE_HISTORY_MAX_BYTES) pruneHistory(path)
  const descriptor = openSync(path, 'a', 0o600)
  try {
    writeSync(descriptor, `${JSON.stringify(complete)}\n`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  return complete
}

/** The staged descriptor for one version, if its `runtime-manifest.json` is readable. */
export function stagedDescriptor(stateDir: string, version: string): { descriptor?: RuntimeDescriptor; reason?: string } {
  const path = join(runtimeDirectory(stateDir), version, 'runtime-manifest.json')
  return readDescriptorFile(path)
}

/** Write a descriptor pointer atomically; a descriptor carrying extra fields keeps only the contract fields. */
export function writeDescriptorFile(path: string, descriptor: RuntimeDescriptor): void {
  const pointer: RuntimeDescriptor = { version: descriptor.version, entry: descriptor.entry, hostApi: descriptor.hostApi,
    sha256: descriptor.sha256, ...(descriptor.schema === undefined ? {} : { schema: descriptor.schema }) }
  atomicWrite(path, `${JSON.stringify(pointer, null, 2)}\n`)
}

/** Remove a pointer if present; used when the pre-swap state had no file at that path. */
export function removeDescriptorFile(path: string): void {
  rmSync(path, { force: true })
}

/** The raw bytes of a pointer, for an exact rollback; undefined when the file did not exist. */
export function readPointerBytes(path: string): Buffer | undefined {
  try { return readFileSync(path) } catch { return undefined }
}
/** Restore a pointer exactly as it was before the swap (or remove it when it was absent). */
export function restorePointerBytes(path: string, bytes: Buffer | undefined): void {
  if (bytes === undefined) { rmSync(path, { force: true }); return }
  atomicWrite(path, bytes)
}

/**
 * `VACUUM INTO` a backup beside the state directory's database, before the old runtime is drained. Returns undefined when
 * there is no database yet (a first deployment needs no backup). SQLite's busy timeout bounds how long the copy waits for
 * the old runtime's writers.
 */
export function backupDatabase(stateDir: string, version: string, at: string): string | undefined {
  const database = join(stateDir, 'orchestrator.sqlite')
  if (!existsSync(database)) return undefined
  const directory = updateBackupsDirectory(stateDir)
  ownerDirectory(directory)
  const stamp = at.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '')
  const target = join(directory, `${version}-${stamp}.sqlite`)
  rmSync(target, { force: true })
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const connection = new DatabaseSync(database)
  try {
    connection.exec(`PRAGMA busy_timeout = ${BACKUP_BUSY_TIMEOUT_MS}`)
    connection.prepare('VACUUM INTO ?').run(target)
  } finally {
    connection.close()
  }
  return target
}

/**
 * Restore a backup over the state directory's database. The write-ahead log and shared-memory sidecars are removed first:
 * they describe the database that failed, and SQLite would otherwise replay them over the restored file.
 */
export function restoreDatabase(stateDir: string, backup: string): void {
  const database = join(stateDir, 'orchestrator.sqlite')
  for (const suffix of ['-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true })
  const temporary = `${database}.restoring`
  copyFileSync(backup, temporary)
  const descriptor = openSync(temporary, 'r+')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  renameSync(temporary, database)
}

/** Fingerprint helper shared with the drill and history details (not part of the runtime contract). */
export function updateFingerprint(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** The operator commands for one state directory; `deploy-runtime.mjs` lives in the package checkout. */
export function deployCommands(stateDir: string): UpdateDeployView {
  const command = `node --experimental-transform-types scripts/deploy-runtime.mjs --state-dir ${JSON.stringify(stateDir)}`
  return { command, status: `${command} status`, apply: `${command} apply --version <version>`,
    rollback: `${command} rollback`, watch: `${command} watch` }
}

/**
 * Build the read-only status snapshot: the two pointers, the journal projection, the pending request (sanitized to the
 * contract), whether a request is in flight, whether the previous version may be rolled back, the deploy commands and the
 * newest history. Every read is defensive: a missing or torn file becomes a null field, never a thrown route.
 */
export function updateSnapshot(stateDir: string, options: UpdateStatusOptions = {}): UpdateSnapshot {
  const runtimeDir = runtimeDirectory(stateDir)
  const current = readDescriptorFile(currentPointer(runtimeDir)).descriptor ?? null
  const previous = readDescriptorFile(previousPointer(runtimeDir)).descriptor ?? null
  const journal = new Journal(updateJournalPath(stateDir)).read()
  const request = readUpdateRequest(updateRequestPath(stateDir))
  const event = databaseSchema(join(stateDir, 'orchestrator.sqlite'))
  const processing = existsSync(updateProcessingPath(stateDir))
  const busy = processing || (journal !== undefined && journal.status === 'running' && journal.operation === 'update')
  const rollback = rollbackView(runtimeDir, previous, event, busy, request.request !== undefined)
  return {
    api: UPDATE_API, stateDir, current, previous,
    journal: journal === undefined ? null : { status: journal.status, operation: journal.operation, phase: journal.phase,
      updatedAt: journal.updatedAt, steps: journal.steps },
    pending: request.request ?? null, busy,
    rollback, deploy: deployCommands(stateDir),
    history: readUpdateHistory(stateDir, options.historyLimit ?? UPDATE_HISTORY_SHOWN),
    databaseSchema: event ?? null,
  }
}
function rollbackView(runtimeDir: string, previous: RuntimeDescriptor | null, event: number | undefined, busy: boolean,
  pending: boolean): UpdateRollbackView {
  if (previous === null) return { eligible: false, version: null, reason: 'No previous runtime is recorded' }
  const verified = verifyDescriptor(runtimeDir, previous, event)
  if (verified.entry === undefined) return { eligible: false, version: previous.version, reason: verified.reason ?? 'The previous runtime does not verify' }
  if (busy) return { eligible: false, version: previous.version, reason: 'An update is already running' }
  if (pending) return { eligible: false, version: previous.version, reason: 'An update request is already pending' }
  return { eligible: true, version: previous.version, reason: '' }
}

/** The descriptor sources a boot can use, exposed for the drill's diagnostics. */
export interface UpdateDescriptorState { readonly current: RuntimeDescriptor | null; readonly previous: RuntimeDescriptor | null
  readonly rejected: readonly VersionRejection[] }
export function descriptorState(stateDir: string): UpdateDescriptorState {
  const runtimeDir = runtimeDirectory(stateDir)
  const current = readDescriptorFile(currentPointer(runtimeDir))
  const previous = readDescriptorFile(previousPointer(runtimeDir))
  const rejected: VersionRejection[] = []
  if (current.descriptor === undefined && current.reason !== undefined && !current.reason.includes('does not exist or cannot be read')) {
    rejected.push({ source: 'current', reason: current.reason })
  }
  if (previous.descriptor === undefined && previous.reason !== undefined && !previous.reason.includes('does not exist or cannot be read')) {
    rejected.push({ source: 'previous', reason: previous.reason })
  }
  return { current: current.descriptor ?? null, previous: previous.descriptor ?? null, rejected }
}

export type { RuntimeDescriptor }
