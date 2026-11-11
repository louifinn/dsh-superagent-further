/**
 * Operator CLI for the supervisor-owned runtime update pipeline (ADR-0007). It stages a built runtime and asks the running
 * supervisor to apply or roll back a version by writing an atomic request file; it never loads code itself.
 *
 *   node --experimental-transform-types scripts/deploy-runtime.mjs --state-dir <dir> stage --from <repo>
 *   node --experimental-transform-types scripts/deploy-runtime.mjs --state-dir <dir> apply [--version <version>]
 *   node --experimental-transform-types scripts/deploy-runtime.mjs --state-dir <dir> status
 *   node --experimental-transform-types scripts/deploy-runtime.mjs --state-dir <dir> watch [--timeout <ms>]
 *   node --experimental-transform-types scripts/deploy-runtime.mjs --state-dir <dir> rollback
 *
 * Every command prints one JSON value. Refusals exit 1 with `deploy-runtime: <reason>` on stderr: a request already
 * pending, an update already in progress, a version that is missing or fails verification, or a schema downgrade.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { databaseSchema, readDescriptorFile, runtimeDirectory, verifyDescriptor } from '../src/supervisor/versions.ts'
import {
  deployCommands, updateProcessingPath, updateRequestPath, updateSnapshot, writeUpdateRequest,
} from '../src/supervisor/update-state.ts'
import { stageRuntime } from './stage-runtime.mjs'

const message = (problem) => problem instanceof Error ? problem.message : String(problem)

export function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      flags.help = true
      continue
    }
    if (argument.startsWith('--')) {
      const name = argument.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`the --${name} option needs a value`)
      flags[name] = next
      index += 1
      continue
    }
    positionals.push(argument)
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags }
}

function stateDirectory(flags) {
  if (typeof flags['state-dir'] !== 'string' || flags['state-dir'].trim() === '') throw new Error('--state-dir is required')
  return resolve(flags['state-dir'])
}

/** Refuse a second request: the supervisor claims one request at a time and the deployment CLI must not queue behind it. */
function idle(stateDir) {
  const snapshot = updateSnapshot(stateDir)
  if (snapshot.pending !== null) throw new Error(`an update request is already pending (${snapshot.pending.id}); wait for the supervisor to claim it`)
  if (snapshot.busy || existsSync(updateProcessingPath(stateDir))) throw new Error('an update is already in progress; wait for the supervisor to finish before requesting another one')
  return snapshot
}

/** The newest staged version by manifest modification time; an operator may still name one explicitly. */
function newestStaged(stateDir) {
  const runtimeDir = runtimeDirectory(stateDir)
  if (!existsSync(runtimeDir)) throw new Error(`no staged runtime exists under ${runtimeDir}`)
  const versions = []
  for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(runtimeDir, entry.name, 'runtime-manifest.json')
    if (existsSync(path)) versions.push({ version: entry.name, at: statSync(path).mtimeMs })
  }
  if (versions.length === 0) throw new Error(`no staged runtime exists under ${runtimeDir}`)
  versions.sort((left, right) => right.at - left.at)
  return versions[0].version
}

/** Read and verify the staged manifest, including the database schema it may not go below. */
function staged(stateDir, version) {
  const runtimeDir = runtimeDirectory(stateDir)
  const path = join(runtimeDir, version, 'runtime-manifest.json')
  if (!existsSync(path)) throw new Error(`version ${version} is not staged under ${runtimeDir}; stage it first`)
  const read = readDescriptorFile(path)
  if (read.descriptor === undefined) throw new Error(`version ${version} cannot be applied: ${read.reason}`)
  const database = databaseSchema(join(stateDir, 'orchestrator.sqlite'))
  const verification = verifyDescriptor(runtimeDir, read.descriptor, database)
  if (verification.entry === undefined) throw new Error(`version ${version} cannot be applied: ${verification.reason}`)
  return read.descriptor
}

export function stageCommand(flags) {
  const stateDir = stateDirectory(flags)
  const stagedRuntime = stageRuntime({ from: flags.from ?? process.cwd(), stateDir })
  return { staged: stagedRuntime, path: stagedRuntime.path, deploy: deployCommands(stateDir) }
}

export function applyCommand(flags) {
  const stateDir = stateDirectory(flags)
  const snapshot = idle(stateDir)
  const version = flags.version ?? newestStaged(stateDir)
  const descriptor = staged(stateDir, version)
  if (snapshot.current?.version === descriptor.version) throw new Error(`version ${descriptor.version} is already running`)
  const request = { api: 1, id: randomUUID(), action: 'apply', version: descriptor.version, at: new Date().toISOString(), by: 'operator' }
  writeUpdateRequest(stateDir, request)
  return { requested: true, request, path: updateRequestPath(stateDir), deploy: deployCommands(stateDir) }
}

export function rollbackCommand(flags) {
  const stateDir = stateDirectory(flags)
  const snapshot = idle(stateDir)
  if (!snapshot.rollback.eligible) throw new Error(snapshot.rollback.reason || 'there is no previous runtime to roll back to')
  const request = { api: 1, id: randomUUID(), action: 'rollback', at: new Date().toISOString(), by: 'operator' }
  writeUpdateRequest(stateDir, request)
  return { requested: true, request, path: updateRequestPath(stateDir), deploy: deployCommands(stateDir) }
}

export function statusCommand(flags) {
  const stateDir = stateDirectory(flags)
  const snapshot = updateSnapshot(stateDir)
  return { ...snapshot, deploy: deployCommands(stateDir) }
}

/** Poll until the supervisor has recorded the outcome of a request that was pending (or in progress) when watch began. */
export async function watchCommand(flags) {
  const stateDir = stateDirectory(flags)
  const timeoutMs = flags.timeout === undefined ? 120_000 : Number(flags.timeout)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout must be a positive number of milliseconds')
  const baseline = updateSnapshot(stateDir)
  // `snapshot.history` is oldest first, so the newest entry is the last one and the settle check compares that id.
  const prior = baseline.history.at(-1)?.id
  if (baseline.pending === null && !baseline.busy && !existsSync(updateProcessingPath(stateDir))) {
    return { resolved: false, reason: 'no update request is pending', ...baseline, deploy: deployCommands(stateDir) }
  }
  const deadline = Date.now() + timeoutMs
  let snapshot = baseline
  while (Date.now() <= deadline) {
    snapshot = updateSnapshot(stateDir)
    const settled = snapshot.pending === null && !snapshot.busy && !existsSync(updateProcessingPath(stateDir))
    if (settled && (prior !== undefined ? snapshot.history.at(-1)?.id !== prior : snapshot.history.length > 0)) {
      return { resolved: true, ...snapshot, deploy: deployCommands(stateDir) }
    }
    await new Promise(done => setTimeout(done, 250))
  }
  return { resolved: false, ...snapshot, deploy: deployCommands(stateDir) }
}

export async function main(argv = process.argv.slice(2), io = process.stdout, errors = process.stderr) {
  try {
    const { command, flags } = parseArgs(argv)
    if (flags.help === true || command === undefined) {
      errors.write('deploy-runtime: usage: --state-dir <dir> stage|apply|status|watch|rollback\n')
      return command === undefined && flags.help !== true ? 1 : 0
    }
    const result = command === 'stage' ? stageCommand(flags)
      : command === 'apply' ? applyCommand(flags)
        : command === 'rollback' ? rollbackCommand(flags)
          : command === 'status' ? statusCommand(flags)
            : command === 'watch' ? await watchCommand(flags)
              : undefined
    if (result === undefined) throw new Error(`unknown command ${command}; use stage, apply, status, watch or rollback`)
    io.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (problem) {
    errors.write(`deploy-runtime: ${message(problem)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main()
}
