/**
 * Supervisor and versioned-runtime tests: descriptor resolution, the loader's refusals, the crash journal's recovery, the
 * frozen host contract, and a start/drain/swap exercise over fake runtime bundles. Fake bundles are tiny ESM files written
 * under the test's state directory, so these tests never construct the full application.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import schemastery from '@deepseek-ai/schemastery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogFileSink } from '../src/app/log-files.ts'
import { Logs } from '../src/app/logs.ts'
import { buildRuntimeHost } from '../src/supervisor/host.ts'
import { Journal } from '../src/supervisor/journal.ts'
import { loadRuntime, packagedRuntime } from '../src/supervisor/loader.ts'
import { HOST_API, PACKAGED_RUNTIME_MANIFEST, type RuntimeDescriptor, type RuntimeHost } from '../src/runtime-host.ts'
import { Supervisor, type SupervisorOptions } from '../src/supervisor/supervisor.ts'
import { currentPointer, previousPointer, resolveVersions, runtimeDirectory } from '../src/supervisor/versions.ts'
import { VERSION } from '../src/version.ts'
import { testMachine } from './fixtures/deployment.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'supervisor-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A fake runtime bundle that records the version it started and the reason it drained beside itself. */
function runtimeSource(version: string, options: {
  throws?: boolean; omitCreate?: boolean; hostApi?: number; schema?: number; readyHangs?: boolean; incompleteDrain?: boolean
  readyRejects?: string; disposeHangs?: boolean; log?: string
} = {}): string {
  if (options.throws) return `throw new Error('the ${version} bundle cannot load')`
  const ready = options.readyHangs
    ? 'new Promise(() => {})'
    : options.readyRejects === undefined ? 'Promise.resolve()' : `Promise.reject(new Error(${JSON.stringify(options.readyRejects)}))`
  const log = options.log === undefined ? '' : `  host.logs.record('info', 'test', ${JSON.stringify(options.log)})\n`
  const dispose = options.disposeHangs
    ? `    dispose: () => { writeFileSync(new URL('./disposed.txt', import.meta.url), 'yes'); return new Promise(() => {}) },`
    : `    dispose: async () => { writeFileSync(new URL('./disposed.txt', import.meta.url), 'yes') },`
  const create = options.omitCreate ? '' : `
export function createRuntime(host) {
${log}  writeFileSync(new URL('./started.txt', import.meta.url), ${JSON.stringify(version)})
  return {
    ready: ${ready},
    configured: () => true,
    drain: async (reason) => {
      writeFileSync(new URL('./drained.txt', import.meta.url), reason)
      return { reason, startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, completed: ${options.incompleteDrain ? 'false' : 'true'},
        phases: [{ phase: 'intake', status: ${options.incompleteDrain ? "'failed'" : "'done'"}, startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1 }] }
    },
${dispose}
  }
}`
  return `import { writeFileSync } from 'node:fs'
export const HOST_API = ${options.hostApi ?? HOST_API}
export const SCHEMA_VERSION = ${options.schema ?? 25}
${create}`
}

/** Write a deployed version and point current.json at it; returns the descriptor. */
function deploy(version: string, options: Parameters<typeof runtimeSource>[1] = {}): RuntimeDescriptor {
  const stateDir = directory
  const root = runtimeDirectory(stateDir)
  const folder = join(root, version)
  mkdirSync(folder, { recursive: true })
  const source = runtimeSource(version, options)
  writeFileSync(join(folder, 'runtime-entry.js'), source)
  const descriptor: RuntimeDescriptor = { version, entry: 'runtime-entry.js', hostApi: options.hostApi ?? HOST_API, sha256: hash(source), schema: options.schema ?? 25 }
  writeFileSync(currentPointer(root), JSON.stringify(descriptor))
  return descriptor
}

/** A packaged runtime placed outside the state directory, as the installed package's lib entry is. */
function packaged(version = 'packaged', options: Parameters<typeof runtimeSource>[1] = {}): { descriptor: RuntimeDescriptor; entry: string } {
  const entry = join(directory, `${version}.js`)
  const source = runtimeSource(version, options)
  writeFileSync(entry, source)
  return { descriptor: { version, entry: `${version}.js`, hostApi: options.hostApi ?? HOST_API, sha256: hash(source), schema: options.schema ?? 25 }, entry }
}

/** A Supervisor over a fresh Cordis context; fake bundles never touch the DSH services, so the context may be empty. */
function newSupervisor(extra: Partial<SupervisorOptions> = {}): Supervisor {
  return new Supervisor({ context: new Context(), machine: testMachine({ stateDir: directory }), packaged: () => packaged(), ...extra })
}

/** The version whose bundle was imported, read from the marker it wrote. */
const started = (version: string): string => readFileSync(join(runtimeDirectory(directory), version, 'started.txt'), 'utf8')

describe('version resolution', () => {
  it('prefers a verified current.json and keeps the packaged runtime as the fallback', () => {
    const descriptor = deploy('9.9.9')
    const packagedRuntime = packaged()
    const resolution = resolveVersions(runtimeDirectory(directory), packagedRuntime)
    expect(resolution.candidates.map(candidate => candidate.source)).toEqual(['current', 'packaged'])
    expect(resolution.candidates[0]!.descriptor).toEqual(descriptor)
    expect(resolution.rejected).toEqual([])
  })

  it('reports a missing, invalid, wrong-hash, and wrong-host-API current.json and still offers the packaged runtime', () => {
    const root = runtimeDirectory(directory)
    mkdirSync(root, { recursive: true })
    writeFileSync(currentPointer(root), '{not json')
    let resolution = resolveVersions(root, packaged())
    expect(resolution.candidates.map(candidate => candidate.source)).toEqual(['packaged'])
    expect(resolution.rejected[0]!.reason).toContain('not valid JSON')

    writeFileSync(currentPointer(root), JSON.stringify({ version: '1.0.0', entry: 'runtime-entry.js', hostApi: HOST_API, sha256: '0'.repeat(64), schema: 25 }))
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    writeFileSync(join(root, '1.0.0', 'runtime-entry.js'), 'export const x = 1')
    resolution = resolveVersions(root, packaged())
    expect(resolution.rejected[0]!.reason).toContain('has hash')

    writeFileSync(currentPointer(root), JSON.stringify({ version: '1.0.0', entry: 'runtime-entry.js', hostApi: 99, sha256: hash('export const x = 1'), schema: 25 }))
    resolution = resolveVersions(root, packaged())
    expect(resolution.rejected[0]!.reason).toContain('host API 99')
    expect(resolution.candidates.map(candidate => candidate.source)).toEqual(['packaged'])
  })

  it('falls back to the previous verified version, and prefers an interrupted journal record over current.json', () => {
    const root = runtimeDirectory(directory)
    mkdirSync(root, { recursive: true })
    for (const version of ['previous', 'current']) {
      const folder = join(root, version)
      mkdirSync(folder, { recursive: true })
      const source = runtimeSource(version)
      writeFileSync(join(folder, 'runtime-entry.js'), source)
      writeFileSync(version === 'current' ? currentPointer(root) : previousPointer(root), JSON.stringify({ version, entry: 'runtime-entry.js', hostApi: HOST_API, sha256: hash(source), schema: 25 }))
    }
    writeFileSync(currentPointer(root), '{not json')
    let resolution = resolveVersions(root, packaged())
    expect(resolution.candidates.map(candidate => candidate.source)).toEqual(['previous', 'packaged'])

    const interrupted = JSON.parse(readFileSync(previousPointer(root), 'utf8')) as RuntimeDescriptor
    resolution = resolveVersions(root, packaged(), undefined, interrupted)
    expect(resolution.candidates.map(candidate => candidate.source)).toEqual(['journal', 'previous', 'packaged'])
  })

  it('refuses a version whose schema is older than the database, before any bundle code runs', () => {
    const descriptor = deploy('old', { schema: 20 })
    const resolution = resolveVersions(runtimeDirectory(directory), packaged(), 25)
    expect(resolution.rejected).toContainEqual(expect.objectContaining({ source: 'current', reason: expect.stringContaining('a downgrade is never attempted') }))
    expect(resolution.candidates.map(candidate => candidate.source)).toEqual(['packaged'])
    expect(descriptor.schema).toBe(20)
  })

  it('refuses an entry that escapes the runtime directory', () => {
    const root = runtimeDirectory(directory)
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    writeFileSync(join(root, '1.0.0', 'runtime-entry.js'), 'export const x = 1')
    writeFileSync(currentPointer(root), JSON.stringify({ version: '1.0.0', entry: '../escape.js', hostApi: HOST_API, sha256: '0'.repeat(64), schema: 25 }))
    const resolution = resolveVersions(root, packaged())
    expect(resolution.rejected[0]!.reason).toContain('resolves outside')
  })
})

describe('packaged runtime', () => {
  function packageRoot(): string {
    const root = join(directory, 'package')
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-superagent-further' }))
    return root
  }

  it('requires the built manifest and entry and names pnpm build when they are missing', () => {
    const root = join(directory, 'package')
    mkdirSync(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-superagent-further' }))
    expect(() => packagedRuntime(root)).toThrow(/pnpm build/)
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'runtime-entry.js'), 'export const HOST_API = 1')
    expect(() => packagedRuntime(root)).toThrow(/runtime-manifest\.json/)
  })

  it('verifies a packaged manifest and refuses an invalid one instead of falling back to source', () => {
    const root = packageRoot()
    const source = runtimeSource('3.0.0')
    writeFileSync(join(root, 'lib', 'runtime-entry.js'), source)
    const descriptor: RuntimeDescriptor = { version: '3.0.0', entry: 'runtime-entry.js', hostApi: HOST_API, sha256: hash(source), schema: 25 }
    writeFileSync(join(root, 'lib', PACKAGED_RUNTIME_MANIFEST), JSON.stringify(descriptor))
    expect(packagedRuntime(root)).toEqual({ descriptor, entry: join(root, 'lib', 'runtime-entry.js') })

    writeFileSync(join(root, 'lib', PACKAGED_RUNTIME_MANIFEST), '{not json')
    expect(() => packagedRuntime(root)).toThrow(/pnpm build/i)
  })
})

describe('package version', () => {
  it('pins the version module to package.json', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
    expect(VERSION).toBe(manifest.version)
  })
})

describe('loader refusals', () => {
  const host = {} as RuntimeHost
  it('refuses a bundle whose import throws', async () => {
    const entry = join(directory, 'throws.js')
    writeFileSync(entry, runtimeSource('7', { throws: true }))
    await expect(loadRuntime({ host, entry })).rejects.toThrow('could not be imported')
  })
  it('refuses a bundle without createRuntime and one built for another host API', async () => {
    const noCreate = join(directory, 'no-create.js')
    writeFileSync(noCreate, runtimeSource('7', { omitCreate: true }))
    await expect(loadRuntime({ host, entry: noCreate })).rejects.toThrow('does not export createRuntime')
    const wrongApi = join(directory, 'wrong-api.js')
    writeFileSync(wrongApi, runtimeSource('7', { hostApi: 99 }))
    await expect(loadRuntime({ host, entry: wrongApi })).rejects.toThrow('host API 99')
  })
  it('refuses a downgrade and a handle without drain/dispose', async () => {
    const old = join(directory, 'old.js')
    writeFileSync(old, runtimeSource('7', { schema: 20 }))
    await expect(loadRuntime({ host, entry: old, databaseSchema: 25 })).rejects.toThrow('Unsupported orchestrator database version 25')
    const badHandle = join(directory, 'bad-handle.js')
    writeFileSync(badHandle, `export const HOST_API = 1\nexport const SCHEMA_VERSION = 25\nexport const createRuntime = () => ({ ready: Promise.resolve() })\n`)
    await expect(loadRuntime({ host, entry: badHandle })).rejects.toThrow('without ready, drain, and dispose')
  })
  it('returns the handle and the schema of a valid bundle', async () => {
    const entry = join(directory, 'valid.js')
    writeFileSync(entry, runtimeSource('7'))
    const loaded = await loadRuntime({ host, entry, databaseSchema: 25 })
    expect(loaded.schema).toBe(25)
    await expect(loaded.handle.ready).resolves.toBeUndefined()
    await expect(loaded.handle.drain('test')).resolves.toMatchObject({ reason: 'test', completed: true })
  })
})

describe('journal', () => {
  it('records phases atomically, survives a committed read, and keeps the recorded versions across a drain commit', () => {
    const journal = new Journal(join(runtimeDirectory(directory), 'journal.json'), () => '2026-01-01T00:00:00.000Z')
    const descriptor: RuntimeDescriptor = { version: '1.0.0', entry: 'runtime-entry.js', hostApi: HOST_API, sha256: 'a'.repeat(64), schema: 25 }
    journal.begin('startup', descriptor)
    expect(journal.interrupted()).toMatchObject({ status: 'running', operation: 'startup', phase: 'prepare' })
    journal.mark('load', 'done')
    journal.mark('init', 'done')
    journal.commit({ current: descriptor })
    const committed = journal.read()!
    expect(committed).toMatchObject({ status: 'committed', phase: 'commit', current: descriptor })
    expect(committed.steps.map(step => step.phase)).toEqual(['prepare', 'load', 'init', 'commit'])
    expect(journal.interrupted()).toBeUndefined()

    journal.begin('drain', descriptor)
    journal.mark('drain', 'done')
    journal.commit({})
    expect(journal.read()).toMatchObject({ status: 'committed', operation: 'drain', current: descriptor })
  })

  it('keeps a failed start recoverable and names the phase that failed', () => {
    const journal = new Journal(join(runtimeDirectory(directory), 'journal.json'))
    journal.begin('startup')
    journal.fail('load', 'the bundle threw')
    expect(journal.read()).toMatchObject({ status: 'failed', phase: 'load' })
    expect(journal.read()!.steps.at(-1)).toMatchObject({ phase: 'load', state: 'failed' })
    expect(journal.interrupted()).toBeUndefined()
  })
})

describe('frozen runtime host', () => {
  it('builds API v1 with the injected DSH values and the live context as the service channel', async () => {
    const ctx = new Context()
    const agents = { marker: 'agents' }
    ctx.reflect.provide('agents', agents)
    const built = buildRuntimeHost({
      context: ctx, machine: testMachine({ stateDir: directory }), restart: () => {}, exit: () => {}, version: '1.2.3',
      logger: ctx.logger, lifetime: new AbortController().signal, logs: new Logs(),
      flushLogs: async () => {}, releaseStateLock: async () => {},
    })
    expect(built.host.hostApi).toBe(HOST_API)
    expect(built.host.version).toBe('1.2.3')
    expect(built.host.context).toBe(ctx)
    expect(built.host.context.get('agents')).toBe(agents)
    expect(built.host.values.Service).toBeTypeOf('function')
    expect(built.host.values.MessageId('dsh-superagent:x')).toBe('dsh-superagent:x')
    expect(built.host.values.ReasoningEffortId('high')).toBe('high')
    expect(built.host.values.scopeParentOf).toBe(scopeParentOf)
    expect(built.host.values.schemastery).toBe(schemastery)
    const original = { id: MessageId('m'), role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }], source: { kind: 'user' as const } }
    const frozen = built.host.values.freezeMessage(original)
    expect(frozen).not.toBe(original)
    expect(frozen).toEqual(original)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(built.logs).toBeInstanceOf(Logs)
    await built.logSink.close()
  })
})

describe('supervisor', () => {
  it('starts a verified deployed runtime and records it as current', async () => {
    deploy('1.0.0')
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(started('1.0.0')).toBe('1.0.0')
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current', hostApi: HOST_API, schema: 25 })
    expect(supervisor.configured()).toBe(true)
    const journal = new Journal(join(runtimeDirectory(directory), 'journal.json'))
    expect(journal.read()).toMatchObject({ status: 'committed', current: expect.objectContaining({ version: '1.0.0' }) })
    await supervisor.stop()
  })

  it.each([
    ['missing', () => {}],
    ['invalid JSON', () => { const root = runtimeDirectory(directory); mkdirSync(root, { recursive: true }); writeFileSync(currentPointer(root), '{not json') }],
    ['a hash mismatch', () => {
      const root = runtimeDirectory(directory); mkdirSync(join(root, '1.0.0'), { recursive: true })
      writeFileSync(join(root, '1.0.0', 'runtime-entry.js'), 'export const x = 1')
      writeFileSync(currentPointer(root), JSON.stringify({ version: '1.0.0', entry: 'runtime-entry.js', hostApi: HOST_API, sha256: '0'.repeat(64), schema: 25 }))
    }],
    ['a host API mismatch', () => {
      const root = runtimeDirectory(directory); mkdirSync(join(root, '1.0.0'), { recursive: true })
      const source = 'export const x = 1'
      writeFileSync(join(root, '1.0.0', 'runtime-entry.js'), source)
      writeFileSync(currentPointer(root), JSON.stringify({ version: '1.0.0', entry: 'runtime-entry.js', hostApi: 99, sha256: hash(source), schema: 25 }))
    }],
  ])('falls back to the packaged runtime for %s', async (_case, prepare) => {
    prepare()
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: 'packaged', source: 'packaged' })
    await supervisor.stop()
  })

  it('falls back when a verified bundle throws while loading, and starts the next version on a later boot', async () => {
    deploy('broken', { throws: true })
    const first = newSupervisor()
    await first.start()
    expect(first.versionStatus()).toMatchObject({ version: 'packaged', source: 'packaged' })
    await first.stop()

    // The swap exercise: M36 writes a new current.json; the next supervisor starts the new bundle, not the broken one.
    deploy('2.0.0')
    const next = newSupervisor()
    await next.start()
    expect(next.versionStatus()).toMatchObject({ version: '2.0.0', source: 'current' })
    expect(started('2.0.0')).toBe('2.0.0')
    await next.stop()
  })

  it('bounds readiness, disposes a runtime whose ready never settles, and falls back to the packaged runtime', async () => {
    deploy('slow', { readyHangs: true })
    const supervisor = newSupervisor({ readyTimeoutMs: 25 })
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: 'packaged', source: 'packaged' })
    expect(started('slow')).toBe('slow')
    expect(readFileSync(join(runtimeDirectory(directory), 'slow', 'disposed.txt'), 'utf8')).toBe('yes')
    await supervisor.stop()
  })

  it('does not let a failed runtime whose dispose hangs block the packaged fallback', async () => {
    deploy('stuck', { readyHangs: true, disposeHangs: true })
    const supervisor = newSupervisor({ readyTimeoutMs: 25, disposeMs: 25 })
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: 'packaged', source: 'packaged' })
    // The hanging dispose was attempted and abandoned: the marker proves it ran, and the packaged runtime still started.
    expect(readFileSync(join(runtimeDirectory(directory), 'stuck', 'disposed.txt'), 'utf8')).toBe('yes')
    expect(readFileSync(join(directory, 'started.txt'), 'utf8')).toBe('packaged')
    await supervisor.stop()
  })

  it('bounds a stuck durable log close, releases the lock, and still commits the drain', async () => {
    deploy('1.0.0')
    const sink = new LogFileSink({ stateDir: directory })
    const close = vi.spyOn(sink, 'close').mockReturnValue(new Promise(() => {}))
    const supervisor = newSupervisor({ logSink: sink, flushLogsMs: 25 })
    await supervisor.start()
    await supervisor.stop()
    expect(close).toHaveBeenCalled()
    expect(new Journal(join(runtimeDirectory(directory), 'journal.json')).read()).toMatchObject({ status: 'committed', operation: 'drain' })
    // The lock is released even though the sink close never resolved, so another host can start on the state directory.
    const next = newSupervisor()
    await next.start()
    expect(next.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current' })
    await next.stop()
  })

  it('bounds a stuck state-directory lock release, commits the drain, and does not hang the shutdown', async () => {
    deploy('1.0.0')
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const supervisor = new Supervisor({
      context: ctx, machine: testMachine({ stateDir: directory }), packaged: () => packaged(),
      lock: () => () => new Promise(() => {}), lockReleaseMs: 25,
    })
    await supervisor.start()
    const report = await supervisor.drain('update')
    expect(report.completed).toBe(true)
    expect(readFileSync(join(runtimeDirectory(directory), '1.0.0', 'drained.txt'), 'utf8')).toBe('update')
    expect(new Journal(join(runtimeDirectory(directory), 'journal.json')).read()).toMatchObject({ status: 'committed', operation: 'drain' })
    expect(warn.mock.calls.flat().join(' ')).toContain('could not release the state-directory lock')
    await supervisor.stop()
  })

  it('keeps one process-wide log ring across a failed candidate and the packaged fallback', async () => {
    deploy('flaky', { readyRejects: 'the flaky runtime is not ready', log: 'from the failed candidate' })
    const supervisor = newSupervisor({ packaged: () => packaged('packaged', { log: 'from the packaged runtime' }) })
    const ring = supervisor.logs
    await supervisor.start()
    expect(supervisor.logs).toBe(ring)
    const messages = ring.list({ limit: 50 }).map(entry => entry.message)
    expect(messages).toContain('from the failed candidate')
    expect(messages).toContain('from the packaged runtime')
    expect(readFileSync(join(directory, 'started.txt'), 'utf8')).toBe('packaged')
    await supervisor.stop()
  })

  it('keeps starting a deployed version when the packaged runtime cannot be discovered', async () => {
    deploy('1.0.0')
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const supervisor = new Supervisor({
      context: ctx, machine: testMachine({ stateDir: directory }),
      packaged: () => { throw new Error('lib/runtime-manifest.json does not exist; run pnpm build') },
    })
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current' })
    expect(warn.mock.calls.flat().join(' ')).toContain('cannot discover its packaged runtime')
    await supervisor.stop()
  })

  it('names pnpm build when nothing can start, then drains an empty supervisor as incomplete but releases the lock', async () => {
    const ctx = new Context()
    const supervisor = new Supervisor({
      context: ctx, machine: testMachine({ stateDir: directory }),
      packaged: () => { throw new Error('lib/runtime-manifest.json does not exist') },
    })
    await expect(supervisor.start()).rejects.toThrow(/run pnpm build/)
    const report = await supervisor.drain('shutdown')
    expect(report.completed).toBe(false)
    expect(report.phases).toEqual([
      expect.objectContaining({ phase: 'intake', status: 'skipped', detail: expect.stringContaining('no runtime was running') }),
    ])
    // The failed start released the lock and closed its sink, so a normal supervisor can now start here.
    const next = newSupervisor()
    await next.start()
    expect(next.versionStatus()).toMatchObject({ version: 'packaged', source: 'packaged' })
    await next.stop()
  })

  it('journals a drain the runtime did not complete, releases the lock, and still reports the phases', async () => {
    deploy('1.0.0', { incompleteDrain: true })
    const supervisor = newSupervisor()
    await supervisor.start()
    const report = await supervisor.drain('update')
    expect(report.completed).toBe(false)
    expect(report.phases).toEqual([expect.objectContaining({ phase: 'intake', status: 'failed' })])
    expect(new Journal(join(runtimeDirectory(directory), 'journal.json')).read()).toMatchObject({ status: 'failed', operation: 'drain' })
    await supervisor.stop()
    const next = newSupervisor()
    await next.start()
    expect(next.versionStatus()).toMatchObject({ version: '1.0.0', source: 'current' })
    await next.stop()
  })

  it('recovers an interrupted journal record, records the recovery, and never starts an older schema', async () => {
    const recovered = deploy('1.0.0')
    deploy('2.0.0')
    const journal = new Journal(join(runtimeDirectory(directory), 'journal.json'))
    journal.begin('startup', recovered)
    journal.mark('swap', 'started')
    const supervisor = newSupervisor()
    await supervisor.start()
    expect(supervisor.versionStatus()).toMatchObject({ version: '1.0.0', source: 'journal', recovery: expect.stringContaining('interrupted') })
    expect(started('1.0.0')).toBe('1.0.0')
    const state = new Journal(join(runtimeDirectory(directory), 'journal.json')).read()!
    expect(state.recovery).toMatchObject({ to: '1.0.0' })
    await supervisor.stop()
  })

  it('drains once, reports the same phases on a second request, and records the drain journal', async () => {
    deploy('1.0.0')
    const supervisor = newSupervisor()
    await supervisor.start()
    const first = await supervisor.drain('update')
    expect(first.phases.map(phase => phase.phase)).toEqual(['intake'])
    expect(first.completed).toBe(true)
    const second = await supervisor.drain('again')
    expect(second).toBe(first)
    expect(readFileSync(join(runtimeDirectory(directory), '1.0.0', 'drained.txt'), 'utf8')).toBe('update')
    expect(new Journal(join(runtimeDirectory(directory), 'journal.json')).read()).toMatchObject({ status: 'committed', operation: 'drain' })
    await supervisor.stop()
  })

  it('refuses a second supervisor on the same state directory before it loads anything', async () => {
    deploy('1.0.0')
    const first = newSupervisor()
    await first.start()
    const second = new Supervisor({ context: new Context(), machine: testMachine({ stateDir: directory }), packaged: () => packaged('other') })
    await expect(second.start()).rejects.toThrow(/already hosted for/)
    expect(second.versionStatus()).toBeUndefined()
    await first.stop()
  })
})
