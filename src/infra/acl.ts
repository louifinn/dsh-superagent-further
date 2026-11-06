/**
 * Windows ignores POSIX modes, so `mkdirSync(…, { mode: 0o700 })` and `chmodSync(…, 0o600)` leave the state directory and
 * database readable by every account the parent directory grants. These helpers give them an owner-only ACL instead, which is
 * the Windows equivalent of the mode the rest of the code asks for.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'

let owner: string | undefined
/** The current user's security identifier, in the `*S-1-5-…` form `icacls` resolves without depending on account-name syntax. */
function ownerSid(): string {
  if (owner !== undefined) return owner
  const csv = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
  const sid = /(S-1-[\d-]+)/.exec(csv)?.[1]
  if (!sid) throw new Error('whoami did not report the current user\'s security identifier')
  return owner = `*${sid}`
}
/**
 * Makes `path` accessible to this process's user only: the POSIX mode on Unix, an ACL that drops inherited grants and gives
 * the owner full control on Windows. A directory passes its owner-only ACL on to files created inside it.
 * @throws When Windows refuses the ACL change; the caller keeps running with the path's inherited permissions and reports it.
 */
export function restrictToOwner(path: string, directory = false): void {
  if (process.platform !== 'win32') { chmodSync(path, directory ? 0o700 : 0o600); return }
  // `/inheritance:r` removes grants inherited from the parent; `/grant:r` replaces any grant the owner already had.
  execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${ownerSid()}:${directory ? '(OI)(CI)' : ''}F`], { stdio: 'ignore' })
}
