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
  const directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-further-acl-'))
  directories.push(directory)
  return directory
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** An account Windows grants, and the right it grants, as one access rule of `icacls`. */
type Rule = { account: string; rights: string }

/**
 * The access rules Windows reports for a path.
 *
 * `icacls` prints the path and the first rule on one line, so a rule is found by its own shape: an account — a
 * `DOMAIN\name`, `NT AUTHORITY\name`, `BUILTIN\name` or an `S-1-5-…` SID — a colon and its parenthesized rights.
 * A path never matches: its drive-colon is followed by a separator, not by a parenthesized right.
 */
function rules(path: string): Rule[] {
  const text = execFileSync('icacls', [path], { encoding: 'utf8' })
  const found: Rule[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!/:\(/.test(raw)) continue
    // `icacls` prints the path and the first rule on the same line, so drop the path before looking for a rule.
    const line = raw.startsWith(path) ? raw.slice(path.length) : raw
    for (const match of line.matchAll(/([^:\r\n]+?):((?:\([A-Za-z,]+\))+)/g)) {
      found.push({ account: match[1]!.trim(), rights: match[2]! })
    }
  }
  return found
}

/** Accounts Windows always reaches, whatever a directory grants: they do not weaken the owner's control. */
const alwaysAllowed = (account: string): boolean =>
  ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\ADMINISTRATORS'].includes(account.toUpperCase())

function expectOwnerOnly(path: string, owner: string): void {
  const entries = rules(path)
  expect(entries.length, path).toBeGreaterThan(0)
  // The operator holds full control…
  expect(entries.filter(entry => entry.account.toUpperCase() === owner && entry.rights.includes('(F)')), path).toHaveLength(1)
  for (const entry of entries) {
    // …no rule is inherited from the parent directory, and no other account but the system's own keeps access.
    expect(entry.rights, path).not.toContain('(I)')
    if (entry.account.toUpperCase() !== owner) expect(alwaysAllowed(entry.account), `${path}: ${entry.account}`).toBe(true)
  }
}

it.skipIf(!windows)('gives a directory and a file an owner-only ACL on Windows, where POSIX modes do nothing', () => {
  const directory = temporary()
  const database = join(directory, 'orchestrator.sqlite')
  writeFileSync(database, '')
  restrictToOwner(directory, true)
  restrictToOwner(database)
  const owner = execFileSync('whoami', [], { encoding: 'utf8' }).trim().toUpperCase()
  for (const path of [directory, database]) expectOwnerOnly(path, owner)
})

it.skipIf(!windows)('a Store gives its directory and database an owner-only ACL on Windows', () => {
  const directory = temporary()
  const path = join(directory, 'state', 'orchestrator.sqlite')
  new Store(path).close()
  const owner = execFileSync('whoami', [], { encoding: 'utf8' }).trim().toUpperCase()
  for (const target of [dirname(path), path]) expectOwnerOnly(target, owner)
})

it.skipIf(windows)('gives a directory and a file the POSIX modes the state directory expects', () => {
  const directory = temporary()
  const database = join(directory, 'orchestrator.sqlite')
  writeFileSync(database, '')
  restrictToOwner(directory, true)
  restrictToOwner(database)
  expect([statSync(directory).mode & 0o777, statSync(database).mode & 0o777]).toEqual([0o700, 0o600])
})
