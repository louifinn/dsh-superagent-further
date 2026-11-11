/**
 * Update engine tests over fake runtime bundles: the journaled apply and rollback, a failed init restoring the database and
 * both pointers, the schema-downgrade refusal, a claimed request, crash recovery, a malformed request and a stop during an
 * update. The fake bundles are tiny ESM files under the test's state directory, as in `supervisor.spec.ts`.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Journal } from '../src/supervisor/journal.ts'
import { Supervisor, type SupervisorOptions } from '../src/supervisor/supervisor.ts'
import {
  backupDatabase, claimUpdateRequest, readUpdateHistory, restoreDatabase, updateBackupsDirectory, updateProcessingPath,
  updateRequestPath,
} from '../src/supervisor/update-state.ts'
import { currentPointer, previousPointer, runtimeDirectory } from '../src/supervisor/versions.ts'
import { HOST_API, type RuntimeDescriptor } from '../src/runtime-host.ts'
import { startRuntime, type FakeAgent } from './fixtures/host.ts'
import { fakeWorkspaces } from './fixtures/workspaces.ts'
import { testMachine } from './fixtures/deployment.ts'

let directory: string
const running: Supervisor[] = []
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'update-'))
})
afterEach(async () => {
  for (const supervisor of running.splice(0)) await supervisor.stop().catch(() => {})
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

interface BundleOptions {
  readyRejects?: string
  configuredThrows?: boolean
  incompleteDrain?: boolean
  drainDelayMs?: number
  schema?: number
  hostApi?: number
}
/** A fake runtime bundle that appends the version it started and the reason it drained beside itself. */
function runtimeSource(version: string, options: BundleOptions = {}): string {
  const ready = options.readyRejects === undefined ? 'Promise.resolve()'
    : `Promise.reject(new Error(${JSON.stringify(options.readyRejects)}))`
  const configured = options.configuredThrows ? 'configured: () => { throw new Error(\'configured exploded\') },'
    : 'configured: () => true,'
  return `import { appendFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
export const HOST_API = ${options.hostApi ?? HOST_API}
export const SCHEMA_VERSION = ${options.schema ?? 25}
export function createRuntime(host) {
  appendFileSync(new URL('./started.txt', import.meta.url), ${JSON.stringify(version)} + '\\n')
  return {
    ready: ${ready},
    ${configured}
    get setupProblem() { return undefined },
    drain: async (reason) => {
      appendFileSync(new URL('./drained.txt', import.meta.url), reason + '\\n')
      ${options.drainDelayMs === undefined ? '' : `await new Promise(resolve => setTimeout(resolve, ${options.drainDelayMs}))`}
      return { reason, startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, completed: ${options.incompleteDrain === true ? 'false' : 'true'},
        phases: [{ phase: 'intake', status: ${options.incompleteDrain === true ? "'failed'" : "'done'"}, startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1 }] }
    },
    dispose: async () => { appendFileSync(new URL('./disposed.txt', import.meta.url), ${JSON.stringify(version)} + '\\n') },
  }
}`
}

/** Write a deployed version under the runtime directory and point current.json at it. */
function deploy(version: string, options: BundleOptions = {}): RuntimeDescriptor {
  return stage(version, options, true)
}
/** Write a staged version and its refreshed manifest; `current` also points current.json at it. */
function stage(version: string, options: BundleOptions = {}, current = false): RuntimeDescriptor {
  const root = runtimeDirectory(directory)
  const folder = join(root, version)
  mkdirSync(folder, { recursive: true })
  const source = runtimeSource(version, options)
  writeFileSync(join(folder, 'runtime-entry.js'), source)
  const descriptor: RuntimeDescriptor = { version, entry: 'runtime-entry.js', hostApi: options.hostApi ?? HOST_API,
    sha256: hash(source), schema: options.schema ?? 25 }
  writeFileSync(join(folder, 'runtime-manifest.json'), JSON.stringify(descriptor, null, 2))
  if (current) writeFileSync(currentPointer(root), JSON.stringify(descriptor))
  return descriptor
}
/** A packaged fallback outside the state directory. */
function packaged(version = 'packaged', options: BundleOptions = {}): { descriptor: RuntimeDescriptor; entry: string } {
  const entry = join(directory, `${version}.js`)
  const source = runtimeSource(version, options)
  writeFileSync(entry, source)
  return { descriptor: { version, entry: `${version}.js`, hostApi: options.hostApi ?? HOST_API, sha256: hash(source),
    schema: options.schema ?? 25 }, entry }
}
function newSupervisor(extra: Partial<SupervisorOptions> = {}): Supervisor {
  const supervisor = new Supervisor({ context: new Context(), machine: testMachine({ stateDir: directory }),
    packaged: () => packaged(), updatePollMs: 10, ...extra })
  running.push(supervisor)
  return supervisor
}
/** Create the state database with one schema row and one marker row the tests can watch through a restore. */
function database(schema = 25, marker = 'old'): void {
  mkdirSync(directory, { recursive: true })
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const connection = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
  try {
    connection.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)')
    connection.prepare('INSERT INTO kv VALUES (?, ?)').run('schema', String(schema))
    connection.prepare('INSERT INTO kv VALUES (?, ?)').run('marker', marker)
  } finally {
    connection.close()
  }
}
function marker(): string | undefined {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const connection = new DatabaseSync(join(directory, 'orchestrator.sqlite'), { readOnly: true })
  try {
    const row = connection.prepare("SELECT value FROM kv WHERE key = 'marker'").get() as { value?: string } | undefined
    return row?.value
  } finally {
    connection.close()
  }
}
/** Move the database forward exactly the way a candidate runtime's Store migration would (schema and marker together). */
function migrateDatabase(schema = 26, value = 'new'): void {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const connection = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
  try {
    connection.prepare("UPDATE kv SET value = ? WHERE key = 'schema'").run(String(schema))
    connection.prepare("UPDATE kv SET value = ? WHERE key = 'marker'").run(value)
  } finally {
    connection.close()
  }
}
/**
 * Commit a migration into the database's write-ahead log, as a candidate's `init` does before it dies, and leave the state
 * directory in the crash shape: the main file still holds the baseline rows while the `-wal`/`-shm` sidecars carry the
 * migration. A holder with an open read transaction keeps SQLite from checkpointing the frames; the trio is snapshotted, the
 * holder closed and the snapshot put back, so no live connection holds the files when the supervisor boots.
 */
function migrateInWal(schema = 26, value = 'new'): void {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const path = join(directory, 'orchestrator.sqlite')
  const snapshot = mkdtempSync(join(tmpdir(), 'update-wal-'))
  const holder = new DatabaseSync(path)
  try {
    holder.exec('PRAGMA journal_mode = WAL')
    holder.exec('PRAGMA wal_autocheckpoint = 0')
    holder.exec('BEGIN')
    holder.prepare("SELECT value FROM kv WHERE key = 'schema'").get()
    const writer = new DatabaseSync(path)
    try {
      writer.exec('PRAGMA wal_autocheckpoint = 0')
      writer.prepare("UPDATE kv SET value = ? WHERE key = 'schema'").run(String(schema))
      writer.prepare("UPDATE kv SET value = ? WHERE key = 'marker'").run(value)
    } finally {
      writer.close()
    }
    for (const suffix of ['', '-wal', '-shm']) {
      if (!existsSync(`${path}${suffix}`)) throw new Error(`the WAL database has no ${suffix === '' ? 'main' : suffix} file`)
      copyFileSync(`${path}${suffix}`, join(snapshot, `orchestrator.sqlite${suffix}`))
    }
    holder.exec('COMMIT')
  } finally {
    holder.close()
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
  for (const suffix of ['', '-wal', '-shm']) copyFileSync(join(snapshot, `orchestrator.sqlite${suffix}`), `${path}${suffix}`)
  rmSync(snapshot, { recursive: true, force: true })
}
/** The schema of a copy of the main database file alone, ignoring the WAL: the baseline a crashed candidate left behind. */
function mainFileSchema(): number | undefined {
  const scratch = mkdtempSync(join(tmpdir(), 'update-main-'))
  try {
    const copy = join(scratch, 'main.sqlite')
    copyFileSync(join(directory, 'orchestrator.sqlite'), copy)
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const connection = new DatabaseSync(copy, { readOnly: true })
    try {
      const row = connection.prepare("SELECT value FROM kv WHERE key = 'schema'").get() as { value?: string } | undefined
      return row?.value === undefined ? undefined : Number(row.value)
    } finally {
      connection.close()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
/** The WAL sidecar SQLite would replay over the main file. */
const walPath = (): string => join(directory, 'orchestrator.sqlite-wal')
/** The schema marker the supervisor reads at boot, or undefined when the database is missing. */
function schemaVersion(): number | undefined {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const connection = new DatabaseSync(join(directory, 'orchestrator.sqlite'), { readOnly: true })
  try {
    const row = connection.prepare("SELECT value FROM kv WHERE key = 'schema'").get() as { value?: string } | undefined
    return row?.value === undefined ? undefined : Number(row.value)
  } finally {
    connection.close()
  }
}
/** Write one operator request atomically, as the deployment CLI does. */
function request(action: 'apply' | 'rollback', version?: string): void {
  mkdirSync(join(directory, 'updates'), { recursive: true })
  writeFileSync(updateRequestPath(directory), JSON.stringify({ api: 1, id: `request-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action, ...(version === undefined ? {} : { version }), at: new Date().toISOString(), by: 'operator' }, null, 2))
}
const journal = (): ReturnType<Journal['read']> => new Journal(join(runtimeDirectory(directory), 'journal.json')).read()
const pointer = (path: string): RuntimeDescriptor | undefined => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as RuntimeDescriptor } catch { return undefined }
}
const lines = (path: string): string[] => {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
const started = (version: string): string[] => lines(join(runtimeDirectory(directory), version, 'started.txt'))
async function until(check: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the condition did not become true in time')
}
/**
 * Leave the journal and both pointers exactly as a death in `phase` would after the swap wrote them: the journal still runs
 * at that phase with the serving version and the pre-update previous recorded, while `current.json` names the candidate.
 * `options.backup` records the pre-swap database copy the engine took before the swap, as `noteBackup` does.
 */
function leaveCrash(phase: 'swap' | 'load' | 'init' | 'commit', serving: RuntimeDescriptor, previous: RuntimeDescriptor | null,
  target: RuntimeDescriptor, options: { backup?: string } = {}): void {
  const crashJournal = new Journal(join(runtimeDirectory(directory), 'journal.json'))
  crashJournal.begin('update', serving, previous)
  for (const name of ['prepare', 'stage', 'backup', 'drain', 'swap', 'load', 'init', 'commit'] as const) {
    if (name === phase) { crashJournal.mark(name, 'started'); break }
    crashJournal.mark(name, 'done')
  }
  if (options.backup !== undefined) crashJournal.noteBackup(options.backup)
  writeFileSync(previousPointer(runtimeDirectory(directory)), JSON.stringify(serving))
  writeFileSync(currentPointer(runtimeDirectory(directory)), JSON.stringify(target))
  mkdirSync(join(directory, 'updates'), { recursive: true })
  writeFileSync(updateProcessingPath(directory), JSON.stringify({ api: 1, id: `crash-${phase}`, action: 'apply',
    version: target.version, at: new Date().toISOString(), by: 'operator' }))
}
/** Leave a committed update journal, as a death between `journal.commit` and the history write would. */
function leaveCommitted(serving: RuntimeDescriptor, target: RuntimeDescriptor, backup?: string): void {
  const committed = new Journal(join(runtimeDirectory(directory), 'journal.json'))
  committed.begin('update', serving, null)
  for (const name of ['prepare', 'stage', 'backup', 'drain', 'swap', 'load', 'init', 'commit'] as const) committed.mark(name, 'done')
  committed.commit({ current: target, previous: serving })
  if (backup !== undefined) committed.noteBackup(backup)
  writeFileSync(previousPointer(runtimeDirectory(directory)), JSON.stringify(serving))
  writeFileSync(currentPointer(runtimeDirectory(directory)), JSON.stringify(target))
}

describe('update engine', () => {
  it('applies a staged runtime through every journal phase and updates both pointers and history', async () => {
    database()
    deploy('1.0.0')
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()?.version).toBe('1.0.0')
    stage('2.0.0')
    request('apply', '2.0.0')
    await until(() => supervisor.versionStatus()?.version === '2.0.0')
    expect(supervisor.versionStatus()).toMatchObject({ version: '2.0.0', source: 'current', schema: 25 })
    const state = journal()!
    expect(state.operation).toBe('update')
    expect(state.status).toBe('committed')
    expect(state.steps.map(step => `${step.phase}:${step.state}`)).toEqual(expect.arrayContaining([
      'prepare:started', 'prepare:done', 'stage:started', 'stage:done', 'backup:done', 'drain:done', 'swap:done',
      'load:done', 'init:done', 'commit:done']))
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('2.0.0')
    expect(pointer(previousPointer(runtimeDirectory(directory)))?.version).toBe('1.0.0')
    expect(existsSync(updateProcessingPath(directory))).toBe(false)
    expect(readUpdateHistory(directory, 5).at(-1)).toMatchObject({ action: 'apply', outcome: 'applied', version: '2.0.0', from: '1.0.0' })
    expect(lines(join(runtimeDirectory(directory), '1.0.0', 'drained.txt'))).toEqual(['update'])
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual(['2.0.0'])
    expect(supervisor.logs.list({ limit: 200 }).some(entry => entry.message.startsWith('update.applied version=2.0.0'))).toBe(true)
    expect(supervisor.updateStatus()).toMatchObject({ current: { version: '2.0.0' }, previous: { version: '1.0.0' }, busy: false })
  })

  it('rolls back to the previous runtime and records the outcome', async () => {
    database()
    deploy('1.0.0')
    const supervisor = newSupervisor()
    await supervisor.start()
    stage('2.0.0')
    request('apply', '2.0.0')
    await until(() => supervisor.versionStatus()?.version === '2.0.0')
    request('rollback')
    await until(() => supervisor.versionStatus()?.version === '1.0.0')
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('1.0.0')
    expect(pointer(previousPointer(runtimeDirectory(directory)))?.version).toBe('2.0.0')
    const last = readUpdateHistory(directory, 5).at(-1)!
    expect(last).toMatchObject({ action: 'rollback', outcome: 'applied', version: '1.0.0', from: '2.0.0' })
    expect(journal()).toMatchObject({ operation: 'update', status: 'committed', phase: 'commit' })
  })

  it('restores the database and both pointers and reloads the previous runtime when the new runtime fails to initialize', async () => {
    database(25, 'old')
    deploy('1.0.0')
    const supervisor = newSupervisor()
    await supervisor.start()
    stage('2.0.0', { readyRejects: 'the new runtime exploded' })
    request('apply', '2.0.0')
    await until(() => journal()?.status === 'failed')
    await until(() => supervisor.versionStatus()?.version === '1.0.0')
    expect(marker()).toBe('old')
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('1.0.0')
    expect(existsSync(previousPointer(runtimeDirectory(directory)))).toBe(false)
    expect(journal()).toMatchObject({ status: 'failed', phase: 'rollback' })
    expect(readUpdateHistory(directory, 5).at(-1)).toMatchObject({ outcome: 'rolledback', phase: 'rollback' })
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual(['2.0.0'])
    expect(lines(join(runtimeDirectory(directory), '1.0.0', 'started.txt'))).toEqual(['1.0.0', '1.0.0'])
    expect(supervisor.logs.list({ limit: 200 }).some(entry => entry.message.startsWith('update.failed phase=init'))).toBe(true)
    expect(supervisor.logs.list({ limit: 200 }).some(entry => entry.message.startsWith('update.rolledback'))).toBe(true)
  })

  it('refuses a schema downgrade before draining the running runtime', async () => {
    database(26)
    deploy('1.0.0', { schema: 26 })
    const supervisor = newSupervisor()
    await supervisor.start()
    stage('2.0.0', { schema: 25 })
    request('apply', '2.0.0')
    await until(() => journal()?.status === 'failed')
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('1.0.0')
    expect(supervisor.versionStatus()?.version).toBe('1.0.0')
    expect(journal()?.phase).toBe('stage')
    expect(readUpdateHistory(directory, 5).at(-1)).toMatchObject({ outcome: 'failed', phase: 'stage' })
    expect(lines(join(runtimeDirectory(directory), '1.0.0', 'drained.txt'))).toEqual([])
    expect(supervisor.logs.list({ limit: 200 }).some(entry => entry.message.includes('downgrade is never attempted'))).toBe(true)
  })

  it('reconciles the pointers after a crash in the swap phase and starts the recorded version on the next boot', async () => {
    database()
    const first = deploy('1.0.0')
    const staged = stage('2.0.0')
    leaveCrash('swap', first, null, staged)
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'journal' })
    await until(() => !existsSync(updateProcessingPath(directory)))
    expect(readUpdateHistory(directory, 5).at(-1)).toMatchObject({ id: 'crash-swap', outcome: 'interrupted', phase: 'swap' })
    // The swap had written both pointers to the candidate; recovery restores the journal's baseline before starting anything.
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('1.0.0')
    expect(existsSync(previousPointer(runtimeDirectory(directory)))).toBe(false)
    expect(supervisor.logs.list({ limit: 200 }).some(entry =>
      entry.message === 'update.pointers-reconciled phase=swap current=1.0.0 previous=none')).toBe(true)
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual([])
    expect(supervisor.updateStatus()).toMatchObject({ current: { version: '1.0.0' }, previous: null })
    // A second boot has no interrupted journal to lean on: without the reconciled pointer it would silently start the candidate.
    await supervisor.stop()
    const second = newSupervisor()
    await second.start()
    expect(second.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current' })
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('1.0.0')
    expect(existsSync(previousPointer(runtimeDirectory(directory)))).toBe(false)
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual([])
    expect(second.updateStatus()).toMatchObject({ current: { version: '1.0.0' }, previous: null })
  })

  it('restores the recorded previous pointer after a crash in init and serves the restored current on the next boot', async () => {
    database()
    const older = deploy('0.9.0')
    const first = deploy('1.0.0')
    const staged = stage('2.0.0')
    leaveCrash('init', first, older, staged)
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'journal' })
    await until(() => !existsSync(updateProcessingPath(directory)))
    expect(readUpdateHistory(directory, 5).at(-1)).toMatchObject({ id: 'crash-init', outcome: 'interrupted', phase: 'init' })
    // current.json is the pre-update version again and previous.json is the journal's baseline, not the old current the swap wrote.
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('1.0.0')
    expect(pointer(previousPointer(runtimeDirectory(directory)))?.version).toBe('0.9.0')
    expect(supervisor.logs.list({ limit: 200 }).some(entry =>
      entry.message === 'update.pointers-reconciled phase=init current=1.0.0 previous=0.9.0')).toBe(true)
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual([])
    expect(supervisor.updateStatus()).toMatchObject({ current: { version: '1.0.0' }, previous: { version: '0.9.0' } })
    await supervisor.stop()
    const second = newSupervisor()
    await second.start()
    expect(second.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current' })
    expect(pointer(previousPointer(runtimeDirectory(directory)))?.version).toBe('0.9.0')
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual([])
    expect(second.updateStatus()).toMatchObject({ current: { version: '1.0.0' }, previous: { version: '0.9.0' } })
  })

  it('restores the journaled database backup when a crashed candidate had already migrated the schema', async () => {
    database(25, 'old')
    const serving = deploy('1.0.0')
    const staged = stage('2.0.0', { schema: 26 })
    const backup = backupDatabase(directory, '2.0.0', '2026-11-11T10:00:00.000Z')
    expect(backup).toBeDefined()
    expect(backup!.startsWith(updateBackupsDirectory(directory))).toBe(true)
    // The candidate's Store migration committed inside its init before the process died: the database is now newer than every
    // startable runtime, so the journal's recorded baseline (schema 25) would be refused by the supervisor and the loader.
    migrateDatabase(26, 'new')
    leaveCrash('init', serving, null, staged, { backup })
    const noPackage = (): never => { throw new Error('this test has no packaged runtime') }
    const supervisor = newSupervisor({ packaged: noPackage })
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'journal' })
    expect(schemaVersion()).toBe(25)
    expect(marker()).toBe('old')
    expect(supervisor.logs.list({ limit: 200 }).some(entry =>
      entry.message.startsWith('update.database-restored phase=init schema=25'))).toBe(true)
    // The pointer reconciliation still runs: the uncommitted schema-26 candidate is never adopted.
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('1.0.0')
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual([])
    await supervisor.stop()
    const second = newSupervisor({ packaged: noPackage })
    await second.start()
    expect(second.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current' })
    expect(schemaVersion()).toBe(25)
    expect(marker()).toBe('old')
  })

  it('never restores a backup for a committed journal', async () => {
    database(25, 'old')
    const serving = deploy('1.0.0')
    const target = deploy('2.0.0', { schema: 26 })
    const backup = backupDatabase(directory, '2.0.0', '2026-11-11T10:05:00.000Z')
    expect(backup).toBeDefined()
    migrateDatabase(26, 'new')
    leaveCommitted(serving, target, backup)
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '2.0.0', source: 'current' })
    expect(schemaVersion()).toBe(26)
    expect(marker()).toBe('new')
    expect(supervisor.logs.list({ limit: 200 }).some(entry => entry.message.startsWith('update.database-restored'))).toBe(false)
  })

  it('fails closed and leaves the migrated database untouched when the journaled backup is missing', async () => {
    database(25, 'old')
    const serving = deploy('1.0.0')
    const staged = stage('2.0.0', { schema: 26 })
    const backup = backupDatabase(directory, '2.0.0', '2026-11-11T10:10:00.000Z')
    expect(backup).toBeDefined()
    migrateDatabase(26, 'new')
    rmSync(backup!, { force: true })
    leaveCrash('init', serving, null, staged, { backup })
    const supervisor = newSupervisor({ packaged: (): never => { throw new Error('this test has no packaged runtime') } })
    await expect(supervisor.start()).rejects.toThrow(/no candidate runtime could be resolved/)
    expect(schemaVersion()).toBe(26)
    expect(marker()).toBe('new')
    expect(supervisor.logs.list({ limit: 200 }).some(entry => entry.message.startsWith('update.database-restored'))).toBe(false)
    expect(supervisor.logs.list({ limit: 200 }).some(entry =>
      entry.message.startsWith('update.database-restore-skipped phase=init'))).toBe(true)
  })

  it('leaves a WAL-migrated database untouched when the journaled backup is missing and refuses on the next boot too', async () => {
    database(25, 'old')
    const serving = deploy('1.0.0')
    const staged = stage('2.0.0', { schema: 26 })
    const backup = backupDatabase(directory, '2.0.0', '2026-11-11T10:20:00.000Z')
    expect(backup).toBeDefined()
    migrateInWal(26, 'new')
    // The migration lives only in the write-ahead log: the main file still reads the schema-25 baseline.
    expect(schemaVersion()).toBe(26)
    expect(mainFileSchema()).toBe(25)
    rmSync(backup!, { force: true })
    leaveCrash('init', serving, null, staged, { backup })
    const noPackage = (): never => { throw new Error('this test has no packaged runtime') }
    const supervisor = newSupervisor({ packaged: noPackage })
    await expect(supervisor.start()).rejects.toThrow(/no candidate runtime could be resolved/)
    // Removing the WAL would drop the candidate's committed migration and let the next boot read schema 25 and start.
    expect(existsSync(walPath())).toBe(true)
    expect(schemaVersion()).toBe(26)
    expect(marker()).toBe('new')
    expect(supervisor.logs.list({ limit: 200 }).some(entry => entry.message.startsWith('update.database-restored'))).toBe(false)
    expect(supervisor.logs.list({ limit: 200 }).some(entry =>
      entry.message.startsWith('update.database-restore-skipped phase=init'))).toBe(true)
    // A second boot has no in-memory schema to lean on: it must still see 26 and refuse, never start the baseline.
    const second = newSupervisor({ packaged: noPackage })
    await expect(second.start()).rejects.toThrow(/no candidate runtime could be resolved/)
    expect(schemaVersion()).toBe(26)
    expect(marker()).toBe('new')
  })

  it('restores a WAL-migrated database from the journaled backup and serves the baseline runtime', async () => {
    database(25, 'old')
    const serving = deploy('1.0.0')
    const staged = stage('2.0.0', { schema: 26 })
    const backup = backupDatabase(directory, '2.0.0', '2026-11-11T10:25:00.000Z')
    expect(backup).toBeDefined()
    migrateInWal(26, 'new')
    leaveCrash('init', serving, null, staged, { backup })
    const noPackage = (): never => { throw new Error('this test has no packaged runtime') }
    const supervisor = newSupervisor({ packaged: noPackage })
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'journal' })
    expect(schemaVersion()).toBe(25)
    expect(marker()).toBe('old')
    // The restored copy replaces the database and the WAL that described the failed candidate is gone.
    expect(existsSync(walPath())).toBe(false)
    expect(supervisor.logs.list({ limit: 200 }).some(entry =>
      entry.message.startsWith('update.database-restored phase=init schema=25'))).toBe(true)
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual([])
    await supervisor.stop()
    const second = newSupervisor({ packaged: noPackage })
    await second.start()
    expect(second.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current' })
    expect(schemaVersion()).toBe(25)
    expect(marker()).toBe('old')
  })

  it('finishes a restore that died after publishing the complete copy and before renaming it over the database', async () => {
    database(25, 'old')
    const serving = deploy('1.0.0')
    const staged = stage('2.0.0', { schema: 26 })
    const backup = backupDatabase(directory, '2.0.0', '2026-11-11T10:30:00.000Z')
    expect(backup).toBeDefined()
    migrateInWal(26, 'new')
    // The crash state inside restoreDatabase: the whole copy is published as the complete marker, the WAL is still beside it.
    copyFileSync(backup!, join(directory, 'orchestrator.sqlite.restoring'))
    rmSync(backup!, { force: true })
    leaveCrash('init', serving, null, staged, { backup })
    const noPackage = (): never => { throw new Error('this test has no packaged runtime') }
    const supervisor = newSupervisor({ packaged: noPackage })
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'journal' })
    expect(schemaVersion()).toBe(25)
    expect(marker()).toBe('old')
    expect(existsSync(walPath())).toBe(false)
    expect(existsSync(join(directory, 'orchestrator.sqlite.restoring'))).toBe(false)
    expect(supervisor.logs.list({ limit: 200 }).some(entry =>
      entry.message.startsWith('update.database-restore-finished schema=25'))).toBe(true)
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual([])
    await supervisor.stop()
    const second = newSupervisor({ packaged: noPackage })
    await second.start()
    expect(second.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current' })
    expect(schemaVersion()).toBe(25)
    expect(marker()).toBe('old')
  })

  it('discards a partial restore copy and keeps the WAL database fail-closed', async () => {
    database(25, 'old')
    const serving = deploy('1.0.0')
    const staged = stage('2.0.0', { schema: 26 })
    const backup = backupDatabase(directory, '2.0.0', '2026-11-11T10:35:00.000Z')
    expect(backup).toBeDefined()
    migrateInWal(26, 'new')
    rmSync(backup!, { force: true })
    const partial = join(directory, 'orchestrator.sqlite.restoring.tmp')
    writeFileSync(partial, 'a copy that never finished')
    leaveCrash('init', serving, null, staged, { backup })
    const noPackage = (): never => { throw new Error('this test has no packaged runtime') }
    const supervisor = newSupervisor({ packaged: noPackage })
    await expect(supervisor.start()).rejects.toThrow(/no candidate runtime could be resolved/)
    expect(existsSync(partial)).toBe(false)
    expect(existsSync(walPath())).toBe(true)
    expect(schemaVersion()).toBe(26)
    expect(marker()).toBe('new')
    expect(supervisor.logs.list({ limit: 200 }).some(entry =>
      entry.message.startsWith('update.database-restore-skipped phase=init'))).toBe(true)
    const second = newSupervisor({ packaged: noPackage })
    await expect(second.start()).rejects.toThrow(/no candidate runtime could be resolved/)
    expect(existsSync(partial)).toBe(false)
    expect(schemaVersion()).toBe(26)
  })

  it('refuses a truncated backup before removing the database or its WAL', () => {
    database(25, 'old')
    migrateInWal(26, 'new')
    const truncated = join(directory, 'truncated.sqlite')
    writeFileSync(truncated, readFileSync(join(directory, 'orchestrator.sqlite')).subarray(0, 100))
    expect(() => restoreDatabase(directory, truncated)).toThrow(/not readable/)
    expect(existsSync(join(directory, 'orchestrator.sqlite.restoring.tmp'))).toBe(false)
    expect(existsSync(walPath())).toBe(true)
    expect(schemaVersion()).toBe(26)
    expect(marker()).toBe('new')
  })

  it('records an applied history entry when a committed update lost only its history write', async () => {
    database()
    const serving = deploy('1.0.0')
    const target = deploy('2.0.0')
    leaveCommitted(serving, target)
    // The process died after journal.commit but before appending history and releasing the claim.
    mkdirSync(join(directory, 'updates'), { recursive: true })
    writeFileSync(updateProcessingPath(directory), JSON.stringify({ api: 1, id: 'commit-crash', action: 'apply',
      version: '2.0.0', at: new Date().toISOString(), by: 'operator' }))
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '2.0.0', source: 'current' })
    await until(() => !existsSync(updateProcessingPath(directory)))
    expect(readUpdateHistory(directory, 5).at(-1)).toMatchObject({ id: 'commit-crash', action: 'apply', outcome: 'applied',
      version: '2.0.0', from: '1.0.0', phase: 'commit' })
    expect(readUpdateHistory(directory, 5).at(-1)?.reason).toContain('did not record its history')
  })

  it('does not record the packaged runtime as the previous pointer after an update', async () => {
    database()
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: 'packaged', source: 'packaged' })
    stage('2.0.0')
    request('apply', '2.0.0')
    await until(() => supervisor.versionStatus()?.version === '2.0.0')
    // The packaged descriptor is relative to the package's lib/, not to <stateDir>/runtime/<version>/: it can never be a
    // rollback target, so it must not be written as previous.json.
    expect(pointer(previousPointer(runtimeDirectory(directory)))).toBeUndefined()
    expect(supervisor.updateStatus()).toMatchObject({ current: { version: '2.0.0' }, previous: null })
    expect(supervisor.updateStatus().rollback).toMatchObject({ eligible: false, version: null })
    await supervisor.stop()
    const second = newSupervisor()
    await second.start()
    expect(second.versionStatus()).toMatchObject({ version: '2.0.0', source: 'current' })
  })

  it('refuses a malformed request without touching the serving runtime', async () => {
    database()
    deploy('1.0.0')
    const supervisor = newSupervisor()
    await supervisor.start()
    mkdirSync(join(directory, 'updates'), { recursive: true })
    writeFileSync(updateRequestPath(directory), JSON.stringify({ api: 2, id: 'bad', action: 'apply', version: '2.0.0',
      at: new Date().toISOString(), by: 'operator' }))
    await until(() => readUpdateHistory(directory, 5).some(entry => entry.outcome === 'rejected'))
    expect(supervisor.versionStatus()?.version).toBe('1.0.0')
    expect(journal()?.operation).not.toBe('update')
    const refused = readdirSync(join(directory, 'updates')).filter(name => name.startsWith('request.json.rejected-'))
    expect(refused).toHaveLength(1)
  })

  it('stops safely while an update is draining', async () => {
    database()
    deploy('1.0.0', { drainDelayMs: 300 })
    const supervisor = newSupervisor()
    await supervisor.start()
    stage('2.0.0')
    request('apply', '2.0.0')
    await until(() => claimProbe())
    await supervisor.stop()
    expect(existsSync(updateProcessingPath(directory))).toBe(false)
    expect(journal()?.status).toBe('committed')
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('2.0.0')
  })

  it('backs up a database a serving WAL writer still has open', () => {
    database(25, 'old')
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const writer = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
    try {
      writer.exec('PRAGMA journal_mode = WAL')
      writer.prepare('INSERT INTO kv VALUES (?, ?)').run('unflushed', 'written')
      const backup = backupDatabase(directory, '1.0.0', '2026-11-11T10:00:00.000Z')
      expect(backup).toBeDefined()
      expect(backup!.startsWith(updateBackupsDirectory(directory))).toBe(true)
      expect(existsSync(backup!)).toBe(true)
      const copy = new DatabaseSync(backup!, { readOnly: true })
      try {
        expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
        expect((copy.prepare("SELECT value FROM kv WHERE key = 'unflushed'").get() as { value?: string }).value).toBe('written')
        expect((copy.prepare("SELECT value FROM kv WHERE key = 'marker'").get() as { value?: string }).value).toBe('old')
      } finally { copy.close() }
    } finally { writer.close() }
  })

  it('drains a real runtime with the update reason and starts its replacement on the same state directory', async () => {
    const state = join(directory, 'real-state')
    const workspace = join(directory, 'real-workspace')
    mkdirSync(state, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    const options = { directory: state, workspace, workspaces: fakeWorkspaces(state), agents: new Map<string, FakeAgent>(), keep: true }
    const first = await startRuntime(undefined, options)
    try {
      expect(((await first.api('GET', 'state')).body as { health: { runtime: { state: string } } }).health.runtime.state).toBe('ready')
      const report = await first.runtime.drain('update')
      expect(report).toMatchObject({ reason: 'update', completed: true })
      expect(report.phases.every(phase => phase.status === 'done')).toBe(true)
      // The drain released the database and the state-directory lock, so the runtime the engine would load starts on the same state.
      const second = await startRuntime(undefined, options)
      try {
        expect(second.runtime.masterId).toBe(first.runtime.masterId)
        expect(((await second.api('GET', 'state')).body as { health: { runtime: { state: string } } }).health.runtime.state).toBe('ready')
      } finally { await second.stop() }
    } finally { await first.stop() }
  })
})

/** A non-destructive probe: does a claim exist while the engine is busy? */
function claimProbe(): boolean {
  const claim = claimUpdateRequest(directory)
  if (claim.reason === 'processing') return true
  // The probe claimed a request only if one was pending; put it back so the engine still sees it.
  if (claim.request !== undefined) {
    writeFileSync(updateRequestPath(directory), JSON.stringify(claim.request))
    return false
  }
  return false
}
