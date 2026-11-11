/**
 * The deployment scripts: staging a built runtime into a state directory and the operator CLI that writes atomic update
 * requests. These run against throwaway repositories and state directories; no supervisor is started here (the engine's own
 * spec covers claiming and applying a request).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error - the operator CLIs are plain .mjs scripts without a TypeScript declaration on purpose.
import { applyCommand, main, parseArgs, rollbackCommand, stageCommand, statusCommand, watchCommand } from '../scripts/deploy-runtime.mjs'
// @ts-expect-error - the staging helper is a plain .mjs script without a TypeScript declaration on purpose.
import { inspectBuild, stageRuntime } from '../scripts/stage-runtime.mjs'
import { HOST_API } from '../src/runtime-host.ts'
import type { RuntimeDescriptor } from '../src/runtime-host.ts'
import {
  appendUpdateHistory, readUpdateRequest, updateProcessingPath, updateRequestPath, writeDescriptorFile,
} from '../src/supervisor/update-state.ts'
import { currentPointer, previousPointer, runtimeDirectory } from '../src/supervisor/versions.ts'

let work: string
let stateDir: string
let source: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'deploy-'))
  stateDir = join(work, 'state')
  source = join(work, 'repo')
  mkdirSync(join(source, 'lib'), { recursive: true })
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A minimal built repository: lib/runtime-entry.js plus the manifest the build script writes. */
function build(options: { version?: string; schema?: number; hostApi?: number; hash?: string; manifest?: boolean;
  entry?: boolean } = {}): string {
  const entry = `export const HOST_API = ${options.hostApi ?? HOST_API}\nexport const SCHEMA_VERSION = ${options.schema ?? 25}\n`
  if (options.entry !== false) writeFileSync(join(source, 'lib', 'runtime-entry.js'), entry)
  if (options.manifest !== false) {
    writeFileSync(join(source, 'lib', 'runtime-manifest.json'), JSON.stringify({ version: options.version ?? '0.5.0',
      entry: 'runtime-entry.js', hostApi: options.hostApi ?? HOST_API, schema: options.schema ?? 25,
      sha256: options.hash ?? sha256(entry) }, null, 2))
  }
  return entry
}
const manifest = (version: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(runtimeDirectory(stateDir), version, 'runtime-manifest.json'), 'utf8'))
const descriptorOf = (version: string): RuntimeDescriptor => {
  const { version: recorded, entry, hostApi, schema, sha256: hash } = manifest(version)
  return { version: recorded, entry, hostApi, schema, sha256: hash } as RuntimeDescriptor
}

/** Create (or move) the state database schema row the CLI reads without opening the Store. */
function database(schema: number): void {
  mkdirSync(stateDir, { recursive: true })
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  const connection = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'))
  try {
    connection.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)')
    connection.prepare("INSERT INTO kv (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(schema))
  } finally {
    connection.close()
  }
}
const flags = (extra: Record<string, string> = {}): Record<string, string> => ({ 'state-dir': stateDir, ...extra })

describe('stage-runtime', () => {
  it('stages the built entry and a refreshed manifest through one atomic rename and keeps the build untouched', () => {
    const entry = build({ version: '0.5.0' })
    const before = readFileSync(join(source, 'lib', 'runtime-manifest.json'), 'utf8')
    const staged = stageRuntime({ from: source, stateDir })
    expect(staged).toMatchObject({ version: '0.5.0', entry: 'runtime-entry.js', hostApi: HOST_API, schema: 25,
      sha256: sha256(entry), staged: true })
    const target = join(runtimeDirectory(stateDir), '0.5.0')
    expect(staged.path).toBe(target)
    expect(readFileSync(join(target, 'runtime-entry.js'), 'utf8')).toBe(entry)
    const recorded = manifest('0.5.0')
    expect(recorded).toMatchObject({ version: '0.5.0', entry: 'runtime-entry.js', hostApi: HOST_API, schema: 25,
      sha256: sha256(entry), node: process.version })
    expect(typeof recorded.builtAt).toBe('string')
    expect(Number.isFinite(Date.parse(recorded.builtAt as string))).toBe(true)
    // The build's own manifest is only read; the staged copy carries the operator-only fields.
    expect(readFileSync(join(source, 'lib', 'runtime-manifest.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(source, 'lib', 'runtime-entry.js'), 'utf8')).toBe(entry)
    // No temporary staging directory is left behind.
    expect(readdirSync(runtimeDirectory(stateDir)).filter(name => name.startsWith('.staging-'))).toEqual([])
    // The CLI's stage command is the same staging function and reports the deploy hint.
    expect(stageCommand({ 'state-dir': stateDir, from: source })).toMatchObject({ path: target,
      deploy: { command: expect.stringContaining('deploy-runtime.mjs') } })
  })

  it('is idempotent for the identical bundle and refuses a different bundle under the same version', () => {
    build({ version: '0.5.0' })
    stageRuntime({ from: source, stateDir })
    const again = stageRuntime({ from: source, stateDir })
    expect(again.staged).toBe(false)
    // A rebuilt bundle with the same version but another hash needs a new version (or a deliberate removal).
    build({ version: '0.5.0', schema: 24 })
    expect(() => stageRuntime({ from: source, stateDir })).toThrow(/already staged .* different bundle/)
  })

  it('rejects an incomplete build, a hash mismatch, another host API and an unsafe version', () => {
    expect(() => inspectBuild(source)).toThrow(/missing .*runtime-manifest\.json/)
    build()
    rmSync(join(source, 'lib', 'runtime-entry.js'))
    expect(() => inspectBuild(source)).toThrow(/missing .*runtime-entry\.js/)
    build({ hash: sha256('not the file') })
    expect(() => inspectBuild(source)).toThrow(/has hash .* but its manifest records/)
    build({ hostApi: 2 })
    expect(() => inspectBuild(source)).toThrow(/targets host API 2/)
    build({ version: '../escape' })
    expect(() => inspectBuild(source)).toThrow(/version is invalid/)
    build({ schema: 0 })
    expect(() => inspectBuild(source)).toThrow(/schema is invalid/)
  })
})

describe('deploy runtime CLI', () => {
  it('writes one atomic apply request for the newest staged version and prints the deploy hint', () => {
    build({ version: '0.5.0' })
    stageRuntime({ from: source, stateDir })
    build({ version: '0.6.0' })
    stageRuntime({ from: source, stateDir })
    // Make 0.5.0 older by manifest time; the rename would otherwise leave both at nearly the same instant.
    const older = join(runtimeDirectory(stateDir), '0.5.0', 'runtime-manifest.json')
    utimesSync(older, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))
    const result = applyCommand(flags())
    expect(result.request).toMatchObject({ api: 1, action: 'apply', version: '0.6.0', by: 'operator' })
    expect(result.request.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isNaN(Date.parse(result.request.at))).toBe(false)
    expect(result.path).toBe(updateRequestPath(stateDir))
    expect(result.deploy.command).toContain('scripts/deploy-runtime.mjs')
    expect(result.deploy.watch).toContain('watch')
    expect(readUpdateRequest(updateRequestPath(stateDir))).toMatchObject({ present: true,
      request: { action: 'apply', version: '0.6.0' } })
    // A second request waits for the first: the CLI refuses rather than queueing behind the claim.
    expect(() => applyCommand(flags())).toThrow(/already pending/)
  })

  it('applies an explicit version and refuses missing, unverified, running, downgraded and in-flight targets', () => {
    database(25)
    build({ version: '0.4.0' })
    stageRuntime({ from: source, stateDir })
    build({ version: '0.5.0' })
    stageRuntime({ from: source, stateDir })
    writeDescriptorFile(currentPointer(runtimeDirectory(stateDir)), descriptorOf('0.4.0'))
    expect(() => applyCommand(flags({ version: '0.9.9' }))).toThrow(/is not staged/)
    expect(() => applyCommand(flags({ version: '0.5.0' }))).not.toThrow()
    rmSync(updateRequestPath(stateDir))
    expect(() => applyCommand(flags({ version: '0.4.0' }))).toThrow(/already running/)
    // A tampered staged entry no longer matches its manifest.
    writeFileSync(join(runtimeDirectory(stateDir), '0.5.0', 'runtime-entry.js'), 'tampered')
    expect(() => applyCommand(flags({ version: '0.5.0' }))).toThrow(/has hash/)
    rmSync(join(runtimeDirectory(stateDir), '0.5.0'), { recursive: true, force: true })
    build({ version: '0.5.0' })
    stageRuntime({ from: source, stateDir })
    // A database newer than the staged runtime is a downgrade, refused before any request is written.
    database(26)
    expect(() => applyCommand(flags({ version: '0.5.0' }))).toThrow(/downgrade is never attempted/)
    expect(existsSync(updateRequestPath(stateDir))).toBe(false)
    // A claimed request blocks the CLI even though request.json is gone.
    database(25)
    writeFileSync(updateProcessingPath(stateDir), JSON.stringify({ api: 1, id: 'processing-1', action: 'apply',
      version: '0.5.0', at: new Date().toISOString(), by: 'operator' }))
    expect(() => applyCommand(flags({ version: '0.5.0' }))).toThrow(/already in progress/)
  })

  it('writes a rollback request only when a verified previous runtime is recorded', () => {
    build({ version: '0.5.0' })
    stageRuntime({ from: source, stateDir })
    const runtimeDir = runtimeDirectory(stateDir)
    writeDescriptorFile(currentPointer(runtimeDir), { version: '0.6.0', entry: 'runtime-entry.js', hostApi: HOST_API,
      sha256: 'b'.repeat(64), schema: 25 })
    expect(() => rollbackCommand(flags())).toThrow(/No previous runtime is recorded/)
    writeDescriptorFile(previousPointer(runtimeDir), descriptorOf('0.5.0'))
    const result = rollbackCommand(flags())
    expect(result.request).toMatchObject({ action: 'rollback', by: 'operator' })
    expect(result.request.version).toBeUndefined()
    expect(readUpdateRequest(updateRequestPath(stateDir))).toMatchObject({ present: true, request: { action: 'rollback' } })
  })

  it('reports the state as JSON, watches a request to its recorded outcome, and exits nonzero on refusal', async () => {
    build({ version: '0.5.0' })
    stageRuntime({ from: source, stateDir })
    const requested = applyCommand(flags({ version: '0.5.0' }))
    const status = statusCommand(flags())
    expect(status).toMatchObject({ api: 1, pending: { action: 'apply', version: '0.5.0' }, busy: false })
    expect(status.deploy.status).toContain(' status')
    // Simulate the supervisor settling the request while watch polls: the claim disappears, history gains the outcome.
    const watching = watchCommand(flags({ timeout: '4000' }))
    await new Promise(done => setTimeout(done, 120))
    rmSync(updateRequestPath(stateDir))
    appendUpdateHistory(stateDir, { id: requested.request.id, action: 'apply', outcome: 'applied', version: '0.5.0',
      from: '0.4.0', phase: 'commit', reason: null, durationMs: 30 })
    const watched = await watching
    expect(watched.resolved).toBe(true)
    expect(watched.history[0]).toMatchObject({ outcome: 'applied', version: '0.5.0' })
    // Nothing pending: watch says so immediately instead of waiting out the timeout.
    const idle = await watchCommand(flags({ timeout: '1000' }))
    expect(idle.resolved).toBe(false)
    expect(idle.reason).toBe('no update request is pending')

    const out = { text: '', write(value: string) { this.text += value } }
    const errors = { text: '', write(value: string) { this.text += value } }
    expect(await main(['--state-dir', stateDir, 'status'], out, errors)).toBe(0)
    expect(JSON.parse(out.text)).toMatchObject({ api: 1 })
    out.text = ''
    expect(await main(['--state-dir', stateDir, 'nonsense'], out, errors)).toBe(1)
    expect(errors.text).toContain('unknown command nonsense')
    expect(await main([], out, errors)).toBe(1)
  })

  it('parses flags strictly', () => {
    expect(parseArgs(['apply', '--state-dir', '/srv/x', '--version', '0.5.0'])).toMatchObject({ command: 'apply',
      flags: { 'state-dir': '/srv/x', version: '0.5.0' } })
    expect(() => parseArgs(['apply', '--state-dir'])).toThrow(/needs a value/)
    expect(() => applyCommand({})).toThrow(/--state-dir is required/)
  })

  it('runs as a real CLI with type stripping and prints parseable JSON', () => {
    build({ version: '0.5.0' })
    stageRuntime({ from: source, stateDir })
    const output = execFileSync(process.execPath, ['--experimental-transform-types', resolve('scripts/deploy-runtime.mjs'),
      '--state-dir', stateDir, 'status'], { cwd: resolve('.'), encoding: 'utf8' })
    const parsed = JSON.parse(output) as { api: number; stateDir: string }
    expect(parsed.api).toBe(1)
    expect(parsed.stateDir).toBe(stateDir)
    expect(existsSync(join(runtimeDirectory(stateDir), '0.5.0'))).toBe(true)
  })
})
