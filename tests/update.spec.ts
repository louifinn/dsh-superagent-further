/**
 * Update engine tests over fake runtime bundles: the journaled apply and rollback, a failed init restoring the database and
 * both pointers, the schema-downgrade refusal, a claimed request, crash recovery, a malformed request and a stop during an
 * update. The fake bundles are tiny ESM files under the test's state directory, as in `supervisor.spec.ts`.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Journal } from '../src/supervisor/journal.ts'
import { Supervisor, type SupervisorOptions } from '../src/supervisor/supervisor.ts'
import { claimUpdateRequest, readUpdateHistory, updateProcessingPath, updateRequestPath } from '../src/supervisor/update-state.ts'
import { currentPointer, previousPointer, runtimeDirectory } from '../src/supervisor/versions.ts'
import { HOST_API, type RuntimeDescriptor } from '../src/runtime-host.ts'
import { testMachine } from './fixtures/deployment.ts'
import { appendUpdateHistory } from '../src/supervisor/update-state.ts'

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

  it('recovers a crash that left a running update journal and a claimed request', async () => {
    database()
    const first = deploy('1.0.0')
    const staged = stage('2.0.0')
    const crashJournal = new Journal(join(runtimeDirectory(directory), 'journal.json'))
    crashJournal.begin('update', first, null)
    crashJournal.mark('stage', 'done', 'version 2.0.0 verified')
    crashJournal.mark('drain', 'done', 'drained')
    crashJournal.mark('swap', 'started', 'writing the version pointers')
    writeFileSync(currentPointer(runtimeDirectory(directory)), JSON.stringify(staged))
    mkdirSync(join(directory, 'updates'), { recursive: true })
    const crashRequest = { api: 1 as const, id: 'crash-request', action: 'apply' as const, version: '2.0.0',
      at: new Date().toISOString(), by: 'operator' as const }
    writeFileSync(updateProcessingPath(directory), JSON.stringify(crashRequest))
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'journal' })
    await until(() => !existsSync(updateProcessingPath(directory)))
    const last = readUpdateHistory(directory, 5).at(-1)!
    expect(last).toMatchObject({ id: 'crash-request', outcome: 'interrupted', phase: 'swap' })
    expect(lines(join(runtimeDirectory(directory), '2.0.0', 'started.txt'))).toEqual([])
    expect(pointer(currentPointer(runtimeDirectory(directory)))?.version).toBe('2.0.0')
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
void appendUpdateHistory
