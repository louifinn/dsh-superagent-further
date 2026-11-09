import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, MemoryRepositories, ProjectRequestError, projectRequestOpen, type Assessor, type Executor, type Outbox, type Policy,
  type ProjectRequestInput, type ProjectRequestRefusal, type ProjectRequestStatus, type SourceScope } from '../src/core/index.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-project-requests-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const policy: Policy = {
  version: 'v1', paused: false, evalTimeoutMs: 60000,
  gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }),
  revalidate: () => true,
  admitsInferred: () => true,
}
const assessor: Assessor = { request: () => {} }
const executor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }
const outbox: Outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
const scope: SourceScope = { scope: () => ({ listened: true, observed: false }) }

/** A Store at a temporary path and an Engine over it whose clock the test moves. */
const open = () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  let clock = '2026-11-10T09:00:00.000Z'
  const engine = new Engine({ repo: store, scope, policy: () => policy, assessor, executor, outbox, now: () => clock })
  return { store, engine, path, setClock: (at: string) => { clock = at } }
}

const request = (overrides: Partial<ProjectRequestInput> = {}): ProjectRequestInput => ({
  project: 'orchestrator',
  title: 'Add a project status page',
  instruction: 'Build a page that lists each project\'s open work.',
  raised_by: { session: 'lead-orchestrator', ticket: 'ticket-1', assignment: 'assignment-1' },
  ...overrides,
})

/** Runs a command expected to refuse with `code`; a command that returns or throws anything else fails. */
const refusal = (command: () => unknown, code: ProjectRequestRefusal): void => {
  try {
    command()
    throw new Error(`expected ProjectRequestError ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectRequestError)
    expect((error as ProjectRequestError).code).toBe(code)
  }
}

it('records a project request through pending, needs-info, accepted and completed states', () => {
  const { engine, store, setClock } = open()
  const raised = engine.raiseProjectRequest(request())
  expect(raised.id).toMatch(/^prq-[0-9a-f]{8}$/)
  expect(raised).toMatchObject({
    project: 'orchestrator', kind: 'work', title: 'Add a project status page', status: 'pending', replies: [], tickets: [], derived: [],
    created_at: '2026-11-10T09:00:00.000Z', updated_at: '2026-11-10T09:00:00.000Z',
  })
  expect(raised.raised_by).toEqual({ session: 'lead-orchestrator', ticket: 'ticket-1', assignment: 'assignment-1' })
  expect(raised.root).toBeUndefined()
  refusal(() => engine.replyProjectRequest(raised.id, { by: 'lead-orchestrator', text: '  ' }), 'emptyText')
  setClock('2026-11-10T09:01:00.000Z')
  const replied = engine.replyProjectRequest(raised.id, { by: 'lead-orchestrator', text: 'Reading the ticket now' })
  expect(replied.replies).toEqual([{ at: '2026-11-10T09:01:00.000Z', by: 'lead-orchestrator', text: 'Reading the ticket now' }])
  expect(replied.updated_at).toBe('2026-11-10T09:01:00.000Z')
  setClock('2026-11-10T09:02:00.000Z')
  const asked = engine.disposeProjectRequest(raised.id, { by: 'lead-orchestrator', action: 'needs-info', text: 'Which page should it replace?' })
  expect(asked.status).toBe('needs-info')
  expect(asked.decision).toEqual({ action: 'needs-info', at: '2026-11-10T09:02:00.000Z' })
  expect(asked.replies.map(reply => reply.text)).toEqual(['Reading the ticket now', 'Which page should it replace?'])
  setClock('2026-11-10T09:03:00.000Z')
  const accepted = engine.disposeProjectRequest(raised.id,
    { by: 'lead-orchestrator', action: 'accept', text: 'Accepted', notes: 'Start with the overview page.' })
  expect(accepted.status).toBe('accepted')
  expect(accepted.decision).toEqual({ action: 'accept', at: '2026-11-10T09:03:00.000Z', notes: 'Start with the overview page.' })
  setClock('2026-11-10T09:04:00.000Z')
  const completed = engine.completeProjectRequest(raised.id, { by: 'lead-orchestrator', text: 'The page is live' })
  expect(completed.status).toBe('completed')
  expect(completed.completed_at).toBe('2026-11-10T09:04:00.000Z')
  expect(completed.replies.at(-1)?.text).toBe('The page is live')
  expect(store.projectRequests.get(raised.id)).toEqual(completed)
  refusal(() => engine.replyProjectRequest(raised.id, { by: 'lead-orchestrator', text: 'Again' }), 'settledProjectRequest')
  refusal(() => engine.disposeProjectRequest(raised.id, { by: 'lead-orchestrator', action: 'reject', text: 'No' }), 'settledProjectRequest')
  refusal(() => engine.completeProjectRequest(raised.id, { by: 'lead-orchestrator', text: 'Again' }), 'notAccepted')
  store.close()
})

it('opens only the statuses the Lead may still answer', () => {
  const statuses: ProjectRequestStatus[] = ['pending', 'needs-info', 'accepted', 'rejected', 'awaiting-approval', 'approved',
    'completed', 'withdrawn']
  expect(statuses.filter(projectRequestOpen)).toEqual(['pending', 'needs-info', 'accepted', 'awaiting-approval', 'approved'])
})

it('completes an approved architecture request', () => {
  const { engine, store, setClock } = open()
  const raised = engine.raiseProjectRequest(request({ kind: 'architecture', title: 'Change the data model' }))
  store.projectRequests.save({ ...raised, status: 'approved',
    approval: { thread_key: 'feishu:oc_1', trigger_id: 'trigger-9', at: '2026-11-10T09:01:00.000Z', by: 'human', text: 'Approved' } })
  setClock('2026-11-10T09:02:00.000Z')
  const completed = engine.completeProjectRequest(raised.id, { by: 'lead-orchestrator', text: 'Shipped the data model' })
  expect(completed.status).toBe('completed')
  expect(completed.completed_at).toBe('2026-11-10T09:02:00.000Z')
  expect(completed.approval).toEqual({ thread_key: 'feishu:oc_1', trigger_id: 'trigger-9', at: '2026-11-10T09:01:00.000Z', by: 'human', text: 'Approved' })
  store.close()
})

it('raises one open request per worker Ticket and title', () => {
  const { engine, store } = open()
  const first = engine.raiseProjectRequest(request())
  expect(engine.raiseProjectRequest(request({ instruction: 'The same ticket asking again, in other words.' })).id).toBe(first.id)
  expect(engine.raiseProjectRequest(request({ title: 'Another request' })).id).not.toBe(first.id)
  engine.disposeProjectRequest(first.id, { by: 'lead-orchestrator', action: 'reject', text: 'Not this one' })
  const repeated = engine.raiseProjectRequest(request())
  expect(repeated.id).not.toBe(first.id)
  expect(engine.listProjectRequests().map(item => item.id)).toContain(repeated.id)
  expect(engine.listProjectRequests()).toHaveLength(3)
  store.close()
})

it('links a derived request from its root and keeps it in the same project', () => {
  const { engine, store } = open()
  const root = engine.raiseProjectRequest(request({ raised_by: { session: 'lead-orchestrator' },
    root: { trigger_id: 'trigger-9', thread_key: 'feishu:oc_1' } }))
  expect(root.root).toEqual({ trigger_id: 'trigger-9', thread_key: 'feishu:oc_1' })
  const derived = engine.raiseProjectRequest(request({ title: 'Follow-up raised by the root request', raised_by: { session: 'lead-orchestrator' },
    root: { project_request_id: root.id, trigger_id: 'trigger-9', thread_key: 'feishu:oc_1' } }))
  expect(derived.root).toEqual({ project_request_id: root.id, trigger_id: 'trigger-9', thread_key: 'feishu:oc_1' })
  expect(engine.listProjectRequests().find(item => item.id === root.id)?.derived).toEqual([derived.id])
  refusal(() => engine.raiseProjectRequest(request({ title: 'Nested', raised_by: { session: 'lead-orchestrator' },
    root: { project_request_id: derived.id, trigger_id: 'trigger-9', thread_key: 'feishu:oc_1' } })), 'notRootProjectRequest')
  refusal(() => engine.raiseProjectRequest(request({ title: 'Orphan', raised_by: { session: 'lead-orchestrator' },
    root: { project_request_id: 'prq-missing', trigger_id: 'trigger-9', thread_key: 'feishu:oc_1' } })), 'unknownRootProjectRequest')
  refusal(() => engine.raiseProjectRequest(request({ project: 'superagent', title: 'Elsewhere', raised_by: { session: 'lead-orchestrator' },
    root: { project_request_id: root.id, trigger_id: 'trigger-9', thread_key: 'feishu:oc_1' } })), 'foreignProjectRequest')
  store.close()
})

it('lists project requests by project and status, oldest first, across a reopen', () => {
  const { engine, store, path, setClock } = open()
  const first = engine.raiseProjectRequest(request({ raised_by: { session: 'lead-orchestrator' } }))
  setClock('2026-11-10T09:01:00.000Z')
  const second = engine.raiseProjectRequest(request({ raised_by: { session: 'lead-orchestrator' }, title: 'A second request' }))
  const other = engine.raiseProjectRequest(request({ project: 'superagent', title: 'Another project\'s request', raised_by: { session: 'lead-orchestrator' } }))
  engine.disposeProjectRequest(second.id, { by: 'lead-orchestrator', action: 'accept', text: 'Accepted' })
  expect(engine.listProjectRequests().map(item => item.id)).toEqual([first.id, second.id, other.id])
  expect(engine.listProjectRequests({ project: 'orchestrator' }).map(item => item.id)).toEqual([first.id, second.id])
  expect(engine.listProjectRequests({ status: 'accepted' }).map(item => item.id)).toEqual([second.id])
  store.close()
  const reopened = new Store(path)
  const again = new Engine({ repo: reopened, scope, policy: () => policy, assessor, executor, outbox })
  expect(again.listProjectRequests({ project: 'superagent' }).map(item => item.id)).toEqual([other.id])
  reopened.close()
})

it('refuses project requests on repositories that do not store them', () => {
  const engine = new Engine({ repo: new MemoryRepositories(), scope, policy: () => policy, assessor, executor, outbox })
  refusal(() => engine.raiseProjectRequest(request()), 'noProjectRequestStore')
  refusal(() => engine.listProjectRequests(), 'noProjectRequestStore')
})

it('refuses empty and over-long request text', () => {
  const { engine, store } = open()
  refusal(() => engine.raiseProjectRequest(request({ title: '   ' })), 'emptyText')
  refusal(() => engine.raiseProjectRequest(request({ instruction: '' })), 'emptyText')
  refusal(() => engine.raiseProjectRequest(request({ title: 'x'.repeat(121) })), 'tooLong')
  refusal(() => engine.raiseProjectRequest(request({ instruction: 'x'.repeat(8001) })), 'tooLong')
  expect(engine.listProjectRequests()).toEqual([])
  store.close()
})
