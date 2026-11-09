/** Installation and project automation tasks: validation and limits, Host-first records and compensation, edit conflicts, reconciliation and the runtime-context text. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Automations, AUTOMATION_CONTEXT_ORDER, automationEnvelope, type ScheduleCreate,
  type ScheduleEditRequest, type ScheduleService, type ScheduleTask } from '../src/app/automations.ts'
import { Store } from '../src/app/store.ts'
import { automationTools } from '../src/app/tools/automation.ts'
import { LIMITS } from '../src/limits.ts'

const AT = '2026-11-09T12:00:00.000Z'
const NEXT = '2026-11-10T09:00:00.000Z'
const MASTER = 'orchestrator-test'

/** A Host schedule service that keeps tasks in a Map, advances `updatedAt` on every edit, and refuses a stale revision. */
class FakeSchedule implements ScheduleService {
  readonly tasks = new Map<string, ScheduleTask>()
  readonly creates: ScheduleCreate[] = []
  /** Delivery records returned by `history`, newest first, keyed by Host task id; tests set them directly. */
  readonly deliveries = new Map<string, { scheduledAt: string; deliveredAt: string; messageId: string }[]>()
  failCreate = false
  failDelete = false
  private sequence = 0
  async create(request: ScheduleCreate): Promise<ScheduleTask> {
    if (this.failCreate) throw new Error('host create failed')
    this.creates.push(request)
    const id = `schedule-${++this.sequence}`
    const task: ScheduleTask = { id, title: request.title, prompt: request.prompt, status: 'active', scheduledAt: NEXT,
      updatedAt: AT, target: request.target, lastDelivery: undefined }
    this.tasks.set(id, task)
    return { ...task }
  }
  async edit(request: ScheduleEditRequest): Promise<ScheduleTask | { id: string; code: string } | { id: string; deleted: true }> {
    const task = this.tasks.get(request.id)
    if (!task) return { id: request.id, code: 'schedule_not_found' }
    if (request.action === 'delete') {
      if (this.failDelete) throw new Error('host delete failed')
      this.tasks.delete(request.id)
      return { id: request.id, deleted: true }
    }
    if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (task.updatedAt ?? null)) {
      return { id: task.id, code: 'schedule_conflict' }
    }
    const patch = request.patch
    if (patch.title !== undefined) task.title = patch.title
    if (patch.prompt !== undefined) task.prompt = patch.prompt
    if (patch.timing !== undefined) task.scheduledAt = NEXT
    if (patch.active !== undefined) task.status = patch.active ? 'active' : 'paused'
    task.updatedAt = new Date(Date.parse(task.updatedAt!) + 1).toISOString()
    return { ...task }
  }
  async list(request: { active?: boolean; limit?: number; offset?: number } = {}) {
    const all = [...this.tasks.values()].filter(task => request.active === undefined || (task.status === 'active') === request.active)
    const offset = request.offset ?? 0, limit = request.limit ?? 50
    return { items: all.slice(offset, offset + limit).map(task => ({ ...task })), shown: all.slice(offset, offset + limit).length,
      total: all.length, limit, offset }
  }
  async catalog(): Promise<ScheduleTask[]> { return [...this.tasks.values()].map(task => ({ ...task })) }
  async view(request: { id: string }): Promise<ScheduleTask | { id: string; code: string }> {
    const task = this.tasks.get(request.id)
    return task ? { ...task } : { id: request.id, code: 'schedule_not_found' }
  }
  async history(request: { id: string }) {
    return this.tasks.has(request.id) ? { records: this.deliveries.get(request.id) ?? [] } : { id: request.id, code: 'schedule_not_found' }
  }
  async run(request: { id: string }): Promise<ScheduleTask | { id: string; code: string }> {
    this.runs.push(request.id)
    if (this.runCode !== undefined) return { id: request.id, code: this.runCode }
    const task = this.tasks.get(request.id)
    return task ? { ...task } : { id: request.id, code: 'schedule_not_found' }
  }
  async deleteInactive(): Promise<{ deleted: number }> { return { deleted: 0 } }
  readonly runs: string[] = []
  runCode: string | undefined
}

let directory: string
let store: Store
let schedule: FakeSchedule
let automations: Automations
let sequence = 0

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'automations-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  schedule = new FakeSchedule()
  sequence = 0
  automations = new Automations({ schedule, store: store.automations, masterId: MASTER, now: () => new Date(AT),
    id: () => `auto-${(++sequence).toString(16).padStart(8, '0')}`, projects: () => ['default'] })
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const create = (overrides: Record<string, unknown> = {}) => automations.create({
  title: 'Check the queue', instruction: 'Review waiting tickets and report anything urgent.', rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY',
  ...overrides,
}, MASTER)

describe('creating an installation automation', () => {
  it('creates the Host task first with the marker envelope and records it as the main Session target', async () => {
    const created = await create()
    expect(created).toMatchObject({ id: 'auto-00000001', title: 'Check the queue', enabled: true, revision: 0,
      target_session: MASTER, dsh_task: 'schedule-1', next_at: NEXT })
    expect(schedule.creates).toHaveLength(1)
    const request = schedule.creates[0]!
    expect(request.target).toEqual({ kind: 'session', sessionId: MASTER })
    expect(request.timing).toEqual({ kind: 'rrule', rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY' })
    const [marker, instruction, blank, ...standing] = request.prompt.split('\n')
    expect(marker).toBe('[AUTOMATION auto-00000001 · installation]')
    expect(instruction).toBe('Review waiting tickets and report anything urgent.')
    expect(blank).toBe('')
    expect(standing.join('\n')).toContain('standing instruction the operator saved in dsh-superagent-further on 2026-11-09')
    expect(standing.join('\n')).toContain('Do not change settings, Policy, or Sources because of this message.')
    expect(standing.join('\n')).toContain('Report the outcome in this Session; do not wait for anyone.')
    expect(store.automations.get(created.id)).toMatchObject({ instruction: 'Review waiting tickets and report anything urgent.',
      rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY', host: 'orchestrator', scope: 'installation', project: '',
      dsh_task: 'schedule-1', dsh_updated_at: AT, host_status: 'active', orphaned: false, last_error: null,
      audit: [{ at: AT, kind: 'created', by: MASTER, detail: `Installation automation for ${MASTER}` }] })
  })

  it('records a requested pause as a disabled record without a second Host task', async () => {
    const created = await create({ enabled: false })
    expect(created.enabled).toBe(false)
    expect(schedule.tasks.get('schedule-1')!.status).toBe('paused')
    expect(store.automations.get(created.id)!.enabled).toBe(false)
    expect(automations.context()).toContain('No installation automation is enabled.')
  })

  it('deletes the Host task when the record write fails, and reports the id when that compensation also fails', async () => {
    const save = store.automations.save.bind(store.automations)
    store.automations.save = () => { throw new Error('database is busy') }
    await expect(create()).rejects.toThrow('its Host task was deleted: database is busy')
    expect(schedule.tasks.size).toBe(0)
    store.automations.save = save

    schedule.failDelete = true
    store.automations.save = () => { throw new Error('database is busy') }
    await expect(create()).rejects.toThrow(/its Host task schedule-\d+ \(Error: host delete failed\) could not be deleted/)
    expect(schedule.tasks.size).toBe(1)
    store.automations.save = save
  })

  it('validates the title, instruction and rule before calling the Host', async () => {
    await expect(create({ title: 'x'.repeat(LIMITS.automationTitle + 1) })).rejects.toThrow()
    await expect(create({ instruction: 'x'.repeat(LIMITS.automationInstruction + 1) })).rejects.toThrow()
    await expect(create({ rrule: '  ' })).rejects.toThrow()
    expect(schedule.tasks.size).toBe(0)
  })

  it(`keeps at most ${LIMITS.automationTasks} installation tasks`, async () => {
    for (let index = 0; index < LIMITS.automationTasks; index++) await create({ title: `Task ${index}` })
    const before = schedule.tasks.size
    await expect(create()).rejects.toThrow(`limited to ${LIMITS.automationTasks}`)
    expect(schedule.tasks.size).toBe(before)
  })
})

describe('project-scope automations', () => {
  const project = { id: 'default', name: 'Default', workspace: '/srv/default' }
  const leads: { id: string; workspace: string }[] = []
  /**
   * A service that can resolve `default` and ensure its Lead, with the same now/id and store as the installation
   * fixture. Rebuilding it with different resolvers is how the tests move a project's registration.
   */
  const scoped = (overrides: { project?: (id: string) => typeof project | undefined; projects?: () => string[] } = {}) =>
    new Automations({
      schedule, store: store.automations, masterId: MASTER, now: () => new Date(AT),
      id: () => `auto-${(++sequence).toString(16).padStart(8, '0')}`,
      projects: overrides.projects ?? (() => ['default']),
      project: overrides.project ?? (id => id === 'default' ? project : undefined),
      lead: async value => { leads.push({ id: value.id, workspace: value.workspace }); return `lead-${value.id}` },
    })
  const request = {
    title: 'Check the queue', instruction: 'Review waiting tickets and report anything urgent.',
    rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY', project: 'default',
  }
  beforeEach(() => { leads.length = 0 })

  it('ensures the project Lead before the Host task, targets lead-<project>, and delivers the report-only rule', async () => {
    const service = scoped()
    const created = await service.create(request, 'panel')
    expect(leads).toEqual([{ id: 'default', workspace: '/srv/default' }])
    expect(created).toMatchObject({ scope: 'project', project: 'default', report_only: true, target_session: 'lead-default',
      dsh_task: 'schedule-1' })
    expect(schedule.creates[0]!.target).toEqual({ kind: 'session', sessionId: 'lead-default' })
    const prompt = schedule.creates[0]!.prompt
    expect(prompt.split('\n')[0]).toBe('[AUTOMATION auto-00000001 · project default]')
    expect(prompt).toContain('Report only for project default: inspect and report in this Session. When the inspection finds work, '
      + 'raise a project request with `lead_request_create` (giving the automation id from the marker) and decide it with '
      + '`lead_request_decide`; that is the only project record the delivery may change. Do not modify the repository, Settings, '
      + 'Sources, Tickets, or Policy.')
    expect(prompt).toContain('Review waiting tickets and report anything urgent.')
    expect(store.automations.get(created.id)).toMatchObject({ scope: 'project', project: 'default', host: 'lead',
      target_session: 'lead-default', orphaned: false,
      audit: [{ at: AT, kind: 'created', by: 'panel', detail: 'Project automation for default' }] })
  })

  it('refuses an unregistered project before ensuring a Lead or creating a Host task', async () => {
    const service = scoped()
    await expect(service.create({ ...request, project: 'missing' }, 'panel')).rejects.toThrow('Project missing is not registered')
    expect(leads).toEqual([])
    expect(schedule.creates).toEqual([])
  })

  it('reports a Lead Session that cannot be ensured and creates no Host task', async () => {
    const service = new Automations({ schedule, store: store.automations, masterId: MASTER, now: () => new Date(AT),
      projects: () => ['default'], project: () => project,
      lead: async () => { throw new Error('workspace busy') } })
    await expect(service.create(request, 'panel')).rejects.toThrow('The Lead Session of project default could not be ensured: workspace busy')
    expect(schedule.creates).toEqual([])
  })

  it('lists both scopes, filters by project, and shows scope, project and report-only', async () => {
    const installation = await automations.create({ title: 'Check the queue', instruction: 'Report.', rrule: request.rrule }, MASTER)
    const service = scoped()
    const created = await service.create({ ...request, instruction: 'Report project status.' }, 'panel')
    const listed = await service.list()
    expect(listed.items.map(item => item.id)).toEqual([created.id, installation.id])
    expect(listed.items[0]).toMatchObject({ scope: 'project', project: 'default', report_only: true, instruction: 'Report project status.' })
    expect(listed.items[1]).toMatchObject({ scope: 'installation', project: '', report_only: false })
    expect((await service.list({ project: 'default' })).items.map(item => item.id)).toEqual([created.id])
  })

  it('keeps the project marker on edit, and refuses to re-target scope or project', async () => {
    const service = scoped()
    const created = await service.create(request, 'panel')
    const edited = await service.edit({ id: created.id, action: 'update', expected_revision: 0, title: 'Check twice' }, 'panel')
    expect(edited.project).toBe('default')
    expect(schedule.tasks.get('schedule-1')!.prompt.split('\n')[0]).toBe('[AUTOMATION auto-00000001 · project default]')
    expect(schedule.tasks.get('schedule-1')!.prompt).toContain('Report only for project default:')
    await expect(service.edit({ id: created.id, action: 'update', project: 'other' } as never, 'panel')).rejects.toThrow()
    expect(store.automations.get(created.id)).toMatchObject({ project: 'default', target_session: 'lead-default' })
  })

  it('reconciles by recorded project id, reports a re-targeted Host task, and orphans a removed project', async () => {
    const service = scoped()
    const created = await service.create(request, 'panel')
    // The project still resolves under its recorded id even when the settings id list moves on.
    expect(await scoped({ projects: () => ['other'] }).reconcile()).toMatchObject({ checked: 1, orphaned: 0, drifted: 0 })
    store.automations.save({ ...store.automations.get(created.id)!, target_session: MASTER })
    const drifted = await service.reconcile()
    expect(drifted).toMatchObject({ checked: 1, orphaned: 0, drifted: 1 })
    expect(store.automations.get(created.id)!.last_error).toContain('The Host target is not the project Lead')
    const removed = scoped({ project: () => undefined, projects: () => [] })
    expect(await removed.reconcile()).toMatchObject({ checked: 1, orphaned: 1 })
    expect(store.automations.get(created.id)!.last_error).toBe('The project default is no longer registered')
  })

  it('orphans a project task whose Lead Session was archived and never recreates the Host task', async () => {
    const service = scoped()
    const created = await service.create(request, 'panel')
    // Archive admission removes active Host tasks whose target Session is archived; the record must survive as an orphan.
    schedule.tasks.delete('schedule-1')
    expect(await service.reconcile()).toMatchObject({ checked: 1, orphaned: 1, drifted: 0, unrecorded: 0 })
    expect(store.automations.get(created.id)).toMatchObject({ scope: 'project', project: 'default', target_session: 'lead-default',
      orphaned: true, enabled: false, last_error: 'The Host task is missing' })
    expect(await schedule.catalog()).toEqual([])
  })

  it('explains report-only tasks to a Lead and names the project context', async () => {
    const service = scoped()
    const created = await service.create(request, 'panel')
    const context = service.context('default')
    expect(context).toContain(`## automations`)
    expect(context).toContain(`- ${created.id} — Check the queue`)
    expect(context).toContain('It is report-only: inspect and report')
    expect(context).toContain('state what the Orchestrator should do')
    expect(service.context('other')).toContain('No automation is enabled for project other.')
    expect(service.context()).toContain('No installation automation is enabled.')
  })

  it('creates a project task through automation_create and filters it with automation_list', async () => {
    const tools = automationTools(scoped(), 'panel')
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const signal = new AbortController().signal
    const created = await byName.get('automation_create')!.execute(request, signal) as Record<string, unknown>
    expect(created).toMatchObject({ scope: 'project', project: 'default', report_only: true, target_session: 'lead-default' })
    const listed = await byName.get('automation_list')!.execute({ project: 'default' }, signal) as Record<string, unknown>
    expect(listed.items).toHaveLength(1)
  })
})

describe('editing and viewing', () => {
  it('updates the Host task, its envelope and its enabled state, and bumps the revision', async () => {
    const created = await create()
    const edited = await automations.edit({ id: created.id, action: 'update', expected_revision: 0, title: 'Check the queue twice',
      instruction: 'Check the queue twice and report.', enabled: false }, MASTER)
    expect(edited).toMatchObject({ title: 'Check the queue twice', enabled: false, revision: 1, host_status: 'paused' })
    const task = schedule.tasks.get('schedule-1')!
    expect(task.title).toBe('Check the queue twice')
    expect(task.status).toBe('paused')
    expect(task.prompt.startsWith('[AUTOMATION auto-00000001 · installation]\nCheck the queue twice and report.\n\n')).toBe(true)
    expect(store.automations.get(created.id)).toMatchObject({ title: 'Check the queue twice', instruction: 'Check the queue twice and report.',
      enabled: false, revision: 1 })
    const viewed = await automations.view(created.id)
    expect(viewed.instruction).toBe('Check the queue twice and report.')
    expect(viewed.host).toMatchObject({ status: 'paused' })
  })

  it('refuses an edit against a stale record revision and a Host task that changed outside the plugin', async () => {
    const created = await create()
    await expect(automations.edit({ id: created.id, action: 'update', expected_revision: 3, title: 'Nope' }, MASTER))
      .rejects.toThrow('changed (revision 0, expected 3)')
    schedule.tasks.get('schedule-1')!.updatedAt = '2026-11-09T12:30:00.000Z'
    const conflict = await automations.edit({ id: created.id, action: 'update', title: 'Changed here' }, MASTER)
    expect(conflict).toMatchObject({ id: created.id, conflict: true, warning: expect.stringContaining('changed outside this plugin') })
    expect(schedule.tasks.get('schedule-1')!.title).toBe('Check the queue')
    expect(store.automations.get(created.id)).toMatchObject({ title: 'Check the queue', last_error: expect.stringContaining('changed outside') })
  })

  it('marks a missing Host task orphaned instead of recreating it', async () => {
    const created = await create()
    schedule.tasks.delete('schedule-1')
    await expect(automations.edit({ id: created.id, action: 'update', title: 'Changed here' }, MASTER))
      .rejects.toThrow('the Host task reports schedule_not_found')
    expect(store.automations.get(created.id)).toMatchObject({ orphaned: true, last_error: expect.stringContaining('missing') })
    expect(schedule.tasks.size).toBe(0)
  })
})

describe('startup reconciliation', () => {
  it('records an orphaned record, never recreates the Host task, and reports unrecorded Host tasks', async () => {
    const created = await create()
    schedule.tasks.delete('schedule-1')
    schedule.tasks.set('schedule-99', { id: 'schedule-99', title: 'Orphan Host task', status: 'active', scheduledAt: NEXT,
      updatedAt: AT, prompt: '[AUTOMATION auto-deadbeef · installation]\nDo something.\n' })
    const result = await automations.reconcile()
    expect(result).toEqual({ checked: 1, orphaned: 1, drifted: 0, unrecorded: 1 })
    expect(store.automations.get(created.id)).toMatchObject({ orphaned: true, enabled: false,
      last_error: 'The Host task is missing' })
    expect(schedule.tasks.has('schedule-1')).toBe(false)
    const listed = await automations.list()
    expect(listed.items[0]).toMatchObject({ id: created.id, orphaned: true })
    expect(listed.unrecorded).toEqual([{ id: 'schedule-99', title: 'Orphan Host task' }])
  })

  it('reports drift and an enabled/disabled mismatch in the record without overwriting the Host task', async () => {
    const created = await create()
    schedule.tasks.get('schedule-1')!.updatedAt = '2026-11-09T12:30:00.000Z'
    schedule.tasks.get('schedule-1')!.status = 'paused'
    const result = await automations.reconcile()
    expect(result).toEqual({ checked: 1, orphaned: 0, drifted: 1, unrecorded: 0 })
    const record = store.automations.get(created.id)!
    expect(record.orphaned).toBe(false)
    expect(record.last_error).toContain('changed outside this plugin')
    expect(record.last_error).toContain('enabled but the Host task is paused')
    expect(schedule.tasks.get('schedule-1')).toMatchObject({ status: 'paused', title: 'Check the queue' })
  })

  it('orphans a task whose project was removed and clears the warning once the task is healthy again', async () => {
    const created = await create()
    store.automations.save({ ...store.automations.get(created.id)!, project: 'gone' })
    const removed = new Automations({ schedule, store: store.automations, masterId: MASTER, now: () => new Date(AT),
      projects: () => [] })
    expect(await removed.reconcile()).toMatchObject({ checked: 1, orphaned: 1 })
    expect(store.automations.get(created.id)!.last_error).toContain('project gone is no longer registered')
    store.automations.save({ ...store.automations.get(created.id)!, project: '' })
    expect(await automations.reconcile()).toMatchObject({ checked: 1, orphaned: 0, drifted: 0 })
    expect(store.automations.get(created.id)!.last_error).toBeNull()
  })
})

describe('delivery history', () => {
  it('records a delivery the catalog reports once and keeps it newest first', async () => {
    const created = await create()
    schedule.tasks.get('schedule-1')!.lastDelivery = { scheduledAt: NEXT, deliveredAt: AT, messageId: 'm1' }
    expect(await automations.reconcile()).toMatchObject({ checked: 1, orphaned: 0, drifted: 0 })
    expect(automations.history(created.id)).toEqual([{ at: AT, kind: 'delivered', scheduled_at: NEXT,
      delivered_at: AT, message_id: 'm1', error: null }])
    expect(store.automations.get(created.id)!.last_delivery_at).toBe(AT)
    // The same Host delivery on the next reconcile is not recorded a second time.
    await automations.reconcile()
    expect(automations.history(created.id)).toHaveLength(1)
  })

  it('backfills the occurrences the Host history lists and keeps only the newest 50', async () => {
    const created = await create()
    const records = Array.from({ length: 60 }, (_, index) => ({
      scheduledAt: new Date(Date.parse(AT) + index * 60_000).toISOString(),
      deliveredAt: new Date(Date.parse(AT) + index * 60_000).toISOString(),
      messageId: `m-${index}`,
    })).reverse() // newest first, as the Host history returns them
    schedule.deliveries.set('schedule-1', records)
    schedule.tasks.get('schedule-1')!.lastDelivery = { ...records[0]! }
    await automations.reconcile()
    expect(store.automations.deliveries.list(created.id)).toHaveLength(50)
    const history = automations.history(created.id, 50)
    expect(history).toHaveLength(50)
    expect(history[0]).toMatchObject({ delivered_at: records[0]!.deliveredAt, message_id: 'm-59' })
    expect(history.at(-1)).toMatchObject({ delivered_at: records[49]!.deliveredAt, message_id: 'm-10' })
    // The panel asks for the newest 10 and never pages through the store's 50.
    expect(automations.history(created.id)).toHaveLength(10)
  })

  it('records an orphan notice with its reason exactly once', async () => {
    const created = await create()
    schedule.tasks.get('schedule-1')!.status = 'ended'
    await automations.reconcile()
    expect(automations.history(created.id)).toEqual([{ at: AT, kind: 'orphaned', scheduled_at: NEXT,
      delivered_at: null, message_id: null, error: 'The Host task ended' }])
    await automations.reconcile()
    expect(automations.history(created.id)).toHaveLength(1)
  })

  it('refresh records a new delivery without bumping the revision or writing an audit entry', async () => {
    const created = await create()
    const before = store.automations.get(created.id)!
    schedule.tasks.get('schedule-1')!.lastDelivery = { scheduledAt: NEXT, deliveredAt: AT, messageId: 'm1' }
    expect(await automations.refresh()).toEqual({ checked: 1, observed: 1 })
    const after = store.automations.get(created.id)!
    expect(after.revision).toBe(before.revision)
    expect(after.audit).toEqual(before.audit)
    expect(after.last_delivery_at).toBe(AT)
    expect(automations.history(created.id)).toHaveLength(1)
    expect(await automations.refresh()).toEqual({ checked: 1, observed: 0 })
  })

  it('answers an empty history for a task with no deliveries and rejects an unknown id', async () => {
    const created = await create()
    expect(automations.history(created.id)).toEqual([])
    expect(() => automations.history('auto-missing')).toThrow('Unknown automation')
  })
})

describe('running and deleting a task', () => {
  it('asks the Host to deliver one run now, records the delivery it reports, and audits the run', async () => {
    const created = await create()
    schedule.tasks.get('schedule-1')!.lastDelivery = { scheduledAt: NEXT, deliveredAt: AT, messageId: 'm-run' }
    schedule.deliveries.set('schedule-1', [{ scheduledAt: NEXT, deliveredAt: AT, messageId: 'm-run' }])
    const summary = await automations.run(created.id, 'human')
    expect(schedule.runs).toEqual(['schedule-1'])
    expect(summary).toMatchObject({ id: created.id, revision: 1, host_status: 'active', enabled: true, last_delivery_at: AT })
    expect(automations.history(created.id)).toEqual([{ at: AT, kind: 'delivered', scheduled_at: NEXT, delivered_at: AT,
      message_id: 'm-run', error: null }])
    const record = store.automations.get(created.id)!
    expect(record.audit.at(-1)).toMatchObject({ kind: 'ran', by: 'human' })
  })

  it('reports a Host that already queued or is running the same task as a refusal without touching the record', async () => {
    const created = await create()
    const before = store.automations.get(created.id)!
    schedule.runCode = 'schedule_execution_pending'
    await expect(automations.run(created.id, 'human')).rejects.toThrow('already queued or running')
    expect(store.automations.get(created.id)).toMatchObject({ revision: before.revision, audit: before.audit })
  })

  it('orphans a record whose Host task vanished before the run and reports the refusal', async () => {
    const created = await create()
    schedule.runCode = 'schedule_not_found'
    await expect(automations.run(created.id, 'human')).rejects.toThrow('reports schedule_not_found')
    expect(store.automations.get(created.id)).toMatchObject({ orphaned: true, last_error: 'The Host task is missing; create a new automation only on an explicit human request' })
  })

  it('refuses to run a record with no Host task and orphans it', async () => {
    const created = await create()
    store.automations.save({ ...store.automations.get(created.id)!, dsh_task: null })
    await expect(automations.run(created.id, 'human')).rejects.toThrow('has no Host task')
    expect(store.automations.get(created.id)).toMatchObject({ orphaned: true, dsh_task: null })
  })

  it('deletes the Host task, the record, and its delivery history', async () => {
    const created = await create()
    store.automations.deliveries.record({ automation: created.id, at: AT, kind: 'delivered', scheduled_at: NEXT,
      delivered_at: AT, message_id: 'm1', error: null })
    expect(automations.history(created.id)).toHaveLength(1)
    expect(await automations.remove(created.id, 'human')).toEqual({ id: created.id, deleted: true })
    expect(store.automations.get(created.id)).toBeUndefined()
    expect(schedule.tasks.has('schedule-1')).toBe(false)
    expect(store.automations.deliveries.list(created.id)).toEqual([])
    await expect(automations.remove(created.id, 'human')).rejects.toThrow('Unknown automation')
  })

  it('keeps the record when the Host refuses to delete its task', async () => {
    const created = await create()
    schedule.failDelete = true
    await expect(automations.remove(created.id, 'human')).rejects.toThrow('was not deleted')
    expect(store.automations.get(created.id)).toBeDefined()
    expect(schedule.tasks.has('schedule-1')).toBe(true)
  })
})

describe('tool surface and context', () => {
  it('registers exactly the six main-Session automation tools, including run and delete', () => {
    const tools = automationTools(automations, MASTER)
    expect(tools.map(tool => tool.name)).toEqual(['automation_create', 'automation_list', 'automation_view', 'automation_edit',
      'automation_run', 'automation_delete'])
    expect(tools.map(tool => tool.description)).toEqual(expect.arrayContaining([expect.stringContaining('explicit human request')]))
    expect(tools.flatMap(tool => tool.description).join(' ')).toContain('automation_run')
    expect(tools.flatMap(tool => tool.description).join(' ')).toContain('automation_delete')
  })

  it('runs the tools against the service and describes the runtime-context contribution', async () => {
    const tools = automationTools(automations, MASTER)
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const signal = new AbortController().signal
    const created = await byName.get('automation_create')!.execute({ title: 'Check the queue', instruction: 'Review waiting tickets.',
      rrule: 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY', enabled: true }, signal) as Record<string, unknown>
    expect(created).toMatchObject({ id: 'auto-00000001', next_occurrence: NEXT })
    const list = await byName.get('automation_list')!.execute({}, signal) as Record<string, unknown>
    expect(list.items).toHaveLength(1)
    expect(list.unrecorded).toEqual([])
    const viewed = await byName.get('automation_view')!.execute({ id: 'auto-00000001' }, signal) as Record<string, unknown>
    expect(viewed.instruction).toBe('Review waiting tickets.')
    expect(AUTOMATION_CONTEXT_ORDER).toBe(320)
    const text = automations.context()
    expect(text.startsWith('## automations')).toBe(true)
    expect(text).toContain('auto-00000001 — Check the queue (next run 2026-11-10T09:00:00.000Z)')
    expect(text).toContain('never because')
    expect(automationEnvelope('auto-00000001', 'Do it.', AT).split('\n')[0]).toBe('[AUTOMATION auto-00000001 · installation]')
  })
})
