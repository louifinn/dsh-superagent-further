import { describe, expect, it } from 'vitest'
import type { Commands } from '../src/infra/commands.ts'
import type { Trigger } from '../src/core/index.ts'
import { setGithubLabels } from '../src/sources/github-labels.ts'

interface Write { repository: string; method: 'POST' | 'DELETE'; path: string; body?: unknown }
interface State { issue: string[]; repository: string[]; writes: Write[] }
const state = (issue: string[], repository: string[]): State => ({ issue, repository, writes: [] })
const commands = (store: State) => ({
  gh: async (args: string[]) => {
    const path = args.find(arg => arg.startsWith('repos/'))!
    const labels = path.includes('/issues/') ? store.issue : store.repository
    return labels.map(name => ({ name }))
  },
  apiWrite: async (repository: string, method: 'POST' | 'DELETE', path: string, body?: unknown) => {
    store.writes.push({ repository, method, path, ...(body === undefined ? {} : { body }) })
    if (method === 'POST') store.issue.push(...((body as { labels: string[] }).labels))
    else store.issue = store.issue.filter(name => name !== decodeURIComponent(path.split('/labels/')[1]!))
    return ''
  },
}) as unknown as Pick<Commands, 'gh' | 'apiWrite'>
const deployment = { repository: 'acme/widgets' }
const trigger = (number = 12, repository = ''): Trigger => ({ id: 'trigger-1', source: 'github', threads: [{ source: 'github', id: `github:${number}` }],
  actor: { source: 'github', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'Label this',
  meta: { number, isPr: false, ...(repository === '' ? {} : { repository }) } })

describe('GitHub label changes', () => {
  it('adds a label the repository defines, spelled the way the repository stores it', async () => {
    const store = state(['bug'], ['bug', 'triage'])
    const result = await setGithubLabels(commands(store), deployment, trigger(), { add: ['TRIAGE'] })
    expect(result).toEqual({ added: ['triage'], removed: [], labels: ['bug', 'triage'] })
    expect(store.writes).toEqual([{ repository: 'acme/widgets', method: 'POST', path: 'issues/12/labels', body: { labels: ['triage'] } }])
  })
  it('adds nothing when the target already carries the label', async () => {
    const store = state(['bug'], ['bug'])
    expect(await setGithubLabels(commands(store), deployment, trigger(), { add: ['Bug'] })).toEqual({ added: [], removed: [], labels: ['bug'] })
    expect(store.writes).toEqual([])
  })
  it('removes a label the target carries, matching its case', async () => {
    const store = state(['bug', 'triage'], ['bug', 'triage'])
    expect(await setGithubLabels(commands(store), deployment, trigger(), { remove: ['BUG'] })).toEqual({ added: [], removed: ['bug'], labels: ['triage'] })
    expect(store.writes).toEqual([{ repository: 'acme/widgets', method: 'DELETE', path: 'issues/12/labels/bug' }])
  })
  it('uses the project repository a Trigger names rather than the primary repository', async () => {
    const store = state([], ['bug'])
    await setGithubLabels(commands(store), deployment, trigger(5, 'acme/other'), { add: ['bug'] })
    expect(store.writes[0]).toMatchObject({ repository: 'acme/other', path: 'issues/5/labels' })
  })
  it('refuses a label the repository does not define, because labels are never created', async () => {
    const store = state([], ['bug'])
    await expect(setGithubLabels(commands(store), deployment, trigger(), { add: ['new-label'] })).rejects.toThrow('labels are never created')
    expect(store.writes).toEqual([])
  })
  it('refuses removing a label the target does not carry', async () => {
    const store = state(['bug'], ['bug', 'triage'])
    await expect(setGithubLabels(commands(store), deployment, trigger(), { remove: ['triage'] })).rejects.toThrow('has no label named')
    expect(store.writes).toEqual([])
  })
  it('refuses an empty change and a label both added and removed', async () => {
    const store = state([], ['bug'])
    await expect(setGithubLabels(commands(store), deployment, trigger(), {})).rejects.toThrow('at least one label')
    await expect(setGithubLabels(commands(store), deployment, trigger(), { add: ['bug'], remove: ['BUG'] })).rejects.toThrow('cannot be added and removed')
    expect(store.writes).toEqual([])
  })
  it('refuses a Trigger that names no labelable GitHub work', async () => {
    const store = state([], ['bug'])
    await expect(setGithubLabels(commands(store), deployment, { ...trigger(), source: 'feishu' }, { add: ['bug'] })).rejects.toThrow('Only a GitHub Issue or pull request')
    await expect(setGithubLabels(commands(store), deployment, { ...trigger(), meta: { number: 3, isPr: true, ci: true } }, { add: ['bug'] }))
      .rejects.toThrow('CI Trigger')
  })
})
