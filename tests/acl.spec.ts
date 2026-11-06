import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { restrictToOwner } from '../src/infra/acl.ts'

const windows = process.platform === 'win32'
const directories: string[] = []
const temporary = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-acl-'))
  directories.push(directory)
  return directory
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** The access rules Windows reports for a path, as `icacls` prints one line per rule after the path line. */
function rules(path: string): string[] {
  return execFileSync('icacls', [path], { encoding: 'utf8' }).split(/\r?\n/)
    // An access rule line names an account and then its parenthesized rights and flags.
    .filter(line => /:\(/.test(line))
}

it.skipIf(!windows)('gives a directory and a file an owner-only ACL on Windows, where POSIX modes do nothing', () => {
  const directory = temporary()
  const database = join(directory, 'orchestrator.sqlite')
  writeFileSync(database, '')
  restrictToOwner(directory, true)
  restrictToOwner(database)
  const owner = execFileSync('whoami', [], { encoding: 'utf8' }).trim()
  for (const path of [directory, database]) {
    const entries = rules(path)
    // Every rule belongs to the owner and none is inherited from the parent directory: the owner's full control is all that is left.
    expect(entries.length, path).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.toUpperCase(), path).toContain(owner.toUpperCase())
      expect(entry, path).not.toContain('(I)')
      expect(entry, path).toContain('(F)')
    }
  }
})

it.skipIf(!windows)('a Store gives its directory and database an owner-only ACL on Windows', () => {
  const directory = temporary()
  const path = join(directory, 'state', 'orchestrator.sqlite')
  new Store(path).close()
  const owner = execFileSync('whoami', [], { encoding: 'utf8' }).trim().toUpperCase()
  for (const target of [dirname(path), path]) {
    const entries = rules(target)
    expect(entries.length, target).toBeGreaterThan(0)
    // The state is the operator's alone: no rule inherited from the parent, and full control for the owner only.
    for (const entry of entries) {
      expect(entry.toUpperCase(), target).toContain(owner)
      expect(entry, target).not.toContain('(I)')
      expect(entry, target).toContain('(F)')
    }
  }
})

it.skipIf(windows)('gives a directory and a file the POSIX modes the state directory expects', () => {
  const directory = temporary()
  const database = join(directory, 'orchestrator.sqlite')
  writeFileSync(database, '')
  restrictToOwner(directory, true)
  restrictToOwner(database)
  expect([statSync(directory).mode & 0o777, statSync(database).mode & 0o777]).toEqual([0o700, 0o600])
})
