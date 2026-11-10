/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SetupError } from '../src/setup.ts'
import { SettingsConflict, SettingsRevisionNotFound } from '../src/app/settings.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { policyVersion, type Settings, type SettingsBlock } from '../src/policy.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})
it('accepts a GitHub Source saved without a CLI, and verifies any other account change against the first project\'s repository', async () => {
  h = await startRuntime()
  const { setup, store } = h.runtime
  const current = store.settings()
  const unbound = { ...current, sources: { ...current.sources, github: { enabled: true, config: {} } } }
  await expect(setup.checkAccounts('source:github', unbound)).resolves.toBeUndefined()
  // Every other GitHub account change is still verified before it is stored; the repository is the first project's.
  const partial = { ...current, sources: { ...current.sources, github: { enabled: true, config: { cli: 'dsh-superagent-further-missing-gh' } } } }
  await expect(setup.checkAccounts('source:github', partial)).rejects.toThrow(SetupError)
})
it('stores the GitHub Source without the retired repository setting and checks the first project\'s repository instead', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const block = settings.block('source:github')
  const value = block.value as { enabled: boolean; config: Record<string, unknown> }
  const saved = await settings.save('source:github', { enabled: true, config: { ...value.config, repository: 'acme/legacy' } }, block.revision, 'panel')
  expect(saved.saved).toBe(true)
  // The Source schema drops the retired field, and saving checked push access to the first project's acme/widgets instead.
  expect(store.settings().sources.github?.config).toMatchObject({ cli: value.config.cli })
  expect(store.settings().sources.github?.config).not.toHaveProperty('repository')
})

it("refuses a tool-originated change of the registered projects, and accepts the panel's", async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const workspace = process.platform === 'win32' ? 'C:/src/app' : '/src/app'
  const projects = [{ id: 'app', name: 'App', workspace, repository: 'owner/app', branch: '' }]
  await expect(settings.save('executor', { ...executor, projects }, revision, 'tool', { reason: 'The person asked for another project' }))
    .rejects.toMatchObject({ code: 'panelOnlyEnvironment' })
  expect(store.settings().executor.projects).toEqual(executor.projects)
  const saved = await settings.save('executor', { ...executor, projects }, revision, 'panel')
  expect(saved.saved).toBe(true)
  expect(store.settings().executor.projects).toEqual(projects)
})

it('restores one block from a saved revision as a new revision and records restoredFrom in the history', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const evaluation = settings.block('eval')
  const current = evaluation.value as Settings['eval']
  const firstValue = current.timeoutSeconds + 30, secondValue = current.timeoutSeconds + 60
  await settings.save('eval', { ...current, timeoutSeconds: firstValue }, evaluation.revision, 'panel')
  // History rows name the global settings revision, not the block revision, so the restore takes that number.
  const firstRevision = store.settingsHistory(1)[0]!.revision
  await settings.save('eval', { ...current, timeoutSeconds: secondValue }, store.blockRevision('eval'), 'panel')
  const restored = await settings.restore('eval', firstRevision)
  expect(restored).toMatchObject({ saved: true, restoredFrom: firstRevision, restarting: false })
  expect(store.settings().eval.timeoutSeconds).toBe(firstValue)
  // The restore is a new revision; the target revision stays as it was.
  expect(store.settingsHistory(1)[0]!.revision).toBeGreaterThan(firstRevision)
  expect(store.settingsVersion(firstRevision)?.settings.eval.timeoutSeconds).toBe(firstValue)
  const version = store.settingsHistory(1)[0]!
  expect(version).toMatchObject({ source: 'panel', block: 'eval', restoredFrom: firstRevision })
  const history = policyHistory(store, h.runtime.sources, policyVersion(store.settings()))
  expect(history.items[0]).toMatchObject({ revision: version.revision, restoredFrom: firstRevision })
  // Restoring the value the block already holds changes nothing, so it is a conflict rather than an empty revision;
  // a revision that is not retained is a distinct not-found failure.
  await expect(settings.restore('eval', firstRevision)).rejects.toBeInstanceOf(SettingsConflict)
  await expect(settings.restore('eval', 999_999)).rejects.toBeInstanceOf(SettingsRevisionNotFound)
  await expect(settings.restore('missing' as SettingsBlock, firstRevision)).rejects.toMatchObject({ code: 'unknownBlock' })
})

it('restores a panel-only (tier-C) executor field because the restore is a panel save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const executor = settings.block('executor')
  const current = executor.value as Settings['executor']
  const workspace = process.platform === 'win32' ? 'C:/src/restored' : '/src/restored'
  await settings.save('executor', { ...current, directory: workspace }, executor.revision, 'panel')
  const firstRevision = store.settingsHistory(1)[0]!.revision
  await settings.save('executor', { ...current, directory: `${workspace}-other` }, store.blockRevision('executor'), 'panel')
  const restored = await settings.restore('executor', firstRevision)
  expect(restored).toMatchObject({ saved: true, restoredFrom: firstRevision })
  expect(store.settings().executor.directory).toBe(workspace)
  // A tool-origin save of that same field would still be refused; the panel rules are not bypassed by restoring.
  const revision = store.blockRevision('executor')
  await expect(settings.save('executor', { ...store.settings().executor, directory: `${workspace}-tool` }, revision, 'tool',
    { reason: 'The person asked for this directory' })).rejects.toMatchObject({ code: 'panelOnlyEnvironment' })
})

it('restores a setup field through the panel save path, checking accounts and restarting like a manual save', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  const check = vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue(undefined)
  const restart = vi.spyOn(Setup.prototype, 'restart').mockImplementation(() => {})
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const first = await settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-restored' } },
    github.revision, 'panel')
  expect(first.restarting).toBe(true)
  const firstRevision = h.runtime.store.settingsHistory(1)[0]!.revision
  await settings.save('source:github', value, settings.block('source:github').revision, 'panel')
  check.mockClear(); restart.mockClear()
  const restored = await settings.restore('source:github', firstRevision)
  expect(restored).toMatchObject({ saved: true, restarting: true, restoredFrom: firstRevision })
  expect(check).toHaveBeenCalled()
  expect(restart).toHaveBeenCalled()
  expect(settings.block('source:github').value).toMatchObject({ config: { cli: '/opt/bin/gh-restored' } })
})

it('runs setup again when the first project changes the primary repository, and not for the other projects', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const first = await settings.save('executor',
    { ...store.settings().executor, projects: [{ id: 'other', name: 'Other', workspace: '/w/other', repository: 'acme/other',
      branch: '' }] }, store.blockRevision('executor'), 'panel')
  // The primary repository decides the deployment's Thread ids and worker environment, so setup has to verify it again.
  expect(first.restarting).toBe(true)
  const added = await settings.save('executor', { ...store.settings().executor, projects: [
    ...store.settings().executor.projects,
    { id: 'second', name: 'Second', workspace: '/w/second', repository: 'acme/second', branch: '' },
  ] }, store.blockRevision('executor'), 'panel')
  // A later project is polled without touching setup, so the save applies without a restart.
  expect(added.restarting).toBe(false)
})

it('saves the default language from the panel only, and the block reads it back', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('language')
  await expect(settings.save('language', { default: 'English (US)' }, revision, 'tool', { reason: 'The person wants English' }))
    .rejects.toMatchObject({ code: 'approvalRequired' })
  expect(store.settings().language).toEqual({ default: '简体中文' })
  const saved = await settings.save('language', { default: 'English (US)' }, revision, 'panel')
  expect(saved.saved).toBe(true)
  expect(store.settings().language).toEqual({ default: 'English (US)' })
  expect(settings.block('language').value).toEqual({ default: 'English (US)' })
})

it('saves Memory behavior from the panel only, and the change applies without a restart', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const memory = store.settings().memory
  // Pre-injection is off by default; the panel opts in.
  expect(memory.inject).toBe(false)
  let revision = store.blockRevision('memory')
  const enabled = await settings.save('memory', { ...memory, inject: true, pinnedLimit: 2 }, revision, 'panel')
  expect(enabled.saved).toBe(true)
  expect(store.settings().memory).toMatchObject({ inject: true, pinnedLimit: 2 })
  store.memories.save({ kind: 'fact', text: 'Stored and injected.' })
  expect(store.memories.promptText()).toContain('Stored and injected.')
  // A tool-origin change of the same switch is refused.
  revision = store.blockRevision('memory')
  await expect(settings.save('memory', { ...store.settings().memory, inject: false }, revision, 'tool', { reason: 'The person wants less injection' }))
    .rejects.toMatchObject({ code: 'approvalRequired' })
  expect(store.settings().memory.inject).toBe(true)
  // The panel can turn it off again; the next snapshot is silent.
  revision = store.blockRevision('memory')
  const disabled = await settings.save('memory', { ...store.settings().memory, inject: false, pinnedLimit: 2 }, revision, 'panel')
  expect(disabled.saved).toBe(true)
  expect(settings.block('memory').value).toMatchObject({ inject: false, pinnedLimit: 2 })
  expect(store.memories.promptText()).toBe('')
})

it('requires the person\'s reason for a tool-origin save or pause, and writes nothing without one', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('eval')
  const evaluation = settings.block('eval').value as Settings['eval']
  const value = { ...evaluation, timeoutSeconds: 240 }
  await expect(settings.save('eval', value, revision, 'tool')).rejects.toMatchObject({ code: 'reasonRequired' })
  await expect(settings.save('eval', value, revision, 'tool', { reason: '   ' })).rejects.toMatchObject({ code: 'reasonRequired' })
  await expect(settings.pause(true, 'tool')).rejects.toMatchObject({ code: 'reasonRequired' })
  expect(store.blockRevision('eval')).toBe(revision)
  expect(store.settings().eval.timeoutSeconds).toBe(evaluation.timeoutSeconds)
  expect(store.settings().paused).toBe(false)
})

it('saves tier-A fields from a tool with the person\'s reason, records actor and reason for the panel history, and applies them hot', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const reason = 'The person asked for these limits in the panel'
  const evaluation = settings.block('eval')
  const savedEvaluation = await settings.save('eval', { ...(evaluation.value as object), timeoutSeconds: 240 }, evaluation.revision,
    'tool', { actor: 'master-session', reason })
  expect(savedEvaluation).toMatchObject({ saved: true, restarting: false, policy_changed: false })
  expect(store.settings().eval.timeoutSeconds).toBe(240)
  expect(store.settingsHistory(1)[0]).toMatchObject({ source: 'tool', block: 'eval', actor: 'master-session', reason })
  const executor = settings.block('executor')
  const savedExecutor = await settings.save('executor', { ...(executor.value as object), worktreeKeepDays: 14 }, executor.revision,
    'tool', { actor: 'master-session', reason })
  expect(savedExecutor).toMatchObject({ saved: true, restarting: false })
  expect(store.settings().executor.worktreeKeepDays).toBe(14)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const savedSource = await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 120 } }, github.revision,
    'tool', { actor: 'master-session', reason })
  expect(savedSource).toMatchObject({ saved: true, restarting: false })
  expect(store.settings().sources.github?.config.pollSeconds).toBe(120)
  const latest = store.settingsHistory(1)[0]!
  expect(latest).toMatchObject({ source: 'tool', block: 'source:github', actor: 'master-session', reason })
  // The panel history view carries the audit fields too.
  const history = policyHistory(store, h.runtime.sources, policyVersion(store.settings()))
  expect(history.items.find(item => item.revision === latest.revision)).toMatchObject({ actor: 'master-session', reason })
})

it('refuses every tier-B field from a tool with approvalRequired and every tier-C field with its panel-only code, writing nothing', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const reason = 'The person asked for this change in the panel'
  const policy = settings.block('policy').value as Settings['policy']
  const evaluation = settings.block('eval').value as Settings['eval']
  const executor = settings.block('executor').value as Settings['executor']
  const memory = settings.block('memory').value as Settings['memory']
  const github = settings.block('source:github').value as { enabled: boolean; config: Record<string, unknown> }
  const feishu = settings.block('source:feishu').value as { enabled: boolean; config: Record<string, unknown> }
  const workspace = process.platform === 'win32' ? 'C:/src/other' : '/src/other'
  const mode = evaluation.mode === 'auto' ? 'observe' : 'auto'
  const otherChats = feishu.config.otherChats === 'mentions' ? 'none' : 'mentions'
  const cases: { block: SettingsBlock; value: unknown; code: string }[] = [
    { block: 'eval', value: { ...evaluation, mode }, code: 'approvalRequired' },
    { block: 'eval', value: { ...evaluation, model }, code: 'approvalRequired' },
    { block: 'executor', value: { ...executor, model }, code: 'approvalRequired' },
    { block: 'executor', value: { ...executor, maxWorkers: executor.maxWorkers + 1 }, code: 'approvalRequired' },
    { block: 'executor', value: { ...executor, projectWorkers: executor.projectWorkers + 1 }, code: 'approvalRequired' },
    { block: 'policy', value: { ...policy, rules: policy.rules.map((rule, index) => index === 0 ? { ...rule, enabled: !rule.enabled } : rule) },
      code: 'approvalRequired' },
    { block: 'policy', value: { ...policy, sources: { ...policy.sources, github: { ...(policy.sources.github ?? { admission: {} }),
      allowed: [...(policy.sources.github?.allowed ?? []), { id: 'tier-b-test' }] } } }, code: 'approvalRequired' },
    { block: 'memory', value: { ...memory, inject: true }, code: 'approvalRequired' },
    { block: 'language', value: { default: 'English (US)' }, code: 'approvalRequired' },
    { block: 'source:github', value: { ...github, enabled: false }, code: 'approvalRequired' },
    { block: 'source:feishu', value: { ...feishu, config: { ...feishu.config, chats: [...((feishu.config.chats as unknown[] | undefined) ?? []),
      { chatId: 'oc_new', listen: 'all' }] } }, code: 'approvalRequired' },
    { block: 'source:feishu', value: { ...feishu, config: { ...feishu.config, directMessages: false } }, code: 'approvalRequired' },
    { block: 'source:feishu', value: { ...feishu, config: { ...feishu.config, otherChats } }, code: 'approvalRequired' },
    { block: 'source:feishu', value: { ...feishu, config: { ...feishu.config, digestChat: 'oc_digest' } }, code: 'approvalRequired' },
    { block: 'executor', value: { ...executor, directory: workspace }, code: 'panelOnlyEnvironment' },
    { block: 'executor', value: { ...executor, prepare: 'echo prepared' }, code: 'panelOnlyEnvironment' },
    { block: 'executor', value: { ...executor, blockedCommands: ['rm'] }, code: 'panelOnlyEnvironment' },
    { block: 'executor', value: { ...executor, projects: [...executor.projects, { id: 'other', name: 'Other', workspace,
      repository: 'owner/other', branch: '' }] }, code: 'panelOnlyEnvironment' },
    { block: 'source:github', value: { ...github, config: { ...github.config, cli: '/opt/gh-other' } }, code: 'panelOnlyAccounts' },
    { block: 'source:feishu', value: { ...feishu, config: { ...feishu.config, cli: '/opt/lark-other' } }, code: 'panelOnlyAccounts' },
  ]
  for (const item of cases) {
    const revision = store.blockRevision(item.block)
    const before = JSON.stringify(store.settings())
    const failure = await settings.save(item.block, item.value, revision, 'tool', { actor: 'master', reason })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(UserError)
    expect(failure).toMatchObject({ code: item.code })
    expect((failure as UserError).message).toContain('management panel')
    expect(store.blockRevision(item.block)).toBe(revision)
    expect(JSON.stringify(store.settings())).toBe(before)
  }
})

it('still rejects an invalid or unknown tier-A payload from a tool, writing nothing', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const reason = 'The person asked for this change'
  const revision = store.blockRevision('eval')
  const evaluation = settings.block('eval').value as Settings['eval']
  const before = JSON.stringify(store.settings())
  await expect(settings.save('eval', { ...evaluation, timeoutSeconds: 1 }, revision, 'tool', { reason })).rejects.toThrow()
  await expect(settings.save('eval', { ...evaluation, timeoutSeconds: 240, extra: true }, revision, 'tool', { reason })).rejects.toThrow()
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  await expect(settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 5 } }, github.revision, 'tool',
    { reason })).rejects.toThrow()
  expect(JSON.stringify(store.settings())).toBe(before)
  expect(store.blockRevision('eval')).toBe(revision)
  await expect(settings.save('missing' as unknown as SettingsBlock, {}, 0, 'tool', { reason }))
    .rejects.toMatchObject({ code: 'unknownBlock' })
})

it('proposes a tier-B change, supersedes the block\'s older pending proposal, and applies it with its actor, reason and id in the history', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const evaluation = settings.block('eval')
  const current = evaluation.value as Settings['eval']
  const mode = current.mode === 'auto' ? 'observe' : 'auto'
  const reason = 'The person asked to run the evaluator in the other mode'
  const first = settings.propose('eval', { ...current, mode }, 'Make it quieter', 'master-session')
  expect(first).toMatchObject({ block: 'eval', status: 'pending', actor: 'master-session', base_revision: evaluation.revision, reason: 'Make it quieter' })
  expect(first.id).toMatch(/^pr-[0-9a-f]{8}$/)
  expect(first.diff).toEqual([{ path: 'eval.mode', from: current.mode, to: mode }])
  expect(first.value).toMatchObject({ mode })
  expect(Date.parse(first.expires_at) - Date.parse(first.created_at)).toBe(7 * 24 * 60 * 60 * 1000)

  const second = settings.propose('eval', { ...current, mode }, reason, 'master')
  expect(settings.proposal(first.id)?.status).toBe('superseded')
  expect(settings.proposals().items.map(item => item.id)).toEqual([second.id])

  const applied = await settings.applyProposal(second.id)
  expect(applied).toMatchObject({ revision: store.blockRevision('eval'), proposal: { id: second.id, status: 'applied', decided_by: 'panel' } })
  expect(store.settings().eval.mode).toBe(mode)
  expect(store.settingsHistory(1)[0]).toMatchObject({ source: 'panel', block: 'eval', actor: 'master', reason, proposal: second.id })
  const history = policyHistory(store, h.runtime.sources, policyVersion(store.settings()))
  expect(history.items[0]).toMatchObject({ proposal: second.id, actor: 'master', reason })
  await expect(settings.applyProposal(second.id)).rejects.toBeInstanceOf(SettingsConflict)

  const executor = settings.block('executor').value as Settings['executor']
  const rejected = settings.propose('executor', { ...executor, maxWorkers: executor.maxWorkers + 1 }, 'The person asked for one more worker', 'master')
  expect(settings.rejectProposal(rejected.id)).toMatchObject({ status: 'rejected', decided_by: 'panel' })
  expect(store.settings().executor.maxWorkers).toBe(executor.maxWorkers)
  await expect(settings.applyProposal(rejected.id)).rejects.toBeInstanceOf(SettingsConflict)
})

it('expires a pending proposal after seven days, and refuses to apply one whose base revision another save moved', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const evaluation = settings.block('eval')
  const current = evaluation.value as Settings['eval']
  const mode = current.mode === 'auto' ? 'observe' : 'auto'
  const expiring = settings.propose('eval', { ...current, mode }, 'The person asked for this', 'master')
  store.proposals.save({ ...expiring, expires_at: new Date(Date.now() - 1000).toISOString() })
  expect(settings.proposals().items).toEqual([])
  expect(settings.proposal(expiring.id)?.status).toBe('expired')
  await expect(settings.applyProposal(expiring.id)).rejects.toBeInstanceOf(SettingsConflict)

  const stale = settings.propose('eval', { ...current, mode }, 'The person asked for this', 'master')
  const moved = await settings.save('eval', { ...current, mode }, store.blockRevision('eval'), 'panel')
  expect(moved.saved).toBe(true)
  await expect(settings.applyProposal(stale.id)).rejects.toBeInstanceOf(SettingsConflict)
  expect(settings.proposal(stale.id)?.status).toBe('expired')
  expect(store.settings().eval.mode).toBe(mode)
})

it('keeps a failed application pending with its error and writes no settings', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const executor = settings.block('executor')
  const current = executor.value as Settings['executor']
  const proposal = settings.propose('executor', { ...current, maxWorkers: current.maxWorkers + 1 }, 'The person asked for one more worker', 'master')
  vi.spyOn(settings, 'save').mockRejectedValueOnce(new Error('The provider is unavailable'))
  const before = JSON.stringify(store.settings())
  await expect(settings.applyProposal(proposal.id)).rejects.toThrow('The provider is unavailable')
  expect(JSON.stringify(store.settings())).toBe(before)
  expect(settings.proposal(proposal.id)).toMatchObject({ status: 'pending', error: 'The provider is unavailable' })
})

it('proposes only changes that need the panel: refusing tier A alone, tier C, pause, no-ops and unknown blocks', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const evaluation = settings.block('eval').value as Settings['eval']
  const executor = settings.block('executor').value as Settings['executor']
  const revision = store.blockRevision('eval')
  const failureOf = (run: () => unknown) => { try { run() } catch (error) { return error } return undefined }

  expect(failureOf(() => settings.propose('eval', { ...evaluation, mode: 'observe' }, '   ', 'master')))
    .toMatchObject({ code: 'reasonRequired' })
  expect(failureOf(() => settings.propose('eval', { ...evaluation, mode: 'observe' }, 'x'.repeat(281), 'master'))).toBeInstanceOf(Error)
  expect(failureOf(() => settings.propose('eval', { ...evaluation }, 'The person asked for nothing', 'master'))).toBeInstanceOf(Error)
  expect(failureOf(() => settings.propose('eval', { ...evaluation, timeoutSeconds: 240 }, 'The person asked for a timeout', 'master')))
    .toMatchObject({ message: expect.stringContaining('saved directly') })
  expect(failureOf(() => settings.propose('pause' as SettingsBlock, {}, 'The person asked for this', 'master')))
    .toMatchObject({ message: expect.stringContaining('tier-A') })
  expect(failureOf(() => settings.propose('executor', { ...executor, directory: '/tmp/elsewhere' }, 'The person asked for this', 'master')))
    .toMatchObject({ code: 'panelOnlyEnvironment' })
  expect(failureOf(() => settings.propose('missing' as SettingsBlock, {}, 'The person asked for this', 'master')))
    .toMatchObject({ code: 'unknownBlock' })
  expect(store.blockRevision('eval')).toBe(revision)
  expect(store.proposals.list()).toEqual([])
})

it('keeps the panel path able to save a tier-B field and change the Policy version, without an audit reason', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const evaluation = settings.block('eval')
  const mode = (evaluation.value as Settings['eval']).mode === 'auto' ? 'observe' : 'auto'
  const saved = await settings.save('eval', { ...(evaluation.value as object), mode }, evaluation.revision, 'panel')
  expect(saved).toMatchObject({ saved: true, policy_changed: true })
  expect(store.settings().eval.mode).toBe(mode)
  const version = store.settingsHistory(1)[0]!
  expect(version).toMatchObject({ source: 'panel', block: 'eval' })
  expect(version.actor).toBeUndefined()
  expect(version.reason).toBeUndefined()
})
