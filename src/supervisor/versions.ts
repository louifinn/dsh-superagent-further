/**
 * Version resolution for the versioned domain runtime.
 *
 * The supervisor never trusts `<stateDir>/runtime/current.json`: it reads the descriptor, verifies that the entry stays
 * inside the runtime directory, that the file exists, that its SHA-256 matches the descriptor, and that the host API is the
 * one this supervisor implements. Anything invalid is rejected with a reason and the next candidate is tried; a broken
 * deployment therefore falls back to the previous verified version and then to the packaged runtime instead of stopping the
 * supervisor. The database schema is checked against the runtime's own exported `SCHEMA_VERSION` before the runtime is
 * started (see `loadRuntime`), so a downgrade can never migrate a newer database down.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HOST_API, type RuntimeDescriptor } from '../runtime-host.ts'

/** Where a runtime candidate came from, in the order the supervisor prefers them. */
export type RuntimeSource = 'journal' | 'current' | 'previous' | 'packaged'

/** A descriptor that passed every static check, with the absolute entry path and its source. */
export interface RuntimeCandidate {
  readonly source: RuntimeSource
  readonly descriptor: RuntimeDescriptor
  readonly entry: string
}

/** Why a stored descriptor was rejected; reported in the startup log and the journal, never fatal by itself. */
export interface VersionRejection {
  readonly source: RuntimeSource
  readonly reason: string
}

/** The ordered candidates and the rejected descriptors, newest preference first. */
export interface VersionResolution {
  readonly candidates: readonly RuntimeCandidate[]
  readonly rejected: readonly VersionRejection[]
}

/** The directory that holds `current.json`, `previous.json`, `journal.json`, and one directory per deployed version. */
export const runtimeDirectory = (stateDir: string): string => join(stateDir, 'runtime')
/** The pointer to the version that should start next. */
export const currentPointer = (runtimeDir: string): string => join(runtimeDir, 'current.json')
/** The pointer to the last known-good version, written by the update path before a swap. */
export const previousPointer = (runtimeDir: string): string => join(runtimeDir, 'previous.json')

/** A descriptor read from disk, or the reason the pointer could not be read. */
interface ReadDescriptor { readonly descriptor?: RuntimeDescriptor; readonly reason?: string }

/** Read and shape-check a descriptor file. A missing file is reported as a reason, so callers can fall through. */
export function readDescriptorFile(path: string): ReadDescriptor {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return { reason: `${path} does not exist or cannot be read` } }
  let value: unknown
  try { value = JSON.parse(text) } catch { return { reason: `${path} is not valid JSON` } }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { reason: `${path} does not contain a descriptor object` }
  const record = value as Record<string, unknown>
  if (typeof record.version !== 'string' || record.version === '') return { reason: `${path} has no version` }
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(record.version)) return { reason: `${path} has an unsafe version` }
  if (typeof record.entry !== 'string' || record.entry === '') return { reason: `${path} has no entry` }
  if (typeof record.hostApi !== 'number') return { reason: `${path} has no numeric hostApi` }
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(record.sha256)) return { reason: `${path} has no SHA-256` }
  if (record.schema !== undefined && (typeof record.schema !== 'number' || !Number.isInteger(record.schema))) {
    return { reason: `${path} has a non-integer schema` }
  }
  return {
    descriptor: {
      version: record.version, entry: record.entry, hostApi: record.hostApi, sha256: record.sha256.toLowerCase(),
      ...(record.schema === undefined ? {} : { schema: record.schema as number }),
    },
  }
}

/** The SHA-256 of a file, hex. Throws when the file cannot be read. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Resolve `entry` relative to `runtimeDir` and refuse absolute paths, parent traversal, and anything that resolves outside
 * the directory. Returns the absolute path, or the reason it is unsafe.
 */
export function safeEntry(runtimeDir: string, entry: string): { path?: string; reason?: string } {
  if (isAbsolute(entry)) return { reason: `entry ${entry} is absolute; it must be relative to ${runtimeDir}` }
  const path = resolve(runtimeDir, entry)
  const inside = relative(runtimeDir, path)
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
    return { reason: `entry ${entry} resolves outside ${runtimeDir}` }
  }
  if (!/\.(?:m?js)$/i.test(path)) return { reason: `entry ${entry} is not a JavaScript module` }
  return { path }
}

/**
 * Verify one descriptor against the runtime directory and the running supervisor. Returns the absolute entry and the
 * verifier's reason, if any. A descriptor's `entry` is relative to its own `<runtimeDir>/<version>` directory. A schema
 * below `databaseSchema` is rejected here, before any code from the bundle runs.
 */
export function verifyDescriptor(runtimeDir: string, descriptor: RuntimeDescriptor, databaseSchema?: number):
  { entry?: string; reason?: string } {
  if (descriptor.hostApi !== HOST_API) {
    return { reason: `version ${descriptor.version} was built for host API ${descriptor.hostApi}, but this supervisor implements ${HOST_API}` }
  }
  const versionDir = join(runtimeDir, descriptor.version)
  const safe = safeEntry(versionDir, descriptor.entry)
  if (safe.path === undefined) return { reason: safe.reason }
  if (!existsSync(safe.path)) return { reason: `version ${descriptor.version} entry ${descriptor.entry} does not exist` }
  let actual: string
  try { actual = sha256File(safe.path) } catch (error) {
    return { reason: `version ${descriptor.version} entry ${descriptor.entry} cannot be read: ${String(error)}` }
  }
  if (actual !== descriptor.sha256) {
    return { reason: `version ${descriptor.version} entry ${descriptor.entry} has hash ${actual}, not ${descriptor.sha256}` }
  }
  if (descriptor.schema !== undefined && databaseSchema !== undefined && descriptor.schema < databaseSchema) {
    return { reason: `version ${descriptor.version} supports schema ${descriptor.schema}, but the database is at ${databaseSchema}; a downgrade is never attempted` }
  }
  return { entry: safe.path }
}

/** Read the SQLite schema version without opening the Store, so a newer database is never handed to an older runtime. */
export function databaseSchema(databasePath: string): number | undefined {
  if (!existsSync(databasePath)) return undefined
  let database: { prepare: (sql: string) => { get: () => unknown }; close: () => void } | undefined
  try {
    // Imported lazily so a missing `node:sqlite` (older Node) degrades to "unknown schema", not a startup crash.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    database = new DatabaseSync(databasePath, { readOnly: true }) as unknown as { prepare: (sql: string) => { get: () => unknown }; close: () => void }
    const row = database.prepare("SELECT value FROM kv WHERE key = 'schema'").get() as { value?: unknown } | undefined
    if (row === undefined || typeof row.value !== 'string') return undefined
    const parsed: unknown = JSON.parse(row.value)
    return typeof parsed === 'number' && Number.isInteger(parsed) ? parsed : undefined
  } catch {
    return undefined
  } finally {
    try { database?.close() } catch { /* Already closed or never opened. */ }
  }
}

/**
 * Resolve every candidate the supervisor may start, in preference order: the recorded current version of an interrupted
 * journal, `current.json`, `previous.json`, then the packaged runtime. Each stored descriptor is verified independently; a
 * failure is recorded and skipped, never thrown.
 */
export function resolveVersions(runtimeDir: string, packaged: { descriptor: RuntimeDescriptor; entry: string }, databaseSchemaVersion?: number,
  interruptedCurrent?: RuntimeDescriptor): VersionResolution {
  const candidates: RuntimeCandidate[] = []
  const rejected: VersionRejection[] = []
  const offer = (source: RuntimeSource, descriptor: RuntimeDescriptor | undefined, missing?: string): void => {
    if (descriptor === undefined) {
      // A pointer that was never written is the normal first-run state, not a rejection worth reporting.
      if (missing !== undefined && !missing.includes('does not exist or cannot be read')) rejected.push({ source, reason: missing })
      return
    }
    const verified = verifyDescriptor(runtimeDir, descriptor, databaseSchemaVersion)
    if (verified.entry === undefined) rejected.push({ source, reason: verified.reason ?? 'unverified descriptor' })
    else candidates.push({ source, descriptor, entry: verified.entry })
  }
  if (interruptedCurrent !== undefined) offer('journal', interruptedCurrent)
  const current = readDescriptorFile(currentPointer(runtimeDir))
  offer('current', current.descriptor, current.reason)
  const previous = readDescriptorFile(previousPointer(runtimeDir))
  offer('previous', previous.descriptor, previous.reason)
  // The packaged runtime lives in the package, not under the state directory: its entry was verified by hash when it was
  // discovered, so it must not go through the state-directory path check. Its schema is checked again by the loader. It is
  // always the last candidate, even when it is also the current version, because it is the last-resort fallback.
  candidates.push({ source: 'packaged', descriptor: packaged.descriptor, entry: packaged.entry })
  return { candidates, rejected }
}
