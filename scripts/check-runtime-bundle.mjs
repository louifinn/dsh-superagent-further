#!/usr/bin/env node
// Runtime bundle check: the versioned domain runtime is one self-contained ESM file with a matching descriptor.
//
//   node scripts/check-runtime-bundle.mjs           # verify lib/runtime-entry.js and lib/runtime-manifest.json
//   node scripts/check-runtime-bundle.mjs --write   # also write the descriptor (used by `pnpm build`)
//
// The supervisor imports this file from `<stateDir>/runtime/<version>/` in a future release, so it must run there with no
// `node_modules/@deepseek-ai` beside it: every import must be a Node builtin, and all other code must be bundled in. The
// module must export the host API this package implements, `createRuntime`, and the database schema it understands; the
// descriptor records those, the entry name, and the entry's SHA-256, which the loader verifies before importing.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entryPath = path.join(root, 'lib', 'runtime-entry.js')
const descriptorPath = path.join(root, 'lib', 'runtime-manifest.json')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const HOST_API = 1
const MAX_BYTES = 8 * 1024 * 1024
const update = process.argv.includes('--write')

if (!fs.existsSync(entryPath)) {
  console.error(`runtime bundle check failed: ${path.relative(root, entryPath)} is missing; run pnpm build first`)
  process.exit(1)
}
const source = fs.readFileSync(entryPath, 'utf8')
const bytes = fs.statSync(entryPath).size
const problems = []

if (bytes === 0) problems.push('the runtime bundle is empty')
if (bytes > MAX_BYTES) problems.push(`the runtime bundle is ${bytes} bytes, over the ${MAX_BYTES}-byte bound`)

/** Static `import ... from`, side-effect `import "..."`, re-exports, and literal dynamic imports. */
const specifiers = new Set()
for (const match of source.matchAll(/\b(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) specifiers.add(match[1])
for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1])
for (const specifier of specifiers) {
  if (specifier.startsWith('node:')) continue
  if (specifier.startsWith('@deepseek-ai/')) {
    problems.push(`the runtime bundle imports ${specifier} at run time; DSH values must arrive through the RuntimeHost`)
  } else {
    problems.push(`the runtime bundle imports ${specifier}; the deployed bundle must be self-contained (only node: builtins)`)
  }
}

let module
try {
  module = await import(pathToFileURL(entryPath).href)
} catch (error) {
  problems.push(`the runtime bundle cannot be imported: ${error instanceof Error ? error.message : String(error)}`)
}
if (module !== undefined) {
  if (module.HOST_API !== HOST_API) problems.push(`the runtime exports HOST_API ${String(module.HOST_API)}, expected ${HOST_API}`)
  if (typeof module.createRuntime !== 'function') problems.push('the runtime does not export createRuntime')
  if (!Number.isInteger(module.SCHEMA_VERSION)) problems.push('the runtime does not export an integer SCHEMA_VERSION')
}

const sha256 = createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex')
const descriptor = { version: packageJson.version, entry: 'runtime-entry.js', hostApi: HOST_API, schema: module?.SCHEMA_VERSION, sha256 }
if (update) {
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`)
  console.log(`runtime bundle check: wrote ${path.relative(root, descriptorPath)} (${bytes} bytes, sha256 ${sha256.slice(0, 12)}…)`)
} else if (!fs.existsSync(descriptorPath)) {
  problems.push(`${path.relative(root, descriptorPath)} is missing; run pnpm build`)
} else {
  const stored = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
  for (const key of ['version', 'entry', 'hostApi', 'schema', 'sha256']) {
    if (JSON.stringify(stored[key]) !== JSON.stringify(descriptor[key])) {
      problems.push(`the descriptor's ${key} is ${JSON.stringify(stored[key])}, expected ${JSON.stringify(descriptor[key])}`)
    }
  }
}

if (problems.length > 0) {
  console.error('runtime bundle check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`runtime bundle check: ${path.relative(root, entryPath)} is self-contained (${bytes} bytes, host API ${HOST_API}, schema ${module.SCHEMA_VERSION})`)
