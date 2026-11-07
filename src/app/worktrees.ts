/** Reclaims the worktrees and branches of Tickets that ended longer ago than the operator's retention. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Settings } from '../policy.ts'
import type { Store } from './store.ts'

const run = promisify(execFile)
const DAY = 24 * 60 * 60_000

/** What one reclaim pass did (or would have done) for a Ticket. */
export interface Reclaimed {
  ticketId: string
  directory: string
  branch?: string
  removed: boolean
  kept?: string
  error?: string
}

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', directory, ...args], { timeout: 60_000, windowsHide: true })
  return stdout.trim()
}

/** Only paths under the work root are ours to remove; the operator may have pointed `directory` elsewhere. */
function inside(root: string, directory: string): boolean {
  const path = resolve(directory)
  return path.startsWith(root + sep)
}

/**
 * Removes the worktree and `agent/` branch of every ended Ticket whose end is older than
 * `executor.worktreeKeepDays`, so a long-lived deployment does not accumulate checkouts. A Ticket with
 * retention 0 is always kept; a directory outside `<stateDir>/work` is never touched.
 */
export async function reclaimWorktrees(options: {
  store: Store
  settings: Settings
  stateDir: string
  now?: number
}): Promise<Reclaimed[]> {
  const { store, settings, stateDir } = options
  const now = options.now ?? Date.now()
  const keep = settings.executor.worktreeKeepDays
  const root = resolve(join(stateDir, 'work'))
  const done: Reclaimed[] = []
  for (const ticket of store.tickets.list()) {
    const directory = ticket.execution?.directory
    const ended = ticket.ended
    if (!ended || !directory || !inside(root, directory)) continue
    const result: Reclaimed = { ticketId: ticket.id, directory, removed: false }
    if (keep === 0) done.push({ ...result, kept: 'the operator keeps worktrees' })
    else if (Date.parse(ended.at) + keep * DAY > now) done.push({ ...result, kept: `kept for ${keep} days after its end` })
    else if (!existsSync(directory)) done.push(result)
    else {
      try {
        const branch = await git(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])
        const clone = resolve(directory, await git(directory, ['rev-parse', '--git-common-dir']))
        await git(clone, ['worktree', 'remove', '--force', directory])
        if (branch.startsWith('agent/')) {
          result.branch = branch
          await git(clone, ['branch', '-D', branch]).catch(() => '')
        }
        result.removed = true
      } catch (error) {
        // A half-removed worktree is better removed than left: drop the directory and let git prune its record.
        result.error = String((error as { stderr?: string }).stderr ?? error).trim().split('\n')[0]
        await rm(directory, { recursive: true, force: true }).catch(() => {})
      }
      done.push(result)
    }
  }
  return done
}
