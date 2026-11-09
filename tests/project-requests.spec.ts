import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, MemoryRepositories, ProjectRequestError, key, projectRequestOpen, threadKey, type Assessor, type Executor, type Outbox,
  type Policy, type ProjectRequestInput, type ProjectRequestRefusal, type ProjectRequestStatus, type SourceScope, type Trigger }
  from '../src/core/index.ts'

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

/** A Source Trigger on the root thread a project request came from; `overrides` replaces fields such as id, human or text. */
const trigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 'trigger-root', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1' }],
  actor: { source: 'feishu', id: 'person-1' }, human: true, at: '2026-11-10T08:59:00.000Z',
  text: 'Change the data model', meta: {}, ...overrides,
})

/** An architecture request raised from the `trigger-root` thread, as a Lead creates one for a design proposal. */
const architecture = (overrides: Partial<ProjectRequestInput> = {}): ProjectRequestInput => request({
  kind: 'architecture', title: 'Change the data model', instruction: 'Design the migration before any code changes.',
  root: { trigger_id: 'trigger-root', thread_key: 'feishu:oc_1' }, ...overrides,
})

/** Runs an architecture request through the design Ticket until the request asks for a human's approval. */
const awaitingApproval = (engine: Engine, store: Store, raised: { id: string }, setClock: (at: string) => void) => {
  setClock('2026-11-10T09:01:00.000Z')
  const accepted = engine.disposeProjectRequest(raised.id, { by: 'lead-orchestrator', action: 'accept', text: 'Design it first.' })
  const design = store.tickets.get(accepted.design_ticket_id ?? '')
  if (!design || !design.assignments[0]) throw new Error('the accepted architecture request has no design Ticket')
  engine.assignmentStarted(design.id, design.assignments[0].id)
  setClock('2026-11-10T09:02:00.000Z')
  engine.report(design.id, { state: 'ready', summary: 'Proposal: migrate the schema first, then build the page.' })
  setClock('2026-11-10T09:03:00.000Z')
  return { accepted, design, awaiting: engine.requestProjectApproval(raised.id) }
}

it('runs an architecture request from design through human approval to an implementation request', () => {
  const { engine, store, setClock } = open()
  store.triggers.save(trigger())
  const raised = engine.raiseProjectRequest(architecture())
  expect(raised).toMatchObject({ kind: 'architecture', status: 'pending' })
  const planned = engine.planProjectRequest(raised.id, {
    statement: 'Stage the schema change before the page.', deliverables: [{ title: 'Migrate the schema' }, { title: 'Build the status page', after: [0] }],
  })
  expect(planned.plan).toEqual({
    statement: 'Stage the schema change before the page.',
    deliverables: [
      { title: 'Migrate the schema', project: 'orchestrator' },
      { title: 'Build the status page', after: [0], project: 'orchestrator' },
    ],
  })
  setClock('2026-11-10T09:01:00.000Z')
  const accepted = engine.disposeProjectRequest(raised.id, { by: 'lead-orchestrator', action: 'accept', text: 'Design it first.' })
  expect(accepted.status).toBe('accepted')
  const designId = accepted.design_ticket_id
  expect(designId).toBe(key('ticket', raised.id, 'design'))
  expect(accepted.tickets).toEqual([designId])
  const design = store.tickets.get(designId ?? '')
  expect(design).toMatchObject({ title: 'Change the data model', project: 'orchestrator' })
  expect(design?.requestId).toBeUndefined()
  expect(design?.mandate.basis).toEqual({ via: 'lead', project: 'orchestrator', project_request_id: raised.id })
  expect(design?.assignments).toHaveLength(1)
  expect(store.requests.get(key('request', key('lead-request', raised.id)))).toBeUndefined()
  engine.assignmentStarted(designId ?? '', design?.assignments[0]?.id ?? '')
  setClock('2026-11-10T09:02:00.000Z')
  engine.report(designId ?? '', { state: 'ready', summary: 'Proposal: migrate the schema first, then build the page.' })
  expect(store.tickets.get(designId ?? '')?.ended).toBeDefined()
  setClock('2026-11-10T09:03:00.000Z')
  const awaiting = engine.requestProjectApproval(raised.id)
  expect(awaiting.status).toBe('awaiting-approval')
  expect(awaiting.proposal).toEqual({
    at: '2026-11-10T09:03:00.000Z', ticket_id: designId, text: 'Proposal: migrate the schema first, then build the page.',
  })
  refusal(() => engine.approveProjectRequest(raised.id, { approved: true, trigger_id: 'trigger-root' }), 'missingApprovalTrigger')
  store.triggers.save(trigger({ id: 'trigger-bot', human: false, at: '2026-11-10T09:04:00.000Z' }))
  refusal(() => engine.approveProjectRequest(raised.id, { approved: true, trigger_id: 'trigger-bot' }), 'missingApprovalTrigger')
  store.triggers.save(trigger({ id: 'trigger-elsewhere', threads: [{ source: 'feishu', id: 'oc_2' }], at: '2026-11-10T09:04:00.000Z' }))
  refusal(() => engine.approveProjectRequest(raised.id, { approved: true, trigger_id: 'trigger-elsewhere' }), 'missingApprovalTrigger')
  refusal(() => engine.approveProjectRequest(raised.id, { approved: true, trigger_id: 'trigger-missing' }), 'missingApprovalTrigger')
  store.triggers.save(trigger({ id: 'trigger-approved', at: '2026-11-10T09:05:00.000Z', text: 'Approved, go ahead.' }))
  const approved = engine.approveProjectRequest(raised.id, { approved: true, trigger_id: 'trigger-approved' })
  expect(approved.status).toBe('approved')
  expect(approved.approval).toEqual({
    thread_key: 'feishu:oc_1', trigger_id: 'trigger-approved', at: '2026-11-10T09:05:00.000Z', by: 'human', text: 'Approved, go ahead.',
  })
  expect(approved.request_id).toBe(key('request', key('lead-approval', raised.id)))
  const implementationIds = [key('ticket', raised.id, 'implementation'), key('ticket', key('lead-approval', raised.id), '1')]
  expect(approved.tickets).toEqual([designId, ...implementationIds])
  const implementation = store.requests.get(approved.request_id ?? '')
  expect(implementation).toMatchObject({
    title: 'Change the data model',
    mandate: {
      strength: 'explicit', basis: { via: 'lead', project: 'orchestrator', project_request_id: raised.id },
      actor: { source: 'feishu', id: 'person-1' },
    },
  })
  expect(implementation?.ticketIds).toEqual(implementationIds)
  const [migration, page] = implementationIds.map(id => store.tickets.get(id))
  expect(migration).toMatchObject({ title: 'Migrate the schema', project: 'orchestrator' })
  expect(migration?.after).toBeUndefined()
  expect(page).toMatchObject({ title: 'Build the status page', project: 'orchestrator' })
  expect(page?.after).toEqual([implementationIds[0]])
  setClock('2026-11-10T09:07:00.000Z')
  const completed = engine.completeProjectRequest(raised.id, { by: 'lead-orchestrator', text: 'Implementation started.' })
  expect(completed.status).toBe('completed')
  store.close()
})

it('records a human rejection of the design without creating an implementation request', () => {
  const { engine, store, setClock } = open()
  store.triggers.save(trigger())
  const raised = engine.raiseProjectRequest(architecture())
  const { design, awaiting } = awaitingApproval(engine, store, raised, setClock)
  expect(awaiting.status).toBe('awaiting-approval')
  store.triggers.save(trigger({ id: 'trigger-rejected', at: '2026-11-10T09:04:00.000Z', text: 'Not yet, explain the migration cost.' }))
  const rejected = engine.approveProjectRequest(raised.id, { approved: false, trigger_id: 'trigger-rejected' })
  expect(rejected.status).toBe('rejected')
  expect(rejected.approval).toEqual({
    thread_key: 'feishu:oc_1', trigger_id: 'trigger-rejected', at: '2026-11-10T09:04:00.000Z', by: 'human',
    text: 'Not yet, explain the migration cost.', approved: false,
  })
  expect(rejected.request_id).toBeUndefined()
  expect(rejected.tickets).toEqual([design.id])
  expect(store.requests.get(key('request', key('lead-approval', raised.id)))).toBeUndefined()
  refusal(() => engine.approveProjectRequest(raised.id, { approved: true, trigger_id: 'trigger-rejected' }), 'notAwaitingApproval')
  refusal(() => engine.planProjectRequest(raised.id, { deliverables: [] }), 'settledProjectRequest')
  store.close()
})

it('creates the implementation request when the Lead accepts a work request from a root thread', () => {
  const { engine, store } = open()
  store.triggers.save(trigger({ id: 'trigger-work' }))
  const raised = engine.raiseProjectRequest(request({ root: { trigger_id: 'trigger-work', thread_key: 'feishu:oc_1' } }))
  const accepted = engine.disposeProjectRequest(raised.id, { by: 'lead-orchestrator', action: 'accept', text: 'Go ahead.' })
  expect(accepted.request_id).toBe(key('request', key('lead-request', raised.id)))
  const created = store.requests.get(accepted.request_id ?? '')
  expect(created?.ticketIds).toEqual([key('ticket', raised.id, 'work')])
  expect(accepted.tickets).toEqual(created?.ticketIds)
  const ticket = store.tickets.get(created?.ticketIds[0] ?? '')
  expect(ticket).toMatchObject({ title: 'Add a project status page', project: 'orchestrator' })
  expect(ticket?.mandate.basis).toEqual({ via: 'lead', project: 'orchestrator', project_request_id: raised.id })
  store.close()
})

it('creates the work when the Lead accepts a work request it raised itself, without an external Channel', () => {
  const { engine, store } = open()
  const raised = engine.raiseProjectRequest(request({
    title: 'Review the project for defects', instruction: 'Inspect the clone and raise work for what breaks.',
    raised_by: { session: 'lead-orchestrator', automation: 'auto-1' },
  }))
  expect(raised.raised_by).toEqual({ session: 'lead-orchestrator', automation: 'auto-1' })
  expect(raised.root).toBeUndefined()
  // The same Lead raising the same title again answers the open request instead of creating a second one.
  expect(engine.raiseProjectRequest(request({ title: 'Review the project for defects', instruction: 'Again.',
    raised_by: { session: 'lead-orchestrator', automation: 'auto-2' } })).id).toBe(raised.id)
  const accepted = engine.disposeProjectRequest(raised.id, { by: 'lead-orchestrator', action: 'accept', text: 'Fix it.' })
  expect(accepted.request_id).toBe(key('request', key('lead-request', raised.id)))
  const created = store.requests.get(accepted.request_id ?? '')
  expect(created?.ticketIds).toEqual([key('ticket', key('lead-request', raised.id), 'work')])
  expect(created?.channels).toEqual([])
  const ticket = store.tickets.get(created?.ticketIds[0] ?? '')
  expect(ticket).toMatchObject({ title: 'Review the project for defects', project: 'orchestrator', deliverable: 'change', channels: [] })
  expect(ticket?.mandate.actor).toEqual({ source: 'dsh-superagent', id: 'lead:orchestrator' })
  expect(ticket?.origin.triggerIds).toEqual([])
  store.close()
})

it('refuses approval commands for requests that cannot take them', () => {
  const { engine, store, setClock } = open()
  store.triggers.save(trigger())
  const work = engine.raiseProjectRequest(request())
  refusal(() => engine.planProjectRequest(work.id, { deliverables: [{ project: 'superagent' }] }), 'foreignProjectRequest')
  refusal(() => engine.requestProjectApproval(work.id), 'notArchitectureProjectRequest')
  refusal(() => engine.approveProjectRequest(work.id, { approved: true, trigger_id: 'trigger-root' }), 'notArchitectureProjectRequest')
  const rootless = engine.raiseProjectRequest(request({ kind: 'architecture', title: 'Rootless design', instruction: 'Design it anyway.' }))
  refusal(() => engine.disposeProjectRequest(rootless.id, { by: 'lead-orchestrator', action: 'accept', text: 'Accepted.' }), 'approvalRootRequired')
  const raised = engine.raiseProjectRequest(architecture())
  setClock('2026-11-10T09:01:00.000Z')
  const accepted = engine.disposeProjectRequest(raised.id, { by: 'lead-orchestrator', action: 'accept', text: 'Accepted.' })
  expect(accepted.status).toBe('accepted')
  refusal(() => engine.requestProjectApproval(raised.id), 'designNotEnded')
  store.close()
})
