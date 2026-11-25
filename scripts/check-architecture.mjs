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
 * - A bare `instanceof CliError` is bundle-local, because the versioned runtime is its own bundle; classify a CLI
 *   failure that may come from the runtime's Commands with `isCliError` instead.
 * - Model-facing text is bounded in one place: no module outside `src/app/projection.ts` may slice text to a context
 *   policy width or keep one of the retired truncation constants (docs/015 D2). The two internal exceptions below carry
 *   text that never reaches a model.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Files whose truncation stays local because the text never reaches a model, with the reason. */
const RAW_TEXT_EXEMPT = new Map([
  ['src/app/outbox.ts', 'the delivery detail is a health line, not model-facing'],
  ['src/sources/feishu-loops.ts', 'a Feishu loop diagnostic line, not model-facing'],
])
/** The truncation constants the projection policy absorbed; a call site that keeps one re-establishes a second policy. */
const LEGACY_TRUNCATION = /\b(?:TRIGGER_CHARS|NEAR_CHARS|WINDOW_CHARS|STUB_CHARS|INPUT_TEXT)\b/
/** A call-site cut at one of the policy widths: the same silent truncation the policy table exists to replace. */
const RAW_POLICY_SLICE = /\.slice\(\s*0\s*,\s*(?:50|80|100|160|200|400|600|1_200|1200|1500|4000)\s*\)/

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
      if (file !== 'src/infra/commands.ts' && /\binstanceof\s+CliError\b/.test(line)) {
        found.push({ file, line: index + 1, imported: 'CliError', rule: 'instanceof CliError is bundle-local; classify CLI failures with isCliError' })
      }
      if (file !== 'src/app/projection.ts' && !RAW_TEXT_EXEMPT.has(file)) {
        if (LEGACY_TRUNCATION.test(line)) {
          found.push({ file, line: index + 1, imported: 'truncation constant', rule: 'model-facing text is bounded by a docs/context-policy.md field, not a truncation constant' })
        }
        if (/^src\/(app|executor|sources)\//.test(file) && RAW_POLICY_SLICE.test(line)) {
          found.push({ file, line: index + 1, imported: 'slice(0, width)', rule: 'model-facing text is bounded by a docs/context-policy.md field, not a call-site slice' })
        }
      }
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
    for (const violation of found) console.error(`${violation.file}:${violation.line} ${violation.imported} — ${violation.rule}`)
    console.error(`\n${found.length} architecture violation(s)`)
    process.exit(1)
  }
  console.log(`architecture: ${files.size} source files follow the import direction`)
}

if (process.argv[1] && /check-architecture\.mjs$/.test(process.argv[1])) main()
