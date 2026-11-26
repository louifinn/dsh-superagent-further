import { afterEach, describe, expect, it } from 'vitest'
import { leadSessionId } from '../src/app/sessions.ts'
import { directiveChain, key } from '../src/core/index.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined

afterEach(async () => {
  await host?.stop()
  host = undefined
})

/** A Ticket whose worker Session is live, so a person can address any of the three Session kinds. */
async function ticketOf(running: Host, id: string) {
  return running.acceptedTicket(feishu(id, 'Please look at the widget flag.'))
}

describe('unified Directive semantics (issues #20–#22)', () => {
  it('records the same person words at every Session kind and carries structurally similar upward hops', async () => {
    host = await startRuntime()
    const { ticket } = await ticketOf(host, 'directive-kinds')
    const worker = `worker-${ticket.id}`
    const lead = leadSessionId('default')
    const orchestrator = host.runtime.masterId
    host.deliveries.mockClear()

    host.person(worker, 'Worker: rename the flag now.', 'directive-worker')
    host.person(lead, 'Lead: rename the flag now.', 'directive-lead')
    host.person(orchestrator, 'Orchestrator: rename the flag now.', 'directive-orchestrator')
    await host.runtime.idle()

    const records = host.runtime.store.directives.all()
    expect(records.map(record => record.source.role).sort()).toEqual(['lead', 'orchestrator', 'worker'])
    for (const record of records) {
      expect(record.hops).toBe(0)
      expect(record.audience).toEqual(directiveChain(record.source.role))
      expect(record.propagatedAt).toBeDefined()
      const root = host.runtime.store.information.byDedupe(key('directive-record', record.id))!
      expect(root.kind).toBe('instruction')
      expect(root.direction).toBe('in')
      expect(root.oneShot).toBe(true)
      expect(root.source).toEqual({ role: 'person' })
      expect(root.payload).toMatchObject({ text: record.text, origin: record.origin })
    }
    const byRole = (role: string) => records.find(record => record.source.role === role)!
    // The Orchestrator's own Directive has no upward hop; the Lead's has one; the worker's has the adjacent two.
    const hop = (role: string, target: string) => host!.runtime.store.information.byDedupe(key('directive-hop', byRole(role).id, target))
    expect(hop('orchestrator', 'lead')).toBeUndefined()
    expect(hop('lead', 'orchestrator')).toMatchObject({ source: { role: 'lead' }, target: { role: 'orchestrator' }, hops: 1, direction: 'up' })
    expect(hop('worker', 'lead')).toMatchObject({ source: { role: 'worker' }, target: { role: 'lead' }, hops: 1, direction: 'up' })
    expect(hop('worker', 'orchestrator')).toMatchObject({ source: { role: 'lead' }, target: { role: 'orchestrator' }, hops: 2, direction: 'up' })
    for (const role of ['lead', 'worker']) {
      const root = host.runtime.store.information.byDedupe(key('directive-record', byRole(role).id))!
      const leadHop = host.runtime.store.information.byDedupe(key('directive-hop', byRole(role).id, 'lead'))
      if (leadHop) expect(leadHop.parent).toBe(root.id)
      const top = host.runtime.store.information.byDedupe(key('directive-hop', byRole(role).id, 'orchestrator'))!
      expect(top.root).toBe(root.root)
      expect(top.hops).toBe((leadHop?.hops ?? root.hops) + 1)
      expect(top.parent).toBe(leadHop?.id ?? root.id)
      expect(top.payload).toMatchObject({ text: byRole(role).text, origin: byRole(role).origin })
    }
    // The parent knows by its next turn: one queued prompt per hop, none to the addressed Session, and no separate ack round.
    const directivePrompts = (session: string) => host!.deliveries.mock.calls
      .map(([delivery]) => delivery).filter(delivery => delivery.sessionId === session && delivery.text.includes('one-shot Directive'))
    expect(directivePrompts(lead)).toHaveLength(1)
    expect(directivePrompts(orchestrator)).toHaveLength(2)
    expect(directivePrompts(worker)).toEqual([])
  })

  it('propagates a duplicate person message exactly once', async () => {
    host = await startRuntime()
    const { ticket } = await ticketOf(host, 'directive-duplicate')
    const worker = `worker-${ticket.id}`
    const lead = leadSessionId('default')
    host.deliveries.mockClear()
    host.person(worker, 'Only once, please.', 'same-person-message')
    host.person(worker, 'Only once, please.', 'same-person-message')
    await host.runtime.idle()

    expect(host.runtime.store.directives.all().filter(record => record.text === 'Only once, please.')).toHaveLength(1)
    expect(host!.deliveries.mock.calls.filter(([delivery]) => delivery.sessionId === lead
      && delivery.text.includes('Only once, please.'))).toHaveLength(1)
    expect(host!.deliveries.mock.calls.filter(([delivery]) => delivery.sessionId === host!.runtime.masterId
      && delivery.text.includes('Only once, please.'))).toHaveLength(1)
  })

  it('refuses steering the source node while its Directive is unconsumed and audits the refusal', async () => {
    host = await startRuntime()
    const { ticket } = await ticketOf(host, 'directive-lock')
    const worker = `worker-${ticket.id}`
    const lead = leadSessionId('default')
    host.person(worker, 'Do not let the Lead redirect me.', 'directive-locked-worker')

    await expect(host.runTool(lead, 'lead_notify_worker', { session: worker, text: 'Do something else.' }))
      .rejects.toMatchObject({ code: 'directiveSourceLocked' })
    expect(host.runtime.store.boundary.list({ limit: 10 }).filter(row => row.outcome === 'refused' && row.action === 'lead_notify_worker'))
      .toHaveLength(1)

    // The Lead itself is a source too: the Orchestrator may adjust other projects, not that Lead's project, while unconsumed.
    host.person(lead, 'Lead has its own person word.', 'directive-locked-lead')
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_lead_instruction',
      { action: 'note', ticket_id: ticket.id, text: 'Also do something else.' }))
      .rejects.toMatchObject({ code: 'directiveSourceLocked' })
    expect(host.runtime.store.boundary.list({ limit: 10 }).filter(row => row.outcome === 'refused' && row.action === 'orchestrator_lead_instruction'))
      .toHaveLength(1)
  })

  it('requires the worker to report the effect with the original words, then consumes the Directive once', async () => {
    host = await startRuntime()
    const { ticket } = await ticketOf(host, 'directive-report')
    const worker = `worker-${ticket.id}`
    host.person(worker, 'Please update the operator guide.', 'directive-reported')
    const record = host.runtime.store.directives.pendingForTicket(ticket.id)!
    expect(record).toBeDefined()

    await expect(host.runTool(worker, 'orchestrator_report', { state: 'progress', summary: 'Working on it.' }))
      .rejects.toMatchObject({ code: 'directiveReportRequired' })
    await host.runTool(worker, 'orchestrator_report', { state: 'progress', summary: 'Working on it.', directive_effect: 'acted' })
    const consumed = host.runtime.store.directives.get(record.id)!
    expect(consumed.consumedAt).toBeDefined()
    expect(consumed.effect).toBe('acted')
    const report = host.runtime.store.information.byDedupe(key('directive-report', record.id))!
    expect(report.kind).toBe('report')
    expect(report.payload).toMatchObject({ text: 'Please update the operator guide.', effect: 'acted', ticketId: ticket.id })
  })

  it('hands an out-of-Mandate worker Directive back to the Lead with the person words', async () => {
    host = await startRuntime()
    const { ticket } = await ticketOf(host, 'directive-handback')
    const worker = `worker-${ticket.id}`
    const lead = leadSessionId('default')
    host.person(worker, 'Delete the customer database.', 'directive-handback')
    host.deliveries.mockClear()
    await host.runTool(worker, 'orchestrator_report', { state: 'blocked', summary: 'Beyond my Mandate.', directive_effect: 'handback' })
    await host.runtime.idle()
    expect(host.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === lead
      && delivery.text.includes('hands back') && delivery.text.includes('Delete the customer database.'))).toBe(true)
    expect(host.runtime.store.directives.pendingForTicket(ticket.id)).toBeUndefined()
  })

  it('consumes a Lead Directive when its own turn ends, and exposes pending Directives read-only to the Orchestrator', async () => {
    host = await startRuntime()
    const { ticket } = await ticketOf(host, 'directive-lead-turn')
    const lead = leadSessionId('default')
    host.person(host.runtime.masterId, 'Orchestrator: keep the release note.', 'directive-orchestrator-pending')
    host.person(lead, 'Lead: keep the release note.', 'directive-lead-pending')

    const listed = await host.runTool(host.runtime.masterId, 'orchestrator_directives', {}) as { directives: Record<string, unknown>[] }
    expect(listed.directives.map(entry => entry.text)).toEqual(expect.arrayContaining(['Orchestrator: keep the release note.', 'Lead: keep the release note.']))
    const read = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'directives' })
    expect(JSON.stringify(read)).toContain('Lead: keep the release note.')

    const agent = host.agents.get(lead)!
    agent.status = 'running'
    host.ctx.emit('agent/status', { agent, status: 'running' } as never)
    agent.status = 'idle'
    host.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    const leadRecord = host.runtime.store.directives.all().find(record => record.text === 'Lead: keep the release note.')!
    expect(leadRecord.consumedAt).toBeDefined()
    // The Orchestrator's own Directive is consumed by its own turn end, not the Lead's.
    const orchestratorRecord = host.runtime.store.directives.all().find(record => record.text === 'Orchestrator: keep the release note.')!
    expect(orchestratorRecord.consumedAt).toBeUndefined()
    expect(ticket.project).toBe('default')
    expect(CHAT).toBe('oc_team')
  })
})
