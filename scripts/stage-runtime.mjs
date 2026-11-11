/**
 * Stage a built runtime into a state directory (ADR-0007): copy `lib/runtime-entry.js` and its manifest into
 * `<stateDir>/runtime/<version>/` through a temporary directory and one atomic rename, then print the descriptor.
 *
 *   node --experimental-transform-types scripts/stage-runtime.mjs --from <repo> --state-dir <dir>
 *
 * The packaged manifest is only read; the staged copy records version, hostApi, schema, sha256, builtAt and node so an
 * operator can tell which build a state directory picked up.
 */
import { createHash } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { HOST_API } from '../src/runtime-host.ts'
import { runtimeDirectory } from '../src/supervisor/versions.ts'

const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]*$/
const ENTRY = 'runtime-entry.js'
const HASH = /^[0-9a-f]{64}$/

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Write `text` durably (fsync before close) so a staged manifest never survives a crash half-written. */
function writeDurable(path, text, mode = 0o600) {
  const fd = openSync(path, 'w', mode)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The build must be complete: the entry and the manifest the build script wrote, both checked against each other. */
export function inspectBuild(from) {
  const root = resolve(from)
  const manifestPath = join(root, 'lib', 'runtime-manifest.json')
  const entryPath = join(root, 'lib', ENTRY)
  if (!existsSync(manifestPath)) throw new Error(`the built runtime is missing ${manifestPath}; run pnpm build first`)
  if (!existsSync(entryPath)) throw new Error(`the built runtime is missing ${entryPath}; run pnpm build first`)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (problem) {
    throw new Error(`the built runtime manifest is not JSON: ${problem.message}`)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('the built runtime manifest is not an object')
  const { version, entry, hostApi, schema, sha256: recorded } = manifest
  if (typeof version !== 'string' || !VERSION.test(version) || version.length > 80) throw new Error(`the built runtime version is invalid: ${String(version)}`)
  if (entry !== ENTRY) throw new Error(`the built runtime entry is ${String(entry)}, expected ${ENTRY}`)
  if (hostApi !== HOST_API) throw new Error(`the built runtime targets host API ${String(hostApi)}, this supervisor implements ${HOST_API}`)
  if (!Number.isInteger(schema) || schema < 1) throw new Error(`the built runtime schema is invalid: ${String(schema)}`)
  if (typeof recorded !== 'string' || !HASH.test(recorded)) throw new Error('the built runtime manifest has no sha256')
  const actual = sha256(entryPath)
  if (actual !== recorded) throw new Error(`the built runtime entry has hash ${actual}, but its manifest records ${recorded}; rebuild before staging`)
  const builtAt = statSync(entryPath).mtime.toISOString()
  return { root, entryPath, manifest, descriptor: { version, entry, hostApi, schema, sha256: actual, builtAt, node: process.version } }
}

/** Stage one build; returns the descriptor that was recorded in `<stateDir>/runtime/<version>/runtime-manifest.json`. */
export function stageRuntime({ from, stateDir }) {
  const built = inspectBuild(from)
  const runtimeDir = runtimeDirectory(resolve(stateDir))
  const target = join(runtimeDir, built.descriptor.version)
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const existingPath = join(target, 'runtime-manifest.json')
  if (existsSync(existingPath)) {
    // Re-staging the identical bundle is idempotent; a different one needs a new version (or a deliberate removal).
    let existing
    try {
      existing = JSON.parse(readFileSync(existingPath, 'utf8'))
    } catch {
      existing = undefined
    }
    if (existing?.sha256 !== built.descriptor.sha256 || existing?.version !== built.descriptor.version) {
      throw new Error(`version ${built.descriptor.version} is already staged at ${target} with a different bundle; remove it before staging this build`)
    }
    return { ...built.descriptor, builtAt: existing.builtAt ?? built.descriptor.builtAt, path: target, staged: false }
  }
  const temporary = join(runtimeDir, `.staging-${built.descriptor.version}-${process.pid}-${Date.now().toString(36)}`)
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true, mode: 0o700 })
  try {
    copyFileSync(built.entryPath, join(temporary, ENTRY))
    writeDurable(join(temporary, 'runtime-manifest.json'), `${JSON.stringify(built.descriptor, null, 2)}\n`)
    renameSync(temporary, target)
  } catch (problem) {
    rmSync(temporary, { recursive: true, force: true })
    throw problem
  }
  return { ...built.descriptor, path: target, staged: true }
}
