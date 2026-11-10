#!/usr/bin/env node
// Pack check: the published tarball carries exactly the files this repository promises, and the list is reviewed when it changes.
//
//   npm run pack:check              # fail when the tarball differs from scripts/pack-manifest.json
//   node scripts/check-pack.mjs --update   # rewrite the manifest deliberately
//
// `npm pack --dry-run --json` is the same resolution the npm client and the DSH plugin CLI use, so this checks the real tarball
// rather than re-reading `files` by hand. The manifest records the exact path list, so an accidental removal (a locale, a prompt,
// a skill, the client bundle or a build chunk) or an accidental addition (a source file) is a reviewable diff.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(root, 'scripts', 'pack-manifest.json')

/** npm's JS entry, so no shell and no quoting is involved on any platform. */
function npmInvocation() {
  const nodeDir = path.dirname(process.execPath)
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(candidate => typeof candidate === 'string' && candidate.endsWith('.js'))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate], shell: false }
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' }
}

function packedFiles() {
  const npm = npmInvocation()
  const result = spawnSync(npm.command, [...npm.args, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', shell: npm.shell, maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw new Error(`npm pack could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`npm pack failed (exit ${result.status}):\n${(result.stderr ?? '').slice(-4000)}`)
  const parsed = JSON.parse(result.stdout)
  const files = parsed[0]?.files
  if (!files) throw new Error('npm pack --json printed no file list')
  return files.map(file => file.path).sort()
}

/** Files every release must carry regardless of the manifest baseline. */
const REQUIRED = [
  'package.json',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'prompts/worker.md',
  'skills/dsh-superagent-further-github/SKILL.md',
  'skills/dsh-superagent-further-feishu/SKILL.md',
  'skills/dsh-superagent-further-triage/SKILL.md',
  'skills/dsh-superagent-further-release/SKILL.md',
  'skills/dsh-superagent-further-project-request/SKILL.md',
]
/** Paths that must never enter the tarball. */
const FORBIDDEN = ['src/', 'tests/', 'docs/', '.artifacts/', 'scripts/', 'node_modules/']

const update = process.argv.includes('--update')
const actual = packedFiles()
const baseline = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : undefined

const missing = baseline === undefined ? [] : baseline.filter(file => !actual.includes(file))
const added = baseline === undefined ? [] : actual.filter(file => !baseline.includes(file))
const absent = REQUIRED.filter(file => !actual.includes(file))
const leaked = FORBIDDEN.flatMap(prefix => actual.filter(file => file.startsWith(prefix)).map(file => `${prefix}* → ${file}`))

if (update) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(actual, null, 2)}\n`)
  console.log(`pack check: wrote ${path.relative(root, manifestPath)} with ${actual.length} files`)
  process.exit(0)
}

const problems = [
  ...absent.map(file => `missing required file: ${file}`),
  ...leaked.map(file => `packed a path outside the package: ${file}`),
  ...missing.map(file => `in the manifest but not packed: ${file}`),
  ...added.map(file => `packed but not in the manifest: ${file}`),
]
if (baseline !== undefined && missing.length === 0 && added.length === 0 && absent.length === 0 && leaked.length === 0) {
  console.log(`pack check: ${actual.length} files match scripts/pack-manifest.json`)
  process.exit(0)
}
if (problems.length === 0) problems.push('scripts/pack-manifest.json is missing; run node scripts/check-pack.mjs --update and review the list')
console.error(`pack check failed (${actual.length} packed files):`)
for (const problem of problems) console.error(`  - ${problem}`)
process.exit(1)
