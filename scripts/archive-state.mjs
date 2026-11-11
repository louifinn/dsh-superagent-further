/**
 * Archive the state database before a risky operation (an upgrade, a manual repair, a schema migration rehearsal).
 *
 * SQLite cannot be copied reliably while the Host writes it, so the archive is taken with `VACUUM INTO`, which SQLite runs
 * inside the database's own locking and produces a consistent file. Old archives are pruned by count so a regular operator
 * does not fill the disk unnoticed.
 *
 * Usage: `node scripts/archive-state.mjs --state-dir <dir> [--database <path>] [--keep <n>] [--out <dir>]`
 * Defaults: the profile's state directory is required and its database is `<stateDir>/orchestrator.sqlite`; `--keep 5`;
 * the output directory is `<stateDir>/archive`. Operational log files under `<stateDir>/logs` are not in the database
 * snapshot and must be copied separately when they are needed after a move.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** One archived database file. */
export function archives(directory) {
  try {
    return readdirSync(directory).filter(name => /^state-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/.test(name)).sort()
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Take one consistent copy of the state database (`<stateDir>/orchestrator.sqlite` by default) and prune the oldest
 * archives beyond `keep`.
 * @returns the archived file's path and the names it pruned.
 */
export function archive(stateDir, { database = join(stateDir, 'orchestrator.sqlite'), keep = 5,
  out = join(stateDir, 'archive'), now = new Date() } = {}) {
  const source = database
  const at = statSync(source)
  if (!at.isFile()) throw new Error(`${source} is not a file`)
  mkdirSync(out, { recursive: true })
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}`
    + `-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}-${pad(now.getUTCMilliseconds(), 3)}Z`
  const target = join(out, `state-${stamp}.sqlite`)
  const connection = new DatabaseSync(source, { readOnly: true })
  try {
    connection.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  } finally {
    connection.close()
  }
  const pruned = []
  for (const name of archives(out).slice(0, Math.max(0, archives(out).length - keep))) {
    rmSync(join(out, name))
    pruned.push(name)
  }
  return { file: target, pruned }
}

function main() {
  const args = process.argv.slice(2)
  const option = name => {
    const at = args.indexOf(`--${name}`)
    return at < 0 ? undefined : args[at + 1]
  }
  const stateDir = option('state-dir')
  if (!stateDir) {
    console.error('usage: node scripts/archive-state.mjs --state-dir <dir> [--database <path>] [--keep <n>] [--out <dir>]')
    process.exit(2)
  }
  const keep = option('keep') === undefined ? 5 : Number(option('keep'))
  if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep must be a non-negative integer')
  const result = archive(stateDir, { keep, ...(option('database') ? { database: option('database') } : {}),
    ...(option('out') ? { out: option('out') } : {}) })
  console.log(`archived ${result.file}${result.pruned.length ? `, pruned ${result.pruned.length} old archive(s)` : ''}`)
}

if (process.argv[1] && /archive-state\.mjs$/.test(process.argv[1])) main()
