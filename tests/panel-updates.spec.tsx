// @vitest-environment jsdom
// The Updates page: the supervisor-owned pointers, the journal steps, the deploy hint, the append-only history, the Overview
// "needs you" row that links here, and the one confirmed rollback request the panel may queue (ADR-0007).
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, find, tab, click, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const history = (overrides: Record<string, unknown> = {}) => ({
  api: 1 as const,
  id: 'upd-1',
  action: 'apply' as const,
  outcome: 'applied' as const,
  version: '0.5.0',
  from: '0.4.0',
  phase: 'commit' as const,
  reason: null,
  at: '2026-11-11T10:00:00.000Z',
  durationMs: 1200,
  ...overrides,
})

it('shows the current and previous runtime, the deploy hint, the journal and the recent history', async () => {
  server.updates = {
    ...server.updates,
    previous: { version: '0.4.0', entry: 'runtime-entry.js', hostApi: 1, sha256: 'b'.repeat(64), schema: 25 },
    journal: { status: 'committed', operation: 'update', phase: 'commit', updatedAt: '2026-11-11T10:00:00.000Z',
      steps: [
        { phase: 'prepare', state: 'done', at: '2026-11-11T09:59:55.000Z' },
        { phase: 'backup', state: 'done', at: '2026-11-11T09:59:56.000Z', detail: 'runtime/backups/0.5.0-1.sqlite' },
        { phase: 'swap', state: 'done', at: '2026-11-11T09:59:58.000Z' },
        { phase: 'init', state: 'done', at: '2026-11-11T09:59:59.000Z' },
        { phase: 'commit', state: 'done', at: '2026-11-11T10:00:00.000Z' },
      ] },
    history: [history(), history({ id: 'upd-0', action: 'rollback', outcome: 'rolledback', version: '0.4.0', from: '0.5.0',
      phase: 'rollback', reason: 'the 0.5.0 runtime exited during init' })] as never,
  }
  await mount()
  await click(tab(zh['tab.updates']))
  const page = document.querySelector('[data-updates]')!
  expect(text()).toContain(zh.updatesTitle)
  expect(page.textContent).toContain(server.updates.current!.version)
  expect(page.textContent).toContain(server.updates.previous!.version)
  expect(page.textContent).toContain(zh.updateCurrent)
  expect(page.textContent).toContain(zh.updatePrevious)
  expect(page.querySelector('[data-update-command]')!.textContent).toContain('deploy-runtime.mjs')
  const journal = page.querySelector('[data-update-journal]')!
  expect(journal.textContent).toContain(zh['updatePhase.backup'])
  expect(journal.textContent).toContain(zh['updateStepState.done'])
  expect(journal.textContent).toContain('runtime/backups/0.5.0-1.sqlite')
  expect(journal.textContent).toContain(zh['updateJournalOperation.update'])
  const rows = page.querySelectorAll('[data-update-history-row]')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.textContent).toContain(zh['updateAction.apply'])
  expect(rows[0]!.textContent).toContain(zh['updateOutcome.applied'])
  expect(rows[1]!.textContent).toContain(zh['updateOutcome.rolledback'])
  expect(rows[1]!.textContent).toContain('the 0.5.0 runtime exited during init')
  expect(server.requests.some(item => item.method === 'GET' && item.path === 'updates')).toBe(true)
  // The page is read-only apart from the confirmed rollback: no upload or code route exists.
  expect(server.requests.every(item => !/upload|download|runtime-entry/i.test(item.path))).toBe(true)
})

it('queues one rollback only after the confirmation and shows the pending request', async () => {
  server.updates = { ...server.updates,
    previous: { version: '0.4.0', entry: 'runtime-entry.js', hostApi: 1, sha256: 'b'.repeat(64), schema: 25 },
    rollback: { eligible: true, version: '0.4.0', reason: '' } }
  await mount()
  await click(tab(zh['tab.updates']))
  await click(find(zh.updateRollbackAction, '[data-update-rollback] button'))
  expect(server.requests.some(item => item.method === 'POST' && item.path === 'updates/rollback')).toBe(false)
  expect(text()).toContain(zh.updateRollbackConfirm)
  await click(find(zh.updateRollbackConfirmAction, '[data-update-rollback-confirm] button'))
  expect(server.requests.some(item => item.method === 'POST' && item.path === 'updates/rollback'
    && (item.body as { confirm?: string }).confirm === 'ROLLBACK')).toBe(true)
  expect(document.querySelector('[data-update-queued]')!.textContent).toContain('rollback-1')
  // The fixture leaves the request pending, so the page now shows it and offers no second action.
  expect(document.querySelector('[data-update-pending]')!.textContent).toContain(zh.updatePending)
  expect(document.querySelector('[data-update-pending]')!.textContent).toContain('rollback-1')
  expect(document.querySelector('[data-update-rollback] button')).toBeNull()
})

it('keeps the failure of a refused rollback on the page instead of claiming it was queued', async () => {
  server.updates = { ...server.updates,
    previous: { version: '0.4.0', entry: 'runtime-entry.js', hostApi: 1, sha256: 'b'.repeat(64), schema: 25 },
    rollback: { eligible: true, version: '0.4.0', reason: '' } }
  await mount()
  await click(tab(zh['tab.updates']))
  // A supervisor that starts an update after the page loaded refuses the request; nothing is queued.
  server.updates = { ...server.updates, busy: true }
  await click(find(zh.updateRollbackAction, '[data-update-rollback] button'))
  await click(find(zh.updateRollbackConfirmAction, '[data-update-rollback-confirm] button'))
  const alert = document.querySelector('[data-update-rollback] [role="alert"]')!
  expect(alert.textContent).toContain(zh.updateRollbackFailed.replace('{message}',
    'An update is already in progress; wait for it to finish before rolling back.'))
  expect(document.querySelector('[data-update-queued]')).toBeNull()
})

it('surfaces a pending runtime update on the Overview and links it to the Updates page', async () => {
  server.updateAttention = { pending: true, failed: false, version: '0.5.0', phase: 'swap', reason: null }
  await mount()
  expect(text()).toContain(zh.updatesNeedsYou)
  const row = document.querySelector('[data-overview-update]')!
  expect(row.textContent).toContain(zh.updateAttentionPending)
  expect(row.textContent).toContain('0.5.0')
  expect(row.textContent).toContain(zh['updatePhase.swap'])
  await click(row.querySelector('.dt-open')!)
  expect(server.requests.some(item => item.method === 'GET' && item.path === 'updates')).toBe(true)
})
