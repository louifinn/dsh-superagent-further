#!/usr/bin/env node
/**
 * Move one local dsh-superagent installation to the dsh-superagent-further names.
 *
 * Run this file with Node 22.19+ (`node scripts/migrate-rename.mjs --profile <name>`); it has no dependency beyond the
 * Node standard library. It changes three things and nothing else:
 *
 * - the profile's `package.json`: the dependency key and the bundle in `dsh.profile.bundles`;
 * - the profile's `cordis.patch.yml`: the `id:` values of this bundle's rows, including both watch components;
 * - the `agentPreset` recorded in DSH Session logs, so the main, Lead and Executor Sessions resume.
 *
 * The state directory, the database, the worktrees, the Source kinds, the `DSH_SUPERAGENT_*` variables and every
 * stored Thread, Ticket and Request are left alone. Each changed file gets a `.pre-0.3.0` copy first; `--dry-run`
 * reports the changes without writing them. See `docs/006-deployment.md`, "Migrating from dsh-superagent".
 *
 * Usage:
 *   migrate-rename [--profile <name>] [--dsh-home <dir>] [--sessions-dir <dir>] [--dry-run]
 *
 * Exit codes: 0 nothing failed; 1 a profile or session file could not be read or written.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const OLD = 'dsh-superagent'
const NEXT = 'dsh-superagent-further'
const PRESETS = ['worker', 'router', 'lead']
const BACKUP = '.pre-0.3.0'
const SESSION_FILE = 'session.v4.jsonl.zstd'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined && !args[at + 1].startsWith('--') ? args[at + 1] : fallback
}
const flag = name => args.includes(`--${name}`)

if (flag('help') || flag('h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 25)
    .map(line => line.replace(/^ \* ?/, '')).join('\n'))
  process.exit(0)
}

const profileName = option('profile', process.env.DSH_SUPERAGENT_PROFILE ?? 'superagent')
const dshHome = option('dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const sessionsDir = option('sessions-dir', join(dshHome, 'sessions'))
const dryRun = flag('dry-run')
const profileDir = join(dshHome, 'profiles', profileName)

let failures = 0
const warn = message => { console.warn(`warning: ${message}`) }
const fail = message => { failures += 1; console.error(`error: ${message}`) }

/** Write `value` to `path`, keeping one pre-0.3.0 copy of the file it replaces. */
function replace(path, value) {
  if (dryRun) return
  const backup = `${path}${BACKUP}`
  if (!existsSync(backup)) copyFileSync(path, backup)
  writeFileSync(path, value)
}

/** Rename this bundle's ids in a cordis.patch.yml line, and change nothing else on the line. */
function renameRow(line) {
  const pattern = /^(\s*-\s+id:\s*)(['"]?)(dsh-superagent(?:-github|-feishu)?)(\2)(\s*(?:#.*)?)$/
  return line.replace(pattern, (_match, prefix, quote, id, _sameQuote, tail) => {
    const renamed = id === OLD ? NEXT : id.replace(OLD, NEXT)
    return `${prefix}${quote}${renamed}${quote}${tail}`
  })
}

function migrateProfile() {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    fail(`${manifestPath} does not exist; pass --dsh-home and --profile for the installation to migrate`)
    return
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`${manifestPath}: ${error.message}`)
    return
  }

  const before = JSON.stringify(manifest)
  let dependency = false
  for (const group of ['dependencies', 'devDependencies']) {
    const entries = manifest[group]
    if (!entries || entries[OLD] === undefined) continue
    if (entries[NEXT] !== undefined) {
      fail(`${manifestPath}: both ${OLD} and ${NEXT} are dependencies; remove one by hand first`)
      return
    }
    entries[NEXT] = entries[OLD]
    delete entries[OLD]
    dependency = true
  }

  const bundles = manifest.dsh?.profile?.bundles
  const already = manifest.dependencies?.[NEXT] !== undefined || manifest.devDependencies?.[NEXT] !== undefined
    || (Array.isArray(bundles) && bundles.includes(NEXT))
  let bundle = false
  if (Array.isArray(bundles) && bundles.includes(OLD)) {
    manifest.dsh.profile.bundles = bundles.map(entry => entry === OLD ? NEXT : entry)
    bundle = true
  }

  const changed = JSON.stringify(manifest) !== before
  if (changed) {
    replace(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`${dryRun ? 'would rename' : 'renamed'} ${manifestPath}: dependency ${dependency ? `${OLD} -> ${NEXT}` : 'unchanged'}, ` +
      `bundle ${bundle ? `${OLD} -> ${NEXT}` : 'unchanged'}`)
  } else if (already) {
    console.log(`${manifestPath}: already uses ${NEXT}`)
  } else {
    warn(`${manifestPath} does not depend on ${OLD}; is ${profileName} the right profile?`)
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    warn(`${patchPath} does not exist; the bundle has no machine configuration to rename`)
    return
  }
  const patch = readFileSync(patchPath, 'utf8')
  let rows = 0
  const renamed = patch.split('\n').map(line => {
    const next = renameRow(line)
    if (next !== line) rows += 1
    return next
  }).join('\n')
  if (rows > 0) {
    replace(patchPath, renamed)
    console.log(`${dryRun ? 'would rename' : 'renamed'} ${patchPath}: ${rows} bundle row(s)`)
  } else {
    console.log(`${patchPath}: no ${OLD} bundle row left to rename`)
  }
}

/** One zstd frame: magic, descriptor, optional window/dictionary/content size, blocks, optional checksum. */
function scanFrames(buffer) {
  const frames = []
  let start = 0
  while (start < buffer.length) {
    let at = start
    try {
      if (buffer.length - at < 4) return { frames, tornStart: start }
      if (buffer.readUInt32LE(at) !== 0xfd2fb528) throw new Error('not a zstd frame')
      at += 4
      if (at >= buffer.length) return { frames, tornStart: start }
      const descriptor = buffer[at++]
      if ((descriptor & 24) !== 0) throw new Error('reserved descriptor bits are set')
      const contentSizeFlag = descriptor >>> 6
      const singleSegment = (descriptor & 32) !== 0
      const checksum = (descriptor & 4) !== 0
      const dictionaryFlag = descriptor & 3
      const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
      const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
      at += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
      for (;;) {
        if (buffer.length - at < 3) return { frames, tornStart: start }
        const header = buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16)
        at += 3
        const lastBlock = header & 1
        const blockType = (header >>> 1) & 3
        const blockSize = header >>> 3
        if (blockType === 3) throw new Error('reserved block type')
        at += blockType === 1 ? 1 : blockSize
        if (at > buffer.length) return { frames, tornStart: start }
        if (lastBlock) break
      }
      if (checksum) at += 4
      if (at > buffer.length) return { frames, tornStart: start }
      frames.push({ start, end: at })
      start = at
    } catch {
      return { frames, tornStart: start }
    }
  }
  return { frames }
}

/** Replace the stored preset id of every Session frame that carries one; return the rewritten bytes or undefined. */
function rewriteSession(buffer) {
  const scan = scanFrames(buffer)
  if (scan.tornStart !== undefined) {
    throw new Error(`the log ends with an incomplete frame at byte ${scan.tornStart}`)
  }
  const preset = /("agentPreset"\s*:\s*")(dsh-superagent-(?:worker|router|lead))(")/g
  let references = 0
  const chunks = []
  for (const frame of scan.frames) {
    const raw = buffer.subarray(frame.start, frame.end)
    const text = zstdDecompressSync(raw).toString('utf8')
    const rewritten = text.replace(preset, (_match, prefix, id, suffix) => {
      references += 1
      return `${prefix}${id.replace(OLD, NEXT)}${suffix}`
    })
    if (rewritten === text) {
      chunks.push(raw)
      continue
    }
    chunks.push(zstdCompressSync(rewritten, { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }))
  }
  return references === 0 ? undefined : { buffer: Buffer.concat(chunks), references }
}

function migrateSessions() {
  if (!existsSync(sessionsDir)) {
    console.log(`${sessionsDir}: no Session directory; nothing to rewrite`)
    return
  }
  let files = 0
  let references = 0
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (entry.name !== SESSION_FILE) continue
      files += 1
      try {
        const buffer = readFileSync(path)
        const result = rewriteSession(buffer)
        if (!result) continue
        references += result.references
        if (dryRun) {
          console.log(`would rewrite ${path}: ${result.references} preset reference(s)`)
          continue
        }
        const backup = `${path}${BACKUP}`
        if (!existsSync(backup)) copyFileSync(path, backup)
        const temporary = `${path}.migrate-${process.pid}.tmp`
        try {
          writeFileSync(temporary, result.buffer)
          renameSync(temporary, path)
        } catch (error) {
          rmSync(temporary, { force: true })
          throw error
        }
        console.log(`rewrote ${path}: ${result.references} preset reference(s)`)
      } catch (error) {
        fail(`${path}: ${error.message}`)
      }
    }
  }
  walk(sessionsDir)
  console.log(`${sessionsDir}: ${files} Session log(s), ${references} preset reference(s) ` +
    `${dryRun ? 'to rewrite' : 'rewritten'}`)
}

console.log(`${dryRun ? 'dry run: ' : ''}migrating ${profileDir} from ${OLD} to ${NEXT}`)
migrateProfile()
migrateSessions()

if (failures > 0) {
  console.error(`migration incomplete: ${failures} file(s) need attention`)
  process.exit(1)
}
if (dryRun) {
  console.log('dry run complete; no files were changed; rerun without --dry-run to apply')
} else {
  console.log(`migration complete; start the host with scripts/${NEXT} and run scripts/verify-install`)
}
