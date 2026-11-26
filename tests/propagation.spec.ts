import { afterEach, describe, expect, it } from 'vitest'
import { leadSessionId } from '../src/app/sessions.ts'
import type { InfoRecord } from '../src/core/information.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import {
  PROPAGATION_SCENARIOS, recordPaths, scenarioProblems, traceProblems, traceReport, type PropagationScenario,
} from './fixtures/propagation.ts'

let host: Host | undefined

afterEach(async () => {
  await host?.stop()
  host = undefined
})

const scenario = (id: PropagationScenario['id']): PropagationScenario => PROPAGATION_SCENARIOS.find(entry => entry.id === id)!

/** The durable worker report the Lead turns upward, as production does (worker → Lead → Orchestrator). */
async function relayUp(running: Host, project = 'default'): Promise<void> {
  const lead = await running.runtime.sessions.ensureLead(project, running.directory, project)
  const message = running.runtime.store.leads.list(project, 50).find(item => item.requestId.startsWith('executor-report:'))
  if (!message) throw new Error('no worker report reached the Lead')
  await running.runTool(lead.id, 'lead_report', { report_id: message.requestId.slice('executor-report:'.length) })
  await running.runtime.idle()
}

/** Asserts one docs/016 promise over the run's records, with a trace line that names the paths it saw. */
function expectScenario(running: Host, records: readonly InfoRecord[], value: PropagationScenario): void {
  const all = running.runtime.store.information.all()
  const problems = scenarioProblems(all, records, value)
  if (problems.length > 0) console.info(traceReport(all, records, value))
  expect(problems).toEqual([])
}

/** Registers a second project next to the fixture's `default`, as the cross-project relay needs one. */
function addProject(running: Host, id: string, repository: string): void {
  const settings = running.runtime.store.settings()
  running.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, projects: [...settings.executor.projects,
    { id, name: id, workspace: `${running.directory}/${id}`, repository, branch: '' }] } })
}

describe('propagation rehearsal: one fact, one tree (issue #38)', () => {
  it('P1/P4/P5/P10: a normal Ticket carries each fact between adjacent levels with its provenance', async () => {
    host = await startRuntime()
    const { sessionId } = await host.acceptedTicket(feishu('prop-1', '@bot 请修复重试按钮'), 'answer')
    await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'The retry guard is in place.' })
    await host.runtime.idle()
    await relayUp(host)
    const records = host.runtime.store.information.all()
    expectScenario(host, records, scenario('P1'))
    expectScenario(host, records, scenario('P10'))
    // The upward hop keeps the worker's words and names the same Ticket.
    expect(recordPaths(records).get('worker-lead')).toBe(1)
    const carrier = records.find(record => record.source.role === 'worker' && record.target.role === 'lead')!
    expect(JSON.stringify(carrier.payload)).toContain('The retry guard is in place.')
    // The upward records were delivered, not just written.
    expect(carrier.deliveredAt).toBeDefined()
  })

  it('P2/P6/P9: two workers reach each other only through their Lead, and the reviewer gate stays out of the tree', async () => {
    host = await startRuntime()
    const first = await host.acceptedTicket(feishu('prop-2a', '@bot 第一个改动'))
    const second = await host.acceptedTicket(feishu('prop-2b', '@bot 第二个改动'))
    const lead = leadSessionId('default')
    await host.runTool(second.sessionId, 'request_user_notice', { text: 'Second worker is halfway.' })
    await host.runtime.idle()
    await host.runTool(lead, 'lead_relay_worker', { from_ticket_id: second.ticket.id, to_ticket_id: first.ticket.id, text: 'The sibling work moved.' })
    await host.runtime.idle()
    const records = host.runtime.store.information.all()
    expectScenario(host, records, scenario('P2'))
    expectScenario(host, records, scenario('P6'))
    expectScenario(host, records, scenario('P9'))
    expect(recordPaths(records).get('lead-worker')).toBeGreaterThanOrEqual(1)
    // A same-level edge is never written, even though the Lead carried the fact.
    expect(records.some(record => record.source.role === 'worker' && record.target.role === 'worker')).toBe(false)
    // The independent reviewer is a Lead quality gate, not a second tree: it writes no information row of its own.
    const before = host.runtime.store.information.count()
    await host.runTool(lead, 'lead_review', { ticket_id: first.ticket.id })
    await host.runTool(lead, 'lead_review_record', { ticket_id: first.ticket.id, state: 'clean', summary: 'Read the diff; it is sound.' })
    expect(host.runtime.store.tickets.get(first.ticket.id)!.review?.state).toBe('clean')
    expect(host.runtime.store.information.count()).toBe(before)
  }, 30_000)

  it('P3/P7/P12: a failed report reaches its owner and the top in the same turn', async () => {
    host = await startRuntime()
    const { ticket, sessionId } = await host.acceptedTicket(feishu('prop-3', '@bot 发布失败'))
    await host.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'The release command failed.' })
    await host.runtime.idle()
    await relayUp(host)
    const records = host.runtime.store.information.all()
    expectScenario(host, records, scenario('P3'))
    expectScenario(host, records, scenario('P12'))
    // A skipped edge (orchestrator ↔ worker) never appears; the failure climbed adjacent hops.
    expect(traceProblems(records)).toEqual([])
    expect(records.some(record => (record.source.role === 'orchestrator' && record.target.role === 'worker')
      || (record.source.role === 'worker' && record.target.role === 'orchestrator'))).toBe(false)
    // The failure has a name and a path: the worker reported it to the Lead, and the Lead's relay reached the top.
    const reported = records.find(record => record.source.role === 'worker' && record.target.role === 'lead')!
    expect(JSON.stringify(reported.payload)).toContain('The release command failed.')
    expect(host.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === host!.runtime.masterId
      && delivery.text.includes('The release command failed.'))).toBe(true)
    // The failure stays owned rather than vanishing: the assignment carries it and the Ticket remains open for a retry.
    const live = host.runtime.store.tickets.get(ticket.id)!
    expect(live.ended).toBeUndefined()
    expect(live.assignments.at(-1)!.report?.state).toBe('failed')
  })

  it('P8: a person\'s word is recorded once at each addressed level and never used to steer the source', async () => {
    host = await startRuntime()
    const { ticket } = await host.acceptedTicket(feishu('prop-4', '@bot 改一下开关'))
    const worker = `worker-${ticket.id}`
    const lead = leadSessionId('default')
    const text = 'Rename the flag before the release.'
    host.person(lead, text, 'prop-person-lead')
    host.person(lead, text, 'prop-person-lead') // A redelivery is the same fact, not a second adjustment.
    host.person(worker, text, 'prop-person-worker')
    host.person(host.runtime.masterId, text, 'prop-person-orchestrator')
    await host.runtime.idle()
    const records = host.runtime.store.information.all()
    expectScenario(host, records, scenario('P8'))
    expectScenario(host, records, scenario('P4'))
    expectScenario(host, records, scenario('P5'))
    expectScenario(host, records, scenario('P7'))
    expect(recordPaths(records).get('person-lead')).toBe(1)
    expect(recordPaths(records).get('person-worker')).toBe(1)
    expect(recordPaths(records).get('person-orchestrator')).toBe(1)
    // The worker's word reached the Lead and the Lead carried it to the Orchestrator with the same text and root.
    const upwardHop = records.find(record => record.source.role === 'lead' && record.target.role === 'orchestrator'
      && JSON.stringify(record.payload).includes('prop-person-worker'))!
    expect(upwardHop.direction).toBe('up')
    expect(upwardHop.deliveredAt).toBeDefined()
    expect(upwardHop.root).toBe(records.find(record => record.source.role === 'person' && record.target.role === 'worker')!.root)
    // The source node is protected: the Lead may not steer the person-addressed worker while its word is unconsumed.
    await expect(host.runTool(lead, 'lead_notify_worker', { session: worker, text: 'Do something else.' }))
      .rejects.toMatchObject({ code: 'directiveSourceLocked' })
    expect(host.runtime.store.boundary.list({ limit: 10 }).filter(row => row.outcome === 'refused'
      && row.action === 'lead_notify_worker')).toHaveLength(1)
    // Every addressed record is one-shot and carries the original words into its upward hops.
    for (const record of records.filter(entry => entry.source.role === 'person')) {
      expect(record.oneShot).toBe(true)
      expect(JSON.stringify(record.payload)).toContain(text)
    }
  })

  it('P9: a user-notice request walks the approval chain and is delivered once', async () => {
    host = await startRuntime()
    const { ticket } = await host.acceptedTicket(feishu('prop-6', '@bot 通知我发布结果'))
    const worker = `worker-${ticket.id}`
    const lead = leadSessionId('default')
    host.deliveries.mockClear()
    const raised = await host.runTool(worker, 'request_user_notice', { text: 'The release is ready to publish.' }) as { notice: { id: string } }
    await host.runTool(lead, 'lead_notice_decide', { notice_id: raised.notice.id, approve: true })
    await host.runtime.idle()
    const records = host.runtime.store.information.all()
    expectScenario(host, records, scenario('P9'))
    // The request climbed one adjacent hop and the decision came back down the same edge; each is one record.
    expect(recordPaths(records).get('worker-lead')).toBe(1)
    expect(recordPaths(records).get('lead-worker')).toBe(1)
    expect(host.runtime.store.userNotices.get(raised.notice.id)).toMatchObject({ status: 'sent', via: 'channel' })
    // A redelivery of the same words is the same durable request, so the person hears the fact once.
    const again = await host.runTool(worker, 'request_user_notice', { text: 'The release is ready to publish.' }) as { notice: { id: string } }
    expect(again.notice.id).toBe(raised.notice.id)
    expect(host.runtime.store.userNotices.list().filter(record => record.text === 'The release is ready to publish.')).toHaveLength(1)
  })

  it('P11: a routine progress report stays internal and notifies the person of nothing', async () => {
    host = await startRuntime()
    const { sessionId } = await host.acceptedTicket(feishu('prop-5', '@bot 进展如何'), 'answer')
    const before = host.runtime.store.information.count()
    await host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Still investigating the margin.' })
    await host.runtime.idle()
    const records = host.runtime.store.information.all().slice(before)
    expectScenario(host, records, scenario('P11'))
    expect(records).toEqual([])
    expect(host.runtime.store.information.all().some(record => record.target.role === 'person')).toBe(false)
    expect(host.runtime.store.information.all().filter(record => record.kind === 'report')).toHaveLength(0)
  })

  it('P4/P6: a cross-project fact travels Lead → Orchestrator → the target Lead and reverses nowhere', async () => {
    host = await startRuntime()
    addProject(host, 'lib', 'acme/lib')
    await host.runtime.sessions.ensureLead('default', `${host.directory}/default`, 'Default')
    await host.runtime.sessions.ensureLead('lib', `${host.directory}/lib`, 'Lib')
    const relayed = await host.runTool('lead-default', 'lead_relay', { to_project: 'lib', text: 'The shared parser changed.' }) as { relayed: boolean }
    expect(relayed.relayed).toBe(true)
    const inbox = await host.runTool(host.runtime.masterId, 'orchestrator_relays', {}) as { relays: { id: string }[] }
    await host.runTool(host.runtime.masterId, 'orchestrator_relay_forward', { relay_id: inbox.relays[0]!.id, project: 'lib' })
    await host.runtime.idle()
    const records = host.runtime.store.information.all().filter(record => record.kind === 'relay')
    expect(records).toHaveLength(2)
    const source = records.find(record => record.source.role === 'lead')!
    const forward = records.find(record => record.source.role === 'orchestrator')!
    expect(forward.parent).toBe(source.id)
    expect(forward.hops).toBe(1)
    expect(forward.root).toBe(source.root)
    expect(JSON.stringify(forward.payload)).toContain('The shared parser changed.')
    expect(traceProblems(host.runtime.store.information.all())).toEqual([])
  })

  it('matrix: every P1–P12 promise is declared once and names only legal, required paths', () => {
    expect(PROPAGATION_SCENARIOS.map(entry => entry.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12'])
    for (const entry of PROPAGATION_SCENARIOS) {
      // P11 proves a fact that legitimately stays internal: its only promise is the absence of a notification.
      if (entry.id !== 'P11') expect(entry.paths.length, `${entry.id} declares no path`).toBeGreaterThan(0)
      expect(entry.title.length, `${entry.id} has no title`).toBeGreaterThan(0)
    }
  })
})
