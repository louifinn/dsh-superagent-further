// @vitest-environment jsdom
// The Settings groups, drafts, save bars and history.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Fields } from '../src/client/settings-kit.tsx'
import { expect, it, onTestFinished } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('keeps a person\'s own value where another save changed the same setting, and says so', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  server.settings = { ...server.settings, executor: { ...server.settings.executor, maxWorkers: 4 } }
  server.revisions.executor = 1
  await click(zh.save)
  expect(document.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe(zh.saveConflict)
  expect(field<HTMLInputElement>(zh.maxWorkers).value).toBe('6')
  await click(zh.save)
  expect(server.settings.executor.maxWorkers).toBe(6)
})

it('saves the Eval block on the Policy settings and the Executor with its execution environment on the Execution settings, each against its own revision', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh['mode.auto'])
  await type(field<HTMLInputElement>(zh.evalTimeout), '180')
  const [provider, model] = all('.dt-model input')
  await type(provider as HTMLInputElement, 'worker-provider'); await type(model as HTMLInputElement, 'worker-model')
  await click(zh.save)
  expect(server.settings.eval).toEqual({ mode: 'auto', timeoutSeconds: 180, model: { provider: 'worker-provider', model: 'worker-model' } })
  await click(find(zh['promptPart.runtime/work'], '.dt-settings-link'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '5')
  // An empty root uses the default directory, which the field names instead of looking set.
  expect(field<HTMLInputElement>(zh.executionDirectory).closest('.dt-field')!.querySelector('small')?.textContent).toBe('留空时用 /srv/dsh-superagent-further/work')
  await type(field<HTMLInputElement>(zh.executionDirectory), '/srv/work')
  // A variable picked from the list goes where the caret is in the prepare command.
  const prepare = field<HTMLTextAreaElement>(zh.prepareCommand)
  await type(prepare, 'git worktree add ')
  prepare.setSelectionRange(17, 17)
  await click('可用的环境变量 3')
  expect(all('.dt-table tbody tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR工单的执行目录执行器', 'DSH_SUPERAGENT_NAME工单短名执行器',
    'DSH_SUPERAGENT_GITHUB_REPOSITORY仓库GitHub · 已关闭'])
  await click('DSH_SUPERAGENT_DIR')
  expect(field<HTMLTextAreaElement>(zh.prepareCommand).value).toBe('git worktree add "$DSH_SUPERAGENT_DIR"')
  await type(field<HTMLInputElement>(zh.blockedCommands), 'gh-personal  gh.other')
  const [workerProvider, workerModel, effort] = all('.dt-model input')
  await type(workerProvider as HTMLInputElement, 'worker-provider'); await type(workerModel as HTMLInputElement,
    'worker-model'); await type(effort as HTMLInputElement, 'high')
  expect([...document.querySelectorAll('#dt-worker-model-efforts option')].map(option => option.getAttribute('value'))).toEqual(['high'])
  await click(zh.save)
  expect(server.settings.executor).toEqual({ maxWorkers: 5, projectWorkers: 2, directory: '/srv/work',
    prepare: 'git worktree add "$DSH_SUPERAGENT_DIR"', blockedCommands: ['gh-personal', 'gh.other'], projects: [], worktreeKeepDays: 7,
    model: { provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'high' } })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/eval',
    'settings/executor'])
})

it('loads configuration history on demand with localized changes, Source field labels and notified Tickets', async () => {
  server.history = { current: 3, policyVersion: 'abcdef1234567890', items: [{ revision: 3, savedAt: '2026-09-22T00:00:00Z',
    source: 'sync', policyVersion: 'abcdef1234567890', policyChanged: true, notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
    changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceRowsAdded', source: 'feishu', field: 'allowed', items: ['Bob'],
      part: true }, { code: 'sourceField', source: 'feishu', field: 'syncChat', from: '', to: 'oc_team', part: true }] }] }
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(server.requests.some(request => request.path === 'policy/history')).toBe(false)
  await click(zh.configHistory)
  for (const expected of ['第 3 次保存 · 从群同步', '生成策略版本 abcdef12', '接单模式：关闭 → 仅观察', '飞书 · 能发起工作的飞书用户 新增：Bob', '飞书 · 同步来源群：未设置 → oc_team',
    '因策略变更通知了 1 个进行中的工单：修复回归']) expect(text()).toContain(expected)
})

it('shows save and discard only while a settings block has edits, at the end of that block', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  expect(all('.dt-savebar')).toHaveLength(1)
  await type(field<HTMLInputElement>(zh.maxWorkers), '3')
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  await click(zh.discard)
  expect(all('.dt-savebar')).toHaveLength(0)
  // A save submitted from a field keeps the focus there; one from the bar hands it to the block when the bar closes.
  const workers = field<HTMLInputElement>(zh.maxWorkers)
  await type(workers, '5')
  workers.focus()
  await act(async () => { workers.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.executor.maxWorkers).toBe(5)
  expect(document.activeElement).toBe(workers)
  await type(workers, '4')
  const save = find(zh.save)
  save.focus()
  await click(save)
  expect(all('.dt-savebar')).toHaveLength(0)
  expect(document.activeElement).toBe(workers.form)
  await click(find(zh['term.source'], '.dt-settings-link'))
  expect(all('.dt-savebar')).toHaveLength(0)
  const github = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), 'gh-other')
  expect(github.lastElementChild!.classList.contains('dt-savebar')).toBe(true)
  // The agent CLI is read by setup, so the bar warns that saving restarts dsh-superagent-further and interrupts running work.
  expect(github.lastElementChild!.textContent).toContain('2 个进行中的派工会中断')
})

it('lists every repository the GitHub Source watches, with the first project as the primary', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, projects: [
    { id: 'app', name: 'App', workspace: '/w/app', repository: 'owner/app', branch: '' },
    { id: 'lib', name: 'Lib', workspace: '/w/lib', repository: 'acme/widgets', branch: '' },
  ] } }
  onTestFinished(() => { server.settings = { ...server.settings, executor: { ...server.settings.executor, projects: [] } } })
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['term.source'], '.dt-settings-link'))
  const github = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  expect([...github.querySelectorAll('.dt-mono')].map(node => node.textContent)).toEqual(['owner/app', 'acme/widgets'])
  expect(github.textContent).toContain(zh['sourceWatchedPrimary'])
  expect(github.textContent).toContain('Lib')
})

it('gives the focus back to the field that had it once a block\'s save ends', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const render = (disabled: boolean) => act(async () => { root.render(<Fields disabled={disabled}><input aria-label="value" /></Fields>) })
  await render(false)
  const input = container.querySelector('input')!
  input.focus()
  await render(true)
  // jsdom does not blur a control when it becomes disabled; move focus away manually.
  const elsewhere = document.createElement('button'); document.body.append(elsewhere); elsewhere.focus(); elsewhere.remove()
  expect(document.activeElement).toBe(document.body)
  await render(false)
  expect(document.activeElement).toBe(input)
})

it('lists the settings groups stages first, opens each stage\'s group from its status, and returns to the last group opened',
  async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual(['来源', '评估', '执行', '语言', '提示词', '部署'])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  for (const [tab, group] of [['来源', '来源'], ['评估', '评估'], ['执行', '执行']] as const) {
    await click(find(tab, '[role="tab"]'))
    await click(find(zh['tab.settings'], '.dt-status-head button'))
    expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(group)
  }
  // The Trigger stage has no settings, so its status offers none.
  await click(tab(zh['tab.trigger']))
  expect(all('.dt-status-head button').map(button => button.textContent)).not.toContain(zh['tab.settings'])
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  await click(tab(zh['tab.trigger']))
  await remount()
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
})

it('registers a project with its local workspace and remote repository in the Execution settings', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).toContain(zh.projectsEmpty)
  await click(zh.projectAdd)
  const workspace = process.platform === 'win32' ? 'C:/src/app' : '/src/app'
  await type(field<HTMLInputElement>(zh.projectId), 'app')
  await type(field<HTMLInputElement>(zh.projectName), 'App')
  await type(field<HTMLInputElement>(zh.projectWorkspace), workspace)
  await type(field<HTMLInputElement>(zh.projectRepository), 'owner/app')
  await click(zh.save)
  expect(server.settings.executor.projects).toEqual([{ id: 'app', name: 'App', workspace, repository: 'owner/app', branch: '' }])
})

it('lists a pending proposal with its per-field diff, applies it through the panel save path, and shows the block pending badge', async () => {
  const proposal = { id: 'pr-11112222', block: 'eval' as const, base_revision: 1, value: { ...server.settings.eval, mode: 'off' as const },
    diff: [{ path: 'eval.mode', from: server.settings.eval.mode, to: 'off' }], reason: 'The person asked for observe mode',
    actor: 'master-session', status: 'pending' as const, created_at: '2026-11-01T00:00:00.000Z', expires_at: '2026-11-08T00:00:00.000Z' }
  server.proposals = [proposal]
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).toContain(`${zh.proposalsTitle} · 1`)
  expect(text()).toContain(zh.proposalPending)
  expect(text()).toContain(proposal.reason)
  expect(text()).toContain('eval.mode')
  expect(text()).toContain('off')
  expect(text()).toContain('observe')
  await click(zh.proposalApply)
  expect(server.requests.filter(request => request.method === 'POST').map(request => request.path))
    .toEqual([`settings/proposals/${proposal.id}/apply`])
  expect(server.settings.eval.mode).toBe('off')
  expect(server.revisions.eval).toBe(2)
  expect(server.proposals[0]?.status).toBe('applied')
  expect(text()).not.toContain(zh.proposalsTitle)
})

it('rejects a pending proposal, and the history names its proposal with the approver\'s actor and reason', async () => {
  const executor = { ...server.settings.executor, maxWorkers: server.settings.executor.maxWorkers + 1 }
  const proposal = { id: 'pr-33334444', block: 'executor' as const, base_revision: 0, value: executor,
    diff: [{ path: 'executor.maxWorkers', from: server.settings.executor.maxWorkers, to: executor.maxWorkers }],
    reason: 'The person asked for one more worker', actor: 'master', status: 'pending' as const,
    created_at: '2026-11-01T00:00:00.000Z', expires_at: '2026-11-08T00:00:00.000Z' }
  server.proposals = [proposal]
  server.history = { ...server.history, items: [{ revision: 5, savedAt: '2026-11-01T00:00:00.000Z', source: 'panel', block: 'executor',
    policyVersion: 'abcdef1234567890', policyChanged: false, notified: [], actor: 'master', reason: 'The person asked for this',
    proposal: proposal.id, changes: [] }] }
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).toContain('executor.maxWorkers')
  await click(zh.proposalReject)
  expect(server.requests.filter(request => request.method === 'POST').map(request => request.path))
    .toEqual([`settings/proposals/${proposal.id}/reject`])
  expect(server.proposals[0]?.status).toBe('rejected')
  expect(server.settings.executor.maxWorkers).toBe(executor.maxWorkers - 1)
  await click(zh.configHistory)
  expect(text()).toContain(zh.historyProposal.replace('{proposal}', proposal.id))
  expect(text()).toContain(zh.historyActor.replace('{actor}', 'master'))
  expect(text()).toContain(zh.historyReason.replace('{reason}', 'The person asked for this'))
})

it('restores a block from a history revision after confirming the block and revision, and shows where it came from', async () => {
  const oldEval = { ...server.settings.eval, timeoutSeconds: 120 }
  server.restoreValues[1] = { ...server.settings, eval: oldEval }
  server.revisions = { ...server.revisions, eval: 2 }
  server.history = { current: 2, policyVersion: 'abcdef1234567890', items: [{ revision: 1, savedAt: '2026-09-21T00:00:00Z',
    source: 'panel', block: 'eval', policyVersion: 'abcdef1234567890', policyChanged: false, notified: [], changes: [] }] }
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh.configHistory)
  await click(zh.restore)
  expect(text()).toContain(zh.restoreConfirm.replace('{block}', 'eval').replace('{revision}', '1'))
  await click(zh.confirm)
  await settle()
  const restore = server.requests.find(request => request.method === 'POST' && request.path === 'settings/eval/restore')
  expect(restore?.body).toEqual({ revision: 1 })
  expect(server.settings.eval.timeoutSeconds).toBe(120)
  expect(server.revisions.eval).toBe(3)
  expect(text()).toContain(zh.historyRestoredFrom.replace('{revision}', '1'))
})

it('shows the pending-proposal badge on every settings group, including Prompts and Deployment', async () => {
  server.proposals = [{ id: 'pr-9999aaaa', block: 'eval', base_revision: server.revisions.eval ?? 0,
    value: { ...server.settings.eval, mode: 'off' }, diff: [{ path: 'eval.mode', from: server.settings.eval.mode, to: 'off' }],
    reason: 'The person asked for it', actor: 'master', status: 'pending', created_at: '2026-11-01T00:00:00.000Z',
    expires_at: '2026-11-08T00:00:00.000Z' }]
  await mount()
  await click(tab(zh['tab.settings']))
  for (const group of ['prompts', 'deployment', 'language'] as const) {
    await click(find(zh[`settingsGroup.${group}`], '.dt-settings-link'))
    expect(text()).toContain(`${zh.proposalsTitle} · 1`)
  }
})

it('saves the default language from its own Settings group', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.language'], '.dt-settings-link'))
  await type(field<HTMLInputElement>(zh.languageDefaultLabel), 'English (US)')
  await click(zh.save)
  expect(server.settings.language).toEqual({ default: 'English (US)' })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toContain('settings/language')
})
