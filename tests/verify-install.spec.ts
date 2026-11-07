/**
 * Tests for scripts/verify-install.
 *
 * The script is dependency-free Node ESM that reads an installation and never changes it, so each test builds a temporary
 * `DSH_HOME` with one profile and a state database, serves the management API from a small `node:http` server, then runs
 * the script with `--json` and inspects the check list. The `dsh` check is pointed at `process.execPath` so it passes
 * without DeepSeek Harness being installed.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../src/app/migration.ts'

interface Check { ok: boolean; name: string; detail: string }

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-install')
let root: string | undefined
let servers: Server[] = []

/** A fresh temporary home whose path contains spaces, so quoting is exercised on both platforms. */
function home(): string {
  root = mkdtempSync(join(tmpdir(), 'dsh superagent verify install '))
  return root
}

/** Writes the profile manifest and patch entry the script reads, pointing at `stateDir`. */
function profile(dshHome: string, stateDir: string): void {
  const directory = join(dshHome, 'profiles', 'install-test')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-superagent': 'link:/repo' },
    dsh: { profile: { bundles: ['dsh-superagent'] } },
  }))
  writeFileSync(join(directory, 'cordis.patch.yml'), `- id: dsh-superagent\n  config:\n    stateDir: ${stateDir}\n`)
}

/** Creates the state database with the schema record the store writes on first open. */
function database(stateDir: string, version: number | undefined): void {
  mkdirSync(stateDir, { recursive: true })
  const db = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'))
  try {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    if (version !== undefined) db.prepare('INSERT INTO kv VALUES (?, ?)').run('schema', JSON.stringify(version))
  } finally {
    db.close()
  }
}

/** Serves the two answers the script asks for, so a check run costs no network timeout. */
async function serve(stateDir: string): Promise<string> {
  const server = createServer((incoming, response) => {
    if (incoming.url?.startsWith('/orchestrator/api/state')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ health: { runtime: { state: 'ready', detail: '' } }, hidden: {},
        setup: { machine: { stateDir }, problem: null }, paused: false }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html></html>')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/**
 * Runs the script against `dshHome` and returns its exit code and printed checks.
 *
 * The script is spawned rather than run synchronously so the fake management server in this process can answer its
 * requests; a synchronous child would block the event loop and every request would end in the script's timeout.
 */
function verify(dshHome: string, url: string): Promise<{ code: number; checks: Check[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--profile', 'install-test', '--url', url, '--json'], {
      cwd: root, env: { ...process.env, DSH_HOME: dshHome, DSH_SUPERAGENT_DSH: process.execPath }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      try {
        resolve({ code: code ?? 1, checks: (JSON.parse(stdout) as { checks: Check[] }).checks })
      } catch (error) {
        reject(new Error(`verify-install printed no JSON (exit ${code}): ${stderr || stdout}`, { cause: error }))
      }
    })
  })
}

const schema = (checks: Check[]): Check => {
  const check = checks.find(item => item.name === 'schema')
  expect(check).toBeDefined()
  return check!
}

afterEach(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()))
  servers = []
  if (root !== undefined) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  root = undefined
})

it('reports the current schema version when the database matches this checkout', async () => {
  const dshHome = home()
  const stateDir = join(dshHome, 'state')
  profile(dshHome, stateDir)
  database(stateDir, SCHEMA_VERSION)
  const { code, checks } = await verify(dshHome, await serve(stateDir))
  expect(schema(checks)).toMatchObject({ ok: true, detail: `schema ${SCHEMA_VERSION} (current)` })
  expect(code).toBe(0)
}, 30_000)

it('reports a database from an older schema as one that migrates on start', async () => {
  const dshHome = home()
  const stateDir = join(dshHome, 'state')
  profile(dshHome, stateDir)
  database(stateDir, SCHEMA_VERSION - 2)
  expect(schema((await verify(dshHome, await serve(stateDir))).checks)).toMatchObject({ ok: true, detail: `schema ${SCHEMA_VERSION - 2} migrates to ${SCHEMA_VERSION} on start` })
}, 30_000)

it('fails on a database written by a newer checkout, naming the backup', async () => {
  const dshHome = home()
  const stateDir = join(dshHome, 'state')
  profile(dshHome, stateDir)
  database(stateDir, SCHEMA_VERSION + 1)
  const { code, checks } = await verify(dshHome, await serve(stateDir))
  const check = schema(checks)
  expect(check.ok).toBe(false)
  expect(check.detail).toMatch(new RegExp(`schema ${SCHEMA_VERSION + 1} is newer than this checkout \\(${SCHEMA_VERSION}\\)`))
  expect(check.detail).toMatch(/restore the backup/)
  expect(code).toBe(1)
}, 30_000)

it('says no database exists yet instead of failing a fresh installation', async () => {
  const dshHome = home()
  const stateDir = join(dshHome, 'state')
  profile(dshHome, stateDir)
  expect(schema((await verify(dshHome, await serve(stateDir))).checks)).toMatchObject({ ok: true, detail: expect.stringContaining('created on first start') })
}, 30_000)

