/**
 * Layering check: the direction every module may import.
 *
 * The app is deliberately layered: `core` states and decides, the application layer binds it to DSH, adapters talk to the
 * outside world, and the client only renders what the HTTP API returns. A wrong-way import is easy to write and hard to
 * notice, so this check reads the import graph instead of trusting review.
 *
 * Rules:
 * - `src/core/**` may import its own modules and `infra`, never the layers above it (app, executor, sources, client, policy).
 * - `src/client/**` may import the client and the HTTP contract (`src/app/api.ts`), never another server module or a Node
 * built-in; the browser bundle cannot carry the database or the filesystem.
 * - `src/**` may import neither `tests/` nor `scripts/`; those are development-only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Every TypeScript file under `src/`, with its path relative to the repository root. */
function sourceFiles(root) {
  const files = new Map()
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) files.set(relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'))
    }
  }
  walk(join(root, 'src'))
  return files
}

const IMPORT = /^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gm

/** Rules a single import from `file` must satisfy; returns the broken ones. */
function rulesFor(file, imported, typeOnly) {
  const broken = []
  const fromClient = file.startsWith('src/client/')
  const fromCore = file.startsWith('src/core/')
  if (fromCore && /^(\.\.\/)+(app|executor|sources|client|policy|projects|deployment)(\/|\.|$)/.test(imported)) {
    broken.push('core imports the layer above it')
  }
  if (fromClient && !typeOnly) {
    if (imported.startsWith('node:')) broken.push('the client imports a Node built-in')
    if (/^(\.\.\/)+app\//.test(imported) && !/^(\.\.\/)+app\/api\.ts$/.test(imported)) {
      broken.push('the client imports a server module other than the HTTP contract')
    }
    if (/^(\.\.\/)+(executor|sources|deployment|policy|projects|infra)\//.test(imported) && !/^(\.\.\/)+sources\/host\.ts$/.test(imported)) {
      broken.push('the client imports a server module')
    }
  }
  if (file.startsWith('src/') && /^(\.\.\/)+(tests|scripts)\//.test(imported)) broken.push('src imports development tooling')
  return broken
}

/** Every layering violation in the given source files (a Map of repository-relative path to text). */
export function violations(files) {
  const found = []
  for (const [file, text] of files) {
    const lines = text.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      IMPORT.lastIndex = 0
      const match = IMPORT.exec(line)
      if (!match) continue
      const typeOnly = /^\s*(?:import|export)\s+type\s/.test(line)
      for (const rule of rulesFor(file, match[1], typeOnly)) found.push({ file, line: index + 1, imported: match[1], rule })
    }
  }
  return found
}

function main() {
  const root = process.cwd()
  const files = sourceFiles(root)
  const found = violations(files)
  if (found.length) {
    for (const violation of found) console.error(`${violation.file}:${violation.line} imports ${violation.imported} — ${violation.rule}`)
    console.error(`\n${found.length} architecture violation(s)`)
    process.exit(1)
  }
  console.log(`architecture: ${files.size} source files follow the import direction`)
}

if (process.argv[1] && /check-architecture\.mjs$/.test(process.argv[1])) main()
