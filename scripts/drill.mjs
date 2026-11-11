/**
 * Operator drill for the runtime update pipeline (ADR-0007). It stages the freshly built bundle into a throwaway state
 * directory, then exercises the supervisor's update state machine end to end against small fake runtime bundles: apply and
 * rollback, crash recovery at every journal phase, a corrupt staged entry, a pending-request storm, a schema downgrade and a
 * failed init that must restore the database and both pointers.
 *
 *   pnpm drill
 *   node --experimental-transform-types scripts/drill.mjs [--from <repo>] [--state-dir <dir>] [--out <file>] [--keep]
 *
 * Writes `.artifacts/drills/<timestamp>.json` with one pass/fail entry per scenario and exits nonzero when one fails.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { HOST_API } from '../src/runtime-host.ts'
import { Journal } from '../src/supervisor/journal.ts'
import { Supervisor } from '../src/supervisor/supervisor.ts'
import {
  claimUpdateRequest, readUpdateHistory, readUpdateRequest, updateProcessingPath, updateRequestPath, writeUpdateRequest,
  writeDescriptorFile,
} from '../src/supervisor/update-state.ts'
import { currentPointer, previousPointer, runtimeDirectory } from '../src/supervisor/versions.ts'
import { applyCommand } from './deploy-runtime.mjs'
import { stageRuntime } from './stage-runtime.mjs'

const message = (problem) => problem instanceof Error ? problem.message : String(problem)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
/** Every phase of a normal update; a crash is simulated at each one. */
const PHASES = ['prepare', 'stage', 'backup', 'drain', 'swap', 'load', 'init', 'commit']
/** From these phases on, the engine's swap may already have written `current.json`; recovery must reconcile the pointers. */
const SWAPPED = new Set(['swap', 'load', 'init', 'commit'])

const wait = (ms) => new Promise(done => setTimeout(done, ms))
async function until(check, timeout = 15_000, label = 'the drill condition') {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await wait(25)
  }
  throw new Error(`${label} did not become true within ${timeout}ms`)
}

/** The newest history entry; `readUpdateHistory` keeps the oldest first, so the newest lives at the end. */
const latest = (dir, limit = 5) => readUpdateHistory(dir, limit).at(-1)

/** A fake runtime bundle: it records where it was started and drained, and can tamper with the database before ready. */
function sourceCode(version, options) {
  const tamper = options.tamperDatabase === true
    ? `{ const database = new DatabaseSync(host.stateDir + '/orchestrator.sqlite'); database.exec("UPDATE kv SET value = 'new' WHERE key = 'marker'"); database.close() }`
    : ''
  const ready = options.readyRejects === undefined ? 'Promise.resolve()' : `Promise.reject(new Error(${JSON.stringify(options.readyRejects)}))`
  return `import { appendFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
export const HOST_API = ${options.hostApi ?? HOST_API}
export const SCHEMA_VERSION = ${options.schema ?? 25}
export function createRuntime(host) {
  appendFileSync(new URL('./started.txt', import.meta.url), ${JSON.stringify(version)} + '\\n')
  ${tamper}
  return {
    ready: ${ready},
    configured: () => true,
    get setupProblem() { return undefined },
    drain: async (reason) => {
      appendFileSync(new URL('./drained.txt', import.meta.url), reason + '\\n')
      return { reason, startedAt: new Date().toISOString(), durationMs: 1, completed: true,
        phases: [{ phase: 'intake', status: 'done', startedAt: new Date().toISOString(), durationMs: 1 }] }
    },
    dispose: async () => {},
  }
}`
}

/** A deployed/staged fake runtime under the state directory's runtime folder. */
function fakeVersion(stateDir, version, options = {}, current = false) {
  const folder = join(runtimeDirectory(stateDir), version)
  mkdirSync(folder, { recursive: true })
  const source = sourceCode(version, options)
  writeFileSync(join(folder, 'runtime-entry.js'), source)
  const descriptor = { version, entry: 'runtime-entry.js', hostApi: options.hostApi ?? HOST_API,
    schema: options.schema ?? 25, sha256: sha256(source) }
  writeFileSync(join(folder, 'runtime-manifest.json'), JSON.stringify(descriptor, null, 2))
  if (current) writeDescriptorFile(currentPointer(runtimeDirectory(stateDir)), descriptor)
  return descriptor
}

/** A packaged fallback the supervisor may start when no pointer exists. */
function packagedFor(stateDir, version = 'packaged', options = {}) {
  const entry = join(stateDir, `${version}.js`)
  const source = sourceCode(version, options)
  writeFileSync(entry, source)
  return { descriptor: { version, entry: `${version}.js`, hostApi: HOST_API, schema: options.schema ?? 25,
    sha256: sha256(source) }, entry }
}

function database(stateDir, schema = 25, marker = 'old') {
  mkdirSync(stateDir, { recursive: true })
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const connection = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'))
  try {
    connection.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)')
    connection.prepare("INSERT INTO kv (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(schema))
    connection.prepare("INSERT INTO kv (key, value) VALUES ('marker', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(marker)
  } finally {
    connection.close()
  }
}

function marker(stateDir) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const connection = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'), { readOnly: true })
  try {
    const row = connection.prepare("SELECT value FROM kv WHERE key = 'marker'").get()
    return row?.value
  } finally {
    connection.close()
  }
}

function machine(stateDir) {
  return { stateDir, promptMaxChars: 100_000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000 }
}

async function serving(stateDir) {
  const supervisor = new Supervisor({ context: new Context(), machine: machine(stateDir),
    packaged: () => packagedFor(stateDir), updatePollMs: 20, readyTimeoutMs: 5_000, disposeMs: 1_000,
    flushLogsMs: 1_000, lockReleaseMs: 1_000 })
  await supervisor.start()
  return supervisor
}

function request(stateDir, action, version) {
  const written = { api: 1, id: randomUUID(), action, at: new Date().toISOString(), by: 'operator',
    ...(version === undefined ? {} : { version }) }
  writeUpdateRequest(stateDir, written)
  return written
}

function journalOf(stateDir) {
  return new Journal(join(runtimeDirectory(stateDir), 'journal.json'))
}
const lines = (path) => {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}

/** Run one scenario with named steps; a thrown step fails the scenario but never the whole drill. */
async function record(name, run) {
  const startedAt = Date.now()
  const steps = []
  const step = async (label, action) => {
    try {
      const value = await action()
      steps.push({ name: label, ok: true, ...(value === undefined ? {} : { detail: String(value) }) })
      return value
    } catch (problem) {
      steps.push({ name: label, ok: false, detail: message(problem) })
      throw problem
    }
  }
  try {
    await run(step)
    return { name, ok: true, durationMs: Date.now() - startedAt, steps }
  } catch (problem) {
    return { name, ok: false, durationMs: Date.now() - startedAt, steps, error: message(problem) }
  }
}

async function stageBuiltScenario(base, from) {
  return record('stage-built-runtime', async step => {
    const staged = await step('stage the built bundle', () => stageRuntime({ from, stateDir: base }))
    await step('the staged entry matches the build', () => {
      const built = JSON.parse(readFileSync(join(resolve(from), 'lib', 'runtime-manifest.json'), 'utf8'))
      if (built.sha256 !== staged.sha256) throw new Error(`staged ${staged.sha256}, built ${built.sha256}`)
      if (!existsSync(staged.path)) throw new Error(`the staged path ${staged.path} is missing`)
      if (typeof staged.builtAt !== 'string' || Number.isNaN(Date.parse(staged.builtAt))) throw new Error('builtAt was not recorded')
      if (staged.hostApi !== HOST_API) throw new Error(`host API ${staged.hostApi}`)
      return `${staged.version} ${staged.sha256}`
    })
  })
}

async function applyScenario(base) {
  const dir = join(base, 'apply')
  let supervisor
  try {
    return await record('apply-and-observe', async step => {
      await step('prepare a serving runtime and a staged update', () => {
        database(dir)
        fakeVersion(dir, '1.0.0', {}, true)
        fakeVersion(dir, '2.0.0')
      })
      supervisor = await step('start the supervisor', () => serving(dir))
      await step('request the staged version', () => { request(dir, 'apply', '2.0.0') })
      await step('the new version serves', () => until(() => supervisor.versionStatus()?.version === '2.0.0', 15_000, 'the applied version'))
      await step('the journal committed every phase', () => {
        const journal = journalOf(dir).read()
        if (journal?.status !== 'committed' || journal.operation !== 'update') throw new Error('the update journal did not commit')
        const phases = new Set(journal.steps.filter(step => step.state === 'done').map(step => step.phase))
        for (const phase of ['prepare', 'stage', 'backup', 'drain', 'swap', 'load', 'init', 'commit']) {
          if (!phases.has(phase)) throw new Error(`phase ${phase} is missing from the journal`)
        }
        return journal.steps.length
      })
      await step('both pointers and the history agree', () => {
        const status = supervisor.updateStatus()
        if (status.current?.version !== '2.0.0') throw new Error('current.json is not the new version')
        if (status.previous?.version !== '1.0.0') throw new Error('previous.json is not the old version')
        const history = latest(dir)
        if (history?.outcome !== 'applied' || history.version !== '2.0.0') throw new Error('history has no applied entry')
        if (lines(join(runtimeDirectory(dir), '1.0.0', 'drained.txt'))[0] !== 'update') throw new Error('the old runtime did not drain')
        if (!supervisor.logs.list({ limit: 100 }).some(entry => entry.message.startsWith('update.applied'))) throw new Error('the ring has no update.applied line')
      })
    })
  } finally {
    await supervisor?.stop().catch(() => {})
  }
}

async function rollbackScenario(base) {
  const dir = join(base, 'rollback')
  let supervisor
  try {
    return await record('rollback-round-trip', async step => {
      await step('prepare and apply 2.0.0', () => {
        database(dir)
        fakeVersion(dir, '1.0.0', {}, true)
        fakeVersion(dir, '2.0.0')
      })
      supervisor = await step('start the supervisor', () => serving(dir))
      request(dir, 'apply', '2.0.0')
      await step('2.0.0 serves', () => until(() => supervisor.versionStatus()?.version === '2.0.0'))
      request(dir, 'rollback')
      await step('1.0.0 serves again', () => until(() => supervisor.versionStatus()?.version === '1.0.0'))
      await step('the rollback entry is recorded', () => until(() => latest(dir)?.action === 'rollback'))
      await step('the pointers and history record the rollback', () => {
        const status = supervisor.updateStatus()
        if (status.current?.version !== '1.0.0' || status.previous?.version !== '2.0.0') throw new Error('the pointers did not swap back')
        const history = latest(dir)
        if (history?.action !== 'rollback' || history.outcome !== 'applied') throw new Error('history has no applied rollback')
        return 'current=1.0.0 previous=2.0.0'
      })
    })
  } finally {
    await supervisor?.stop().catch(() => {})
  }
}

async function crashScenario(base, phase) {
  const dir = join(base, `crash-${phase}`)
  let supervisor
  let second
  try {
    return await record(`crash-recovery-${phase}`, async step => {
      await step('leave the previous runtime deployed and the new one staged', () => {
        database(dir)
        fakeVersion(dir, '1.0.0', {}, true)
        fakeVersion(dir, '2.0.0')
      })
      await step(`leave a running journal at ${phase} and a claimed request`, () => {
        const previous = JSON.parse(readFileSync(join(runtimeDirectory(dir), '1.0.0', 'runtime-manifest.json'), 'utf8'))
        const journal = journalOf(dir)
        journal.begin('update', previous, null)
        const index = PHASES.indexOf(phase)
        for (const name of PHASES.slice(0, index)) journal.mark(name, 'done')
        if (index > 0) journal.mark(phase, 'started')
        if (SWAPPED.has(phase)) {
          // The engine writes the baseline previous descriptor and then the candidate; leave both behind as a death there would.
          const next = JSON.parse(readFileSync(join(runtimeDirectory(dir), '2.0.0', 'runtime-manifest.json'), 'utf8'))
          writeDescriptorFile(previousPointer(runtimeDirectory(dir)), previous)
          writeDescriptorFile(currentPointer(runtimeDirectory(dir)), next)
        }
        const claimed = request(dir, 'apply', '2.0.0')
        renameSync(updateRequestPath(dir), updateProcessingPath(dir))
        return claimed.id
      })
      supervisor = await step('start the supervisor', () => serving(dir))
      await step('the previous runtime serves from the journal', () => {
        const status = supervisor.versionStatus()
        if (status?.version !== '1.0.0' || status.source !== 'journal') throw new Error(`started ${status?.version} from ${status?.source}`)
      })
      await step('the claimed request is cleaned and recorded as interrupted', () => {
        return until(() => {
          if (existsSync(updateProcessingPath(dir))) return false
          const history = latest(dir)
          return history?.outcome === 'interrupted' && history.phase === phase
        }, 10_000, 'the interrupted history entry').then(() => latest(dir)?.id)
      })
      await step(SWAPPED.has(phase) ? 'both pointers are reconciled to the journal baseline' : 'the pre-swap pointers are untouched', () => {
        const status = supervisor.updateStatus()
        if (status.current?.version !== '1.0.0') throw new Error(`current.json is ${String(status.current?.version)}`)
        if (status.previous !== null) throw new Error(`previous.json is ${String(status.previous?.version)} after a baseline with none`)
        const warnings = supervisor.logs.list({ limit: 200 }).map(entry => entry.message)
        if (SWAPPED.has(phase)) {
          if (!warnings.some(entry => entry.startsWith(`update.pointers-reconciled phase=${phase}`))) {
            throw new Error('the ring has no pointer reconciliation line')
          }
        } else if (warnings.some(entry => entry.startsWith('update.pointers-reconciled'))) {
          throw new Error('the pointers were reconciled although the swap never ran')
        }
        return SWAPPED.has(phase) ? 'reconciled' : 'untouched'
      })
      await step('the failed swap is not re-run', () => {
        if (lines(join(runtimeDirectory(dir), '2.0.0', 'started.txt')).length > 0) throw new Error('the new runtime started after the crash')
      })
      await step('a second boot serves the reconciled version from the current pointer', async () => {
        await supervisor.stop()
        second = await serving(dir)
        const status = second.versionStatus()
        if (status?.version !== '1.0.0' || status.source !== 'current') throw new Error(`second boot started ${status?.version} from ${status?.source}`)
        const snapshot = second.updateStatus()
        if (snapshot.current?.version !== '1.0.0' || snapshot.previous !== null) throw new Error('the reconciled pointers did not persist')
        if (lines(join(runtimeDirectory(dir), '2.0.0', 'started.txt')).length > 0) throw new Error('the uncommitted candidate started on the second boot')
        return 'source=current version=1.0.0'
      })
    })
  } finally {
    await second?.stop().catch(() => {})
    await supervisor?.stop().catch(() => {})
  }
}

async function corruptScenario(base) {
  const dir = join(base, 'corrupt')
  let supervisor
  try {
    return await record('corrupt-staged-entry', async step => {
      await step('prepare a deployed runtime and a corrupted staged bundle', () => {
        database(dir)
        fakeVersion(dir, '1.0.0', {}, true)
        fakeVersion(dir, '2.0.0')
        writeFileSync(join(runtimeDirectory(dir), '2.0.0', 'runtime-entry.js'), 'export const HOST_API = 1\n')
      })
      supervisor = await step('start the supervisor', () => serving(dir))
      request(dir, 'apply', '2.0.0')
      await step('the request fails at the stage phase', () => until(() => journalOf(dir).read()?.status === 'failed'))
      await step('the serving runtime and pointers are untouched', () => {
        if (supervisor.versionStatus()?.version !== '1.0.0') throw new Error('the serving version changed')
        const journal = journalOf(dir).read()
        if (journal.phase !== 'stage') throw new Error(`failed at ${journal.phase}`)
        const history = latest(dir)
        if (history?.outcome !== 'failed' || history.phase !== 'stage') throw new Error('history has no failed stage entry')
        if (!supervisor.logs.list({ limit: 200 }).some(entry => entry.message.startsWith('update.failed phase=stage'))) throw new Error('the ring has no update.failed line')
      })
    })
  } finally {
    await supervisor?.stop().catch(() => {})
  }
}

async function stormScenario(base) {
  const dir = join(base, 'storm')
  return record('pending-request-storm', async step => {
    await step('prepare a named staged version', () => {
      database(dir)
      fakeVersion(dir, '1.0.0', {}, true)
      fakeVersion(dir, '2.0.0')
    })
    await step('the first request is accepted', () => {
      request(dir, 'apply', '2.0.0')
    })
    await step('a second CLI apply is refused while one request waits', () => {
      try {
        applyCommand({ 'state-dir': dir, version: '2.0.0' })
      } catch (problem) {
        if (/already pending/.test(message(problem))) return message(problem)
        throw problem
      }
      throw new Error('a second request was written although one was pending')
    })
    await step('a claimed request also refuses the CLI', () => {
      const claimed = claimUpdateRequest(dir)
      if (claimed.request === undefined) throw new Error(`the claim failed: ${claimed.reason}`)
      try {
        applyCommand({ 'state-dir': dir, version: '2.0.0' })
      } catch (problem) {
        if (/already in progress/.test(message(problem))) return message(problem)
        throw problem
      }
      throw new Error('a second request was written over a claimed request')
    })
    await step('the queue is still the single original request', () => {
      const pending = readUpdateRequest(updateRequestPath(dir))
      if (pending.present) throw new Error('a second request.json exists')
    })
  })
}

async function downgradeScenario(base) {
  const dir = join(base, 'downgrade')
  let supervisor
  try {
    return await record('schema-downgrade', async step => {
      await step('deploy schema 26 and stage a schema 25 runtime', () => {
        database(dir, 26)
        fakeVersion(dir, '1.0.0', { schema: 26 }, true)
        fakeVersion(dir, '2.0.0', { schema: 25 })
      })
      supervisor = await step('start the supervisor', () => serving(dir))
      request(dir, 'apply', '2.0.0')
      await step('the downgrade is refused at the stage phase', () => until(() => journalOf(dir).read()?.status === 'failed'))
      await step('the running runtime never drains', () => {
        if (lines(join(runtimeDirectory(dir), '1.0.0', 'drained.txt')).length > 0) throw new Error('the runtime drained before the downgrade was refused')
        const journal = journalOf(dir).read()
        if (journal.phase !== 'stage') throw new Error(`failed at ${journal.phase}`)
        const lines_ = supervisor.logs.list({ limit: 200 }).map(entry => entry.message)
        if (!lines_.some(entry => entry.includes('downgrade is never attempted'))) throw new Error('the ring does not explain the downgrade refusal')
      })
    })
  } finally {
    await supervisor?.stop().catch(() => {})
  }
}

async function failedInitScenario(base) {
  const dir = join(base, 'failed-init')
  let supervisor
  try {
    return await record('failed-init-rollback', async step => {
      await step('deploy the old runtime and stage a new one that tampers with the database before failing', () => {
        database(dir, 25, 'old')
        fakeVersion(dir, '1.0.0', {}, true)
        fakeVersion(dir, '2.0.0', { readyRejects: 'the drill runtime failed to initialize', tamperDatabase: true })
      })
      supervisor = await step('start the supervisor', () => serving(dir))
      request(dir, 'apply', '2.0.0')
      await step('the update fails and rolls back', () => until(() => journalOf(dir).read()?.status === 'failed'))
      await step('the database backup and both pointers are restored', () => {
        if (marker(dir) !== 'old') throw new Error(`the database marker is ${String(marker(dir))}`)
        const status = supervisor.updateStatus()
        if (status.current?.version !== '1.0.0') throw new Error(`current is ${status.current?.version}`)
        if (status.previous !== null) throw new Error('previous.json survived a rollback with no prior version')
      })
      await step('the previous runtime serves again and the failure history is recorded', () => {
        if (lines(join(runtimeDirectory(dir), '1.0.0', 'started.txt')).length < 2) throw new Error('the previous runtime was not reloaded')
        const history = latest(dir)
        if (history?.outcome !== 'rolledback' || history.phase !== 'rollback') throw new Error('history has no rolledback entry')
        if (!supervisor.logs.list({ limit: 200 }).some(entry => entry.message.startsWith('update.failed phase=init'))) throw new Error('the ring has no update.failed phase=init line')
        return 'marker=old current=1.0.0'
      })
    })
  } finally {
    await supervisor?.stop().catch(() => {})
  }
}

export async function runDrill(options = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const from = resolve(options.from ?? process.cwd())
  const explicitState = options.stateDir !== undefined
  const base = resolve(options.stateDir ?? join('.artifacts', 'drills', stamp, 'state'))
  const out = resolve(options.out ?? join('.artifacts', 'drills', `${stamp}.json`))
  const startedAt = new Date().toISOString()
  mkdirSync(base, { recursive: true })
  const scenarios = []
  scenarios.push(await stageBuiltScenario(base, from))
  scenarios.push(await applyScenario(base))
  scenarios.push(await rollbackScenario(base))
  for (const phase of PHASES) scenarios.push(await crashScenario(base, phase))
  scenarios.push(await corruptScenario(base))
  scenarios.push(await stormScenario(base))
  scenarios.push(await downgradeScenario(base))
  scenarios.push(await failedInitScenario(base))
  const passed = scenarios.filter(scenario => scenario.ok).length
  const report = {
    api: 1,
    at: startedAt,
    node: process.version,
    from,
    stateDir: base,
    ok: passed === scenarios.length,
    counts: { passed, failed: scenarios.length - passed, total: scenarios.length },
    scenarios,
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  if (!explicitState && options.keep !== true) rmSync(base, { recursive: true, force: true })
  return { report, path: out }
}

export function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { flags.help = true; continue }
    if (!argument.startsWith('--')) throw new Error(`unexpected argument ${argument}`)
    const name = argument.slice(2)
    if (name === 'keep') { flags.keep = true; continue }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`the --${name} option needs a value`)
    flags[name] = next
    index += 1
  }
  return flags
}

async function main(argv = process.argv.slice(2)) {
  try {
    const flags = parseArgs(argv)
    if (flags.help === true) {
      process.stdout.write('drill: [--from <repo>] [--state-dir <dir>] [--out <file>] [--keep]\n')
      return 0
    }
    const { report, path } = await runDrill({ from: flags.from, stateDir: flags['state-dir'], out: flags.out, keep: flags.keep })
    process.stdout.write(`${JSON.stringify({ ok: report.ok, path, counts: report.counts }, null, 2)}\n`)
    return report.ok ? 0 : 1
  } catch (problem) {
    process.stderr.write(`drill: ${message(problem)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main()
}
