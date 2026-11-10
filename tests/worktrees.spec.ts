import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reclaimWorktrees } from '../src/app/worktrees.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'

const created: string[] = []
afterEach(() => { for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }) })

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A clone with one commit, and a ticket worktree on a fresh `agent/` branch, laid out as the Executor creates them. */
function checkout(root: string): { clone: string; stateDir: string; worktree: string; branch: string } {
  const clone = join(root, 'clone')
  mkdirSync(clone, { recursive: true })
  git(clone, 'init', '-b', 'main')
  git(clone, 'config', 'user.email', 'test@example.com')
  git(clone, 'config', 'user.name', 'Test')
  writeFileSync(join(clone, 'README.md'), 'clone\n')
  git(clone, 'add', '.')
  git(clone, 'commit', '-m', 'first')
  const stateDir = join(root, 'state')
  const worktree = join(stateDir, 'work', 'app', 'add-one')
  const branch = 'agent/add-one'
  git(clone, 'worktree', 'add', '-b', branch, worktree, 'HEAD')
  return { clone, stateDir, worktree, branch }
}

function endedTicket(id: string, directory: string, at: string): Ticket {
  return {
    id, title: 'one', decisionId: 'd',
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_person' }, scope: 'add one' },
    deliverable: 'change',
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
    execution: { name: 'add-one', directory, assignment: 'work' },
    origin: { triggerId: 'x', triggerIds: [] },
    ended: { at, by: 'executor', cause: 'merge', outcome: 'merged' },
  }
}

function setup(root: string, keepDays = 7): { store: Store; stateDir: string; clone: string; worktree: string } {
  const { clone, stateDir, worktree } = checkout(root)
  const store = new Store(join(stateDir, 'orchestrator.sqlite'), () => {})
  store.saveSettings(SettingsSchema.parse({ executor: { worktreeKeepDays: keepDays } }))
  return { store, stateDir, clone, worktree }
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString()

describe('worktree cleanup', () => {
  it('removes the worktree and agent branch of a Ticket that ended past the retention', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-worktrees-')))
    created.push(root)
    const { store, stateDir, clone, worktree } = setup(root)
    store.tickets.save(endedTicket('t1', worktree, daysAgo(8)))
    const done = await reclaimWorktrees({ store, settings: store.settings(), stateDir })
    expect(done).toEqual([expect.objectContaining({ ticketId: 't1', removed: true, branch: 'agent/add-one' })])
    expect(existsSync(worktree)).toBe(false)
    expect(git(clone, 'worktree', 'list')).not.toContain(worktree)
    expect(git(clone, 'branch', '--list', 'agent/add-one').trim()).toBe('')
    store.close()
  }, 60_000)
  it('keeps the worktree of a Ticket that ended recently, and of one whose retention is 0', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-worktrees-')))
    created.push(root)
    const { store, stateDir, worktree } = setup(root)
    store.tickets.save(endedTicket('t1', worktree, daysAgo(1 / 24)))
    const done = await reclaimWorktrees({ store, settings: store.settings(), stateDir })
    expect(done).toEqual([expect.objectContaining({ ticketId: 't1', removed: false })])
    expect(existsSync(worktree)).toBe(true)
    // Retention 0 keeps finished checkouts for good.
    store.saveSettings(SettingsSchema.parse({ executor: { worktreeKeepDays: 0 } }))
    const again = await reclaimWorktrees({ store, settings: store.settings(), stateDir })
    expect(again).toEqual([expect.objectContaining({ ticketId: 't1', removed: false, kept: 'the operator keeps worktrees' })])
    expect(existsSync(worktree)).toBe(true)
    store.close()
  }, 60_000)
  it('never touches a directory the operator placed outside <stateDir>/work', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-worktrees-')))
    created.push(root)
    const { store, stateDir } = setup(root)
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.txt'), 'keep\n')
    store.tickets.save(endedTicket('t2', outside, daysAgo(30)))
    expect(await reclaimWorktrees({ store, settings: store.settings(), stateDir })).toEqual([])
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    store.close()
  }, 60_000)
})
