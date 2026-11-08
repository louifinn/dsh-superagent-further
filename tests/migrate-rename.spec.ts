import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/migrate-rename.mjs', import.meta.url))
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** Run the migration as an operator would, and keep both streams for the assertion. */
function run(...args: string[]) {
  try {
    return { status: 0, output: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

/** The frame boundaries of one session log: the same walk the script and DSH use. */
function frames(buffer: Buffer): Buffer[] {
  const result: Buffer[] = []
  let start = 0
  while (start < buffer.length) {
    expect(buffer.readUInt32LE(start)).toBe(0xfd2fb528)
    let at = start + 4
    const descriptor = buffer[at++]!
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    at += (singleSegment ? 0 : 1) + dictionaryBytes + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    for (;;) {
      const header = buffer[at]! | (buffer[at + 1]! << 8) | (buffer[at + 2]! << 16)
      at += 3
      const lastBlock = header & 1
      const blockType = (header >>> 1) & 3
      const blockSize = header >>> 3
      at += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) at += 4
    result.push(buffer.subarray(start, at))
    start = at
  }
  return result
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-migrate-'))
  homes.push(home)
  const profile = join(home, 'profiles', 'superagent')
  const session = join(home, 'sessions', 'project')
  mkdirSync(profile, { recursive: true })
  mkdirSync(session, { recursive: true })
  const manifest = {
    name: 'superagent-profile',
    private: true,
    dependencies: { 'dsh-superagent': 'link:C:/src/dsh-superagent' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-superagent'] } },
  }
  const patch = [
    '- id: webserver',
    '  config:',
    '    port: 3082',
    '- id: dsh-superagent',
    '  config:',
    '    stateDir: C:\\state\\superagent',
    '    # dsh-superagent is installed by link',
    '- id: dsh-superagent-feishu',
    '  config:',
    '    disabled: false',
    '',
  ].join('\n')
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'orchestrator-x', agentPreset: 'dsh-superagent-router' }),
    JSON.stringify({ type: 'agent-preset/selected', data: { agentPreset: 'dsh-superagent-worker' } }),
    JSON.stringify({ type: 'user/message', data: { text: 'dsh-superagent-worker is mentioned in prose' } }),
  ]
  const log = Buffer.concat(lines.map(line => zstdCompressSync(line, { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } })))
  const manifestPath = join(profile, 'package.json')
  const patchPath = join(profile, 'cordis.patch.yml')
  const sessionPath = join(session, 'session.v4.jsonl.zstd')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(patchPath, patch)
  writeFileSync(sessionPath, log)
  return { home, manifestPath, patchPath, sessionPath, manifest, patch, log }
}

it('migrates the profile, the patch rows and the stored preset ids, and keeps operator data', () => {
  const files = fixture()
  const result = run('--profile', 'superagent', '--dsh-home', files.home)
  expect(result.status).toBe(0)

  const manifest = JSON.parse(readFileSync(files.manifestPath, 'utf8')) as typeof files.manifest
  expect(manifest.dependencies).toEqual({ 'dsh-superagent-further': 'link:C:/src/dsh-superagent' })
  expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-superagent-further'])
  expect(readFileSync(`${files.manifestPath}.pre-0.3.0`, 'utf8')).toBe(`${JSON.stringify(files.manifest, null, 2)}\n`)

  const patch = readFileSync(files.patchPath, 'utf8')
  expect(patch).toContain('- id: dsh-superagent-further\n')
  expect(patch).toContain('- id: dsh-superagent-further-feishu\n')
  expect(patch).toContain('stateDir: C:\\state\\superagent')
  expect(patch).toContain('    # dsh-superagent is installed by link')
  expect(readFileSync(`${files.patchPath}.pre-0.3.0`, 'utf8')).toBe(files.patch)

  const texts = frames(readFileSync(files.sessionPath)).map(frame => zstdDecompressSync(frame).toString('utf8'))
  expect(texts[0]).toContain('"agentPreset":"dsh-superagent-further-router"')
  expect(texts[1]).toContain('"agentPreset":"dsh-superagent-further-worker"')
  // A preset id in prose is history, not a registration id: the script leaves it alone.
  expect(texts[2]).toContain('dsh-superagent-worker is mentioned in prose')
  expect(readFileSync(`${files.sessionPath}.pre-0.3.0`)).toEqual(files.log)
  expect(result.output).toContain('migration complete')
})

it('reports a dry run without changing a file', () => {
  const files = fixture()
  const before = [readFileSync(files.manifestPath), readFileSync(files.patchPath), readFileSync(files.sessionPath)]
  const result = run('--profile', 'superagent', '--dsh-home', files.home, '--dry-run')
  expect(result.status).toBe(0)
  expect(result.output).toContain('would rename')
  expect([readFileSync(files.manifestPath), readFileSync(files.patchPath), readFileSync(files.sessionPath)]).toEqual(before)
  for (const path of [files.manifestPath, files.patchPath, files.sessionPath]) expect(existsSync(`${path}.pre-0.3.0`)).toBe(false)
})

it('is idempotent: a second run reports the profile as migrated and rewrites no session log', () => {
  const files = fixture()
  expect(run('--profile', 'superagent', '--dsh-home', files.home).status).toBe(0)
  const migrated = readFileSync(files.sessionPath)
  const second = run('--profile', 'superagent', '--dsh-home', files.home)
  expect(second.status).toBe(0)
  expect(second.output).toContain('already uses dsh-superagent-further')
  expect(second.output).not.toContain('rewrote')
  expect(readFileSync(files.sessionPath)).toEqual(migrated)
})

it('fails when the profile does not exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-migrate-'))
  homes.push(home)
  const result = run('--profile', 'missing', '--dsh-home', home)
  expect(result.status).toBe(1)
  expect(result.output).toContain('does not exist')
})
