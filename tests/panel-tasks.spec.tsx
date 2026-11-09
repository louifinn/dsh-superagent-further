// @vitest-environment jsdom
// The Automations page: both scopes, the human schedule, enabling, the create/edit forms and the missing-service state.
import { expect, it } from 'vitest'
import type { ApiResponse } from '../src/app/api.ts'
import { zh } from '../src/client/locales.ts'
import { all, click, field, find, mount, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
type Row = ApiResponse<'GET automations'>['items'][number]

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, scope: 'installation', project: '', report_only: false, title: `Task ${id}`, instruction: `Instruction ${id}.`,
  rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY', enabled: true, orphaned: false, host_status: 'active',
  next_at: '2026-11-10T09:00:00.000Z', last_delivery_at: null, last_error: null, revision: 0,
  created_at: '2026-11-09T12:00:00.000Z', updated_at: '2026-11-09T12:00:00.000Z', dsh_task: 'schedule-1',
  target_session: 'master', history: [], ...over,
})

function projects() {
  server.settings = { ...server.settings, executor: { ...server.settings.executor,
    projects: [{ id: 'app', name: '应用', workspace: '/srv/app', repository: 'acme/app', branch: '' }] } }
}

it('lists installation and project tasks with scope, schedule, orphan warning and last delivery', async () => {
  projects()
  server.automations = [
    row('auto-00000001'),
    row('auto-00000002', { scope: 'project', project: 'app', report_only: true, target_session: 'lead-app',
      title: '项目巡检', last_delivery_at: '2026-11-08T09:00:00.000Z' }),
    row('auto-00000003', { scope: 'project', project: 'app', report_only: true, target_session: 'lead-app', orphaned: true,
      enabled: false, last_error: 'The Host task is missing' }),
  ]
  await mount()
  await click(tab(zh['tab.tasks']))
  expect(all('[data-automation]')).toHaveLength(3)
  expect(text()).toContain(zh['automationScope.installation'])
  expect(text()).toContain(`${zh['automationScope.project']} · 应用`)
  expect(text()).toContain('每天 09:00')
  expect(text()).toContain(zh.automationOrphaned)
  expect(text()).toContain('The Host task is missing')
  expect(text()).toContain(zh.automationNever)
  // The panel offers run, edit and delete; enabled stays a switch, not a button.
  expect(all('[data-automations] button').map(button => button.textContent)).not.toContain(zh.automationEnabled)
})

it('creates a project task from the form, sending the project and the report-only scope to the API', async () => {
  projects()
  await mount()
  await click(tab(zh['tab.tasks']))
  await type(field<HTMLSelectElement>(zh.automationScopeLabel), 'project')
  await type(field<HTMLSelectElement>(zh.automationProjectLabel), 'app')
  await type(field<HTMLInputElement>(zh.automationTitleLabel), '每周汇报')
  await type(field<HTMLTextAreaElement>(zh.automationInstructionLabel), 'Report the week.')
  await click(find(zh.automationCreate))
  expect(server.automations).toHaveLength(1)
  expect(server.automations[0]).toMatchObject({ scope: 'project', project: 'app', report_only: true, title: '每周汇报',
    instruction: 'Report the week.', enabled: true, target_session: 'lead-app' })
  const posted = server.requests.find(request => request.method === 'POST' && request.path === 'automations')
  expect(posted?.body).toMatchObject({ title: '每周汇报', project: 'app', enabled: true })
  expect(text()).toContain('每周汇报')
})

it('edits a task without re-targeting it, and toggles enabled from the table', async () => {
  projects()
  server.automations = [row('auto-00000001', { title: 'Old title', instruction: 'Old instruction.',
    rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=WEEKLY' })]
  await mount()
  await click(tab(zh['tab.tasks']))
  await click(find(zh.automationEdit))
  // The edit form carries the stored instruction and rule, and offers no scope or project control.
  expect(field<HTMLInputElement>(zh.automationTitleLabel).value).toBe('Old title')
  expect(field<HTMLTextAreaElement>(zh.automationInstructionLabel).value).toBe('Old instruction.')
  expect(text()).toContain(zh.automationNoRetarget)
  await type(field<HTMLInputElement>(zh.automationTitleLabel), 'New title')
  await type(field<HTMLTextAreaElement>(zh.automationInstructionLabel), 'New instruction.')
  await click(find(zh.automationSave))
  expect(server.automations[0]).toMatchObject({ title: 'New title', instruction: 'New instruction.', revision: 1 })
  const saved = server.requests.find(request => request.method === 'PUT' && request.path === 'automations/auto-00000001')
  expect(saved?.body).toMatchObject({ expected_revision: 0, title: 'New title', instruction: 'New instruction.' })
  // The table switch is the first switch; the edit form's own switch comes after it.
  await click(all('[data-automation] [role="switch"]')[0]!)
  expect(server.automations[0]!.enabled).toBe(false)
  expect(server.requests.some(request => request.method === 'PUT' && request.body
    && (request.body as { enabled?: boolean }).enabled === false)).toBe(true)
})

it('shows the recent delivery history and flags an error without any other notice channel', async () => {
  server.automations = [
    row('auto-00000001', {
      last_delivery_at: '2026-11-09T08:00:00.000Z',
      last_error: 'The Host task changed outside this plugin; review its schedule before editing again',
      history: [
        { at: '2026-11-09T08:05:00.000Z', kind: 'orphaned', scheduled_at: '2026-11-10T09:00:00.000Z',
          delivered_at: null, message_id: null, error: 'The Host task ended' },
        { at: '2026-11-09T08:00:00.000Z', kind: 'delivered', scheduled_at: '2026-11-09T08:00:00.000Z',
          delivered_at: '2026-11-09T08:00:00.000Z', message_id: 'm1', error: null },
      ],
    }),
    row('auto-00000002'),
  ]
  await mount()
  await click(tab(zh['tab.tasks']))
  // The attention count is the page badge; this mission does not touch the tab bar.
  expect(all('ul[data-attention="1"]')).toHaveLength(1)
  expect(document.querySelector('[data-attention-item="auto-00000001"]')?.textContent)
    .toContain('The Host task changed outside this plugin')
  expect(document.querySelector('[data-automation="auto-00000001"]')?.getAttribute('data-attention')).toBe('true')
  expect(document.querySelector('[data-automation="auto-00000002"]')?.getAttribute('data-attention')).toBeNull()
  // The error reason is visible while the task is not orphaned; the old page showed it only for orphans.
  expect(document.querySelector('[data-automation="auto-00000001"] [data-automation-reason]')?.textContent)
    .toContain('The Host task changed outside this plugin')
  const history = document.querySelector('[data-delivery-history="auto-00000001"]')!
  expect(history.querySelectorAll('li')).toHaveLength(2)
  // Newest first: the orphan event precedes the delivered one.
  expect(history.querySelectorAll('li')[0]!.textContent).toContain(zh.automationOrphaned)
  expect(history.querySelectorAll('li')[1]!.textContent).toContain(zh.automationDelivered)
  expect(history.textContent).toContain('The Host task ended')
  expect(text()).toContain(zh.automationAttentionHint)
  expect(text()).toContain(zh.automationHistoryEmpty)
})

it('reports that the Host schedule service is unavailable instead of failing', async () => {
  server.automationService = false
  await mount()
  await click(tab(zh['tab.tasks']))
  expect(text()).toContain(zh.automationUnavailable)
  expect(all('[data-automations]')).toHaveLength(0)
  expect(text()).not.toContain(zh.automationCreateTitle)
})

it('runs one task now, records the delivery, and surfaces a Host refusal as a page error', async () => {
  server.automations = [row('auto-00000001'), row('auto-00000002')]
  server.automationBusy = 'auto-00000002'
  await mount()
  await click(tab(zh['tab.tasks']))
  const runs = () => all('[data-automation] button').filter(button => button.textContent === zh.automationRun)
  expect(runs()).toHaveLength(2)
  await click(runs()[0]!)
  expect(server.requests.some(request => request.method === 'POST' && request.path === 'automations/auto-00000001/run'))
    .toBe(true)
  expect(text()).toContain(zh.automationRanNotice)
  expect(server.automations[0]!.last_delivery_at).not.toBeNull()
  expect(server.automations[0]!.history[0]).toMatchObject({ kind: 'delivered', message_id: 'message-run' })
  await click(runs()[1]!)
  expect(text()).toContain('already queued or running')
  expect(server.automations[1]!.last_delivery_at).toBeNull()
})

it('deletes a task only after the confirmation dialog and reports it', async () => {
  server.automations = [row('auto-00000001')]
  await mount()
  await click(tab(zh['tab.tasks']))
  const deletes = all('[data-automation] button').filter(button => button.textContent === zh.automationDelete)
  expect(deletes).toHaveLength(1)
  await click(deletes[0]!)
  expect(text()).toContain(zh.automationDeleteMessage)
  expect(server.automations).toHaveLength(1)
  await click(zh.confirm)
  expect(server.requests.some(request => request.method === 'DELETE' && request.path === 'automations/auto-00000001'))
    .toBe(true)
  expect(server.automations).toHaveLength(0)
  expect(all('[data-automation]')).toHaveLength(0)
  expect(text()).toContain(zh.automationDeletedNotice)
})
