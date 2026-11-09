import { expect, it } from 'vitest'
import { key, type ChannelRef, type Mandate, type ProjectRequest, type Request, type Ticket } from '../src/core/index.ts'
import { projectResultChannels, projectResultNotices, requestResultNotices } from '../src/app/request-notices.ts'

const feishu = (message: string): ChannelRef => ({ source: 'feishu', thread: 'feishu:oc_team:om_1', address: { chatId: 'oc_team', messageId: message } })
const github: ChannelRef = { source: 'github', thread: 'github:acme/widgets#7', address: { number: '7' } }
const mandate: Mandate = { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', addressed: 'mention' },
  actor: { source: 'feishu', id: 'ou_alice' }, scope: 'fix' }

const ticket = (id: string, overrides: Partial<Ticket> = {}): Ticket => ({
  id, title: `Ticket ${id}`, decisionId: `decision-${id}`, mandate, deliverable: 'change', channels: [feishu('om_1')],
  assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z',
  origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, ...overrides,
})
const request = (overrides: Partial<Request> = {}): Request => ({
  id: 'request-1', title: '修复回归', decisionId: 'decision-1', mandate,
  channels: [feishu('om_1'), github], ticketIds: ['t1', 't2'], createdAt: '2026-11-10T09:00:00.000Z',
  ended: { at: '2026-11-10T09:30:00.000Z', by: 'executor', outcome: 'done' }, ...overrides,
})
const project = (overrides: Partial<ProjectRequest> = {}): ProjectRequest => ({
  id: 'prq-root', project: 'app', kind: 'work', title: 'Add a status page',
  instruction: 'Build a page that lists every project\'s open work.', raised_by: { session: 'lead-app' },
  root: { trigger_id: 'trigger-1', thread_key: 'feishu:oc_team:om_1' }, status: 'completed', replies: [
    { at: '2026-11-10T09:10:00.000Z', by: 'lead-app', text: 'Accepted' },
    { at: '2026-11-10T09:40:00.000Z', by: 'lead-app', text: 'The page is live' },
  ], tickets: ['t1', 't2'], derived: [], created_at: '2026-11-10T09:05:00.000Z', updated_at: '2026-11-10T09:40:00.000Z',
  completed_at: '2026-11-10T09:40:00.000Z', ...overrides,
})

it('reports one ended Request once per non-GitHub Channel, naming every Ticket and the pull request it delivered', () => {
  const tickets = [
    ticket('t1', { title: '回归修复', project: 'app', ended: { at: '2026-11-10T09:20:00.000Z', by: 'executor', outcome: 'merged' },
      follows: [{ thread: 'github:acme/widgets#12', own: true, closed: { at: '2026-11-10T09:20:00.000Z', outcome: 'merged' } }] }),
    ticket('t2', { title: 'Documentation', ended: { at: '2026-11-10T09:21:00.000Z', by: 'executor', outcome: 'closed' } }),
  ]
  const ticketOf = (id: string) => tickets.find(item => item.id === id)
  const notices = requestResultNotices(request(), '@bot 修复回归', ticketOf, 'acme/widgets')
  // GitHub is where the Request itself is reported; only the Feishu Channel gets the chat notice.
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({
    id: key('request-result', 'request-1', 'feishu', JSON.stringify(feishu('om_1').address)),
    channel: feishu('om_1'), kind: 'notice',
  })
  expect(notices[0]!.text).toBe([
    '「修复回归」已完成（2 个工单）：',
    '- app: [PR #12](https://github.com/acme/widgets/pull/12) 已合并',
    '- 部署仓库: Documentation 已关闭',
  ].join('\n'))
  expect(requestResultNotices(request({ ended: undefined }), '@bot 修复回归', ticketOf, 'acme/widgets')).toEqual([])
})

it('reports the root project request through its origin Channels only, once, with every Ticket and derived outcome', () => {
  const tickets = [
    ticket('t1', { title: '回归修复', project: 'app', ended: { at: '2026-11-10T09:20:00.000Z', by: 'executor', outcome: 'merged' },
      follows: [{ thread: 'github:acme/widgets#12', own: true, closed: { at: '2026-11-10T09:20:00.000Z', outcome: 'merged' } }] }),
    ticket('t2', { title: 'Documentation', ended: { at: '2026-11-10T09:21:00.000Z', by: 'executor', outcome: 'dropped' } }),
    ticket('t3', { title: 'Follow-up', ended: { at: '2026-11-10T09:22:00.000Z', by: 'executor', outcome: 'completed' } }),
  ]
  const derived = project({ id: 'prq-child', title: 'Follow-up', root: { project_request_id: 'prq-root', trigger_id: 'trigger-1', thread_key: 'feishu:oc_team:om_1' },
    tickets: ['t3'], status: 'completed' })
  const root = project({ derived: ['prq-child'], request_id: 'request-1' })
  const ticketOf = (id: string) => tickets.find(item => item.id === id)
  const requestOf = (id: string) => id === 'prq-child' ? derived : id === 'prq-root' ? root : undefined
  const origin = request({ channels: [feishu('om_1'), github] })
  // The Trigger's Channel repeats the Request's and is not reported twice.
  const channels = projectResultChannels(root, id => id === 'request-1' ? origin : undefined, () => ({
    id: 'trigger-1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor: { source: 'feishu', id: 'ou_alice' },
    human: true, addressed: 'mention', at: '2026-11-10T09:00:00.000Z', text: '@bot 加一个状态页', channel: feishu('om_1'), meta: {},
  }))
  expect(channels).toEqual([feishu('om_1')])
  const notices = projectResultNotices(root, channels, ticketOf, requestOf, 'acme/widgets')
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ id: key('project-result', 'prq-root', 'feishu', JSON.stringify(feishu('om_1').address)), channel: feishu('om_1'), kind: 'notice' })
  expect(notices[0]!.text).toBe([
    'Project request "Add a status page" is complete (3 Tickets, 1 derived requests):',
    '- app: [PR #12](https://github.com/acme/widgets/pull/12) merged',
    '- deployment: Documentation dropped',
    '- deployment: Follow-up completed',
    'Derived requests:',
    '- Follow-up: completed',
    'Summary: The page is live',
  ].join('\n'))
  // The id is deterministic, so a repeated build is delivered as the same message.
  expect(projectResultNotices(root, channels, ticketOf, requestOf, 'acme/widgets').map(item => item.id)).toEqual(notices.map(item => item.id))
  // A derived request's own completion is not an aggregate of its own.
  expect(projectResultNotices(derived, channels, ticketOf, requestOf, 'acme/widgets')).toEqual([])
  expect(projectResultChannels(project({ root: undefined }), () => undefined, () => undefined)).toEqual([])
})

it('writes the aggregate report in the language of the project request', () => {
  const tickets = [ticket('t1', { title: '回归修复', project: 'app', ended: { at: '2026-11-10T09:20:00.000Z', by: 'executor', outcome: 'merged' } })]
  const derived = project({ id: 'prq-child', title: '补充文档', root: { project_request_id: 'prq-root', trigger_id: 'trigger-1', thread_key: 'feishu:oc_team:om_1' },
    tickets: [], status: 'rejected' })
  const root = project({ title: '加一个状态页', instruction: '列出每个项目的进行中工作。', derived: ['prq-child'], tickets: ['t1'], replies: [{ at: '2026-11-10T09:40:00.000Z', by: 'lead-app', text: '页面已上线' }] })
  const notices = projectResultNotices(root, [feishu('om_1')], id => tickets.find(item => item.id === id), id => id === 'prq-child' ? derived : undefined, 'acme/widgets')
  expect(notices[0]!.text).toBe([
    '项目请求「加一个状态页」已完成（1 个工单，1 个派生请求）：',
    '- app: 回归修复 已合并',
    '派生请求：',
    '- 补充文档: 已拒绝',
    '总结：页面已上线',
  ].join('\n'))
})

it('keeps GitHub-only and empty origin Channels out of the report', () => {
  const root = project({ root: { request_id: 'request-1', trigger_id: 'trigger-1', thread_key: 'github:acme/widgets#7' } })
  expect(projectResultChannels(root, () => request({ channels: [github] }), () => undefined)).toEqual([])
  expect(projectResultNotices(root, [], () => undefined, () => undefined, 'acme/widgets')).toEqual([])
})
