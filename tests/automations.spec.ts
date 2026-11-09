/** Installation automation tasks: validation and limits, the Host create record and its compensation, edit conflicts, reconciliation and the runtime-context text. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Automations, AUTOMATION_CONTEXT_ORDER, automationEnvelope, type ScheduleCreate, type ScheduleEditRequest,
  type ScheduleService, type ScheduleTask } from '../src/app/automations.ts'
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
    return this.tasks.has(request.id) ? { records: [] } : { id: request.id, code: 'schedule_not_found' }
  }
  async run(request: { id: string }): Promise<ScheduleTask | { id: string; code: string }> {
    const task = this.tasks.get(request.id)
    return task ? { ...task } : { id: request.id, code: 'schedule_not_found' }
  }
  async deleteInactive(): Promise<{ deleted: number }> { return { deleted: 0 } }
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

describe('tool surface and context', () => {
  it('registers exactly the four main-Session automation tools, with no run or delete tool', () => {
    const tools = automationTools(automations, MASTER)
    expect(tools.map(tool => tool.name)).toEqual(['automation_create', 'automation_list', 'automation_view', 'automation_edit'])
    expect(tools.map(tool => tool.description)).toEqual(expect.arrayContaining([expect.stringContaining('explicit human request')]))
    expect(tools.flatMap(tool => tool.description).join(' ')).not.toContain('automation_run')
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
