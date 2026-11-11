/** `scripts/archive-state.mjs` against a temporary state database. */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error a plain Node script without a declaration file
import { archive, archives } from '../scripts/archive-state.mjs'

const roots: string[] = []
function root() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-archive-'))
  roots.push(directory)
  return directory
}
function state(directory: string, name = 'orchestrator.sqlite'): string {
  const database = new DatabaseSync(join(directory, name))
  database.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('schema', '22')
  database.close()
  return join(directory, name)
}
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('archive state', () => {
  it('writes a consistent copy with the schema row, and names it by UTC time', () => {
    const directory = root()
    state(directory)
    const result = archive(directory, { now: new Date('2026-11-10T08:30:05.042Z') })
    expect(result.file.replaceAll('\\', '/')).toMatch(/\/archive\/state-2026-11-10T08-30-05-042Z\.sqlite$/)
    expect(result.pruned).toEqual([])
    const copy = new DatabaseSync(result.file, { readOnly: true })
    try {
      expect(copy.prepare('SELECT value FROM kv WHERE key = ?').get('schema')).toEqual({ value: '22' })
    } finally {
      copy.close()
    }
    expect(archives(join(directory, 'archive'))).toHaveLength(1)
  })
  it('prunes the oldest archives beyond keep', () => {
    const directory = root()
    state(directory)
    archive(directory, { now: new Date('2026-11-10T08:00:00.000Z') })
    archive(directory, { now: new Date('2026-11-10T08:00:01.000Z') })
    const result = archive(directory, { keep: 2, now: new Date('2026-11-10T08:00:02.000Z') })
    expect(result.pruned).toEqual(['state-2026-11-10T08-00-00-000Z.sqlite'])
    expect(archives(join(directory, 'archive'))).toHaveLength(2)
  })
  it('keeps every archive when keep is zero or larger than the count', () => {
    const directory = root()
    state(directory)
    for (let index = 0; index < 3; index += 1) archive(directory, { keep: 10, now: new Date(2026, 10, 10, 8, 0, index) })
    expect(readdirSync(join(directory, 'archive'))).toHaveLength(3)
  })
  it('archives the orchestrator database by default, not the retired state.sqlite name', () => {
    const directory = root()
    // A leftover state.sqlite must not be mistaken for the Host's database: the default names orchestrator.sqlite.
    state(directory, 'state.sqlite')
    expect(() => archive(directory)).toThrow(/orchestrator\.sqlite/)
    state(directory)
    expect(archive(directory, { now: new Date('2026-11-10T08:30:05.042Z') }).file.replaceAll('\\', '/'))
      .toMatch(/\/archive\/state-2026-11-10T08-30-05-042Z\.sqlite$/)
  })
  it('copies the database named by an explicit --database override', () => {
    const directory = root()
    const database = state(directory, 'custom.sqlite')
    const result = archive(directory, { database, now: new Date('2026-11-10T08:30:05.042Z') })
    expect(result.file.replaceAll('\\', '/')).toMatch(/\/archive\/state-2026-11-10T08-30-05-042Z\.sqlite$/)
    const copy = new DatabaseSync(result.file, { readOnly: true })
    try {
      expect(copy.prepare('SELECT value FROM kv WHERE key = ?').get('schema')).toEqual({ value: '22' })
    } finally {
      copy.close()
    }
  })
})
