import { afterEach, describe, expect, it, vi } from 'vitest'
import { leadSessionId } from '../src/app/sessions.ts'
import { key } from '../src/core/index.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined

afterEach(async () => {
  await host?.stop()
  host = undefined
})

async function ticket(running: Host, id: string) {
  return running.acceptedTicket(feishu(id, 'Please review the release note.'))
}

describe('durable user-notice requests with per-level approval (issue #29)', () => {
  it('lets a Lead approve a worker request, then sends the exact words on the Ticket channel', async () => {
    host = await startRuntime()
    const { ticket: accepted } = await ticket(host, 'notice-worker')
    const worker = `worker-${accepted.id}`
    const lead = leadSessionId('default')
    host.deliveries.mockClear()

    const raised = await host.runTool(worker, 'request_user_notice', { text: 'The release is ready to publish.' }) as { notice: { id: string; status: string } }
    expect(raised.notice.status).toBe('pending')
    const listed = await host.runTool(lead, 'lead_notices', {}) as { pending: { id: string; text: string }[] }
    expect(listed.pending.map(entry => entry.id)).toContain(raised.notice.id)
    // The request itself is one information hop upward, so the Lead knows it even before it lists pending requests.
    expect(host.runtime.store.information.byDedupe(key('user-notice-record', raised.notice.id))).toMatchObject({
      kind: 'notice', direction: 'up', source: { role: 'worker' }, target: { role: 'lead' } })

    const decided = await host.runTool(lead, 'lead_notice_decide', { notice_id: raised.notice.id, approve: true }) as { notice: { status: string } }
    expect(decided.notice.status).toBe('approved')
    await host.runtime.idle()
    expect(host.runtime.store.userNotices.get(raised.notice.id)).toMatchObject({ status: 'sent', via: 'channel' })
    expect(host.runtime.store.information.byDedupe(key('user-notice-decision', raised.notice.id))).toMatchObject({
      kind: 'notice', direction: 'down', source: { role: 'lead' }, target: { role: 'worker' }, payload: { approved: true } })
    // A redelivery of the same words is the same durable request.
    const again = await host.runTool(worker, 'request_user_notice', { text: 'The release is ready to publish.' }) as { notice: { id: string } }
    expect(again.notice.id).toBe(raised.notice.id)
    expect(host.runtime.store.userNotices.list().filter(record => record.text === 'The release is ready to publish.')).toHaveLength(1)
  })

  it('refuses without a reason, returns the reason to the raiser, and answers a request once', async () => {
    host = await startRuntime()
    const { ticket: accepted } = await ticket(host, 'notice-refuse')
    const worker = `worker-${accepted.id}`
    const lead = leadSessionId('default')
    host.deliveries.mockClear()
    const raised = await host.runTool(worker, 'request_user_notice', { text: 'Please tell them we are late.' }) as { notice: { id: string } }

    await expect(host.runTool(lead, 'lead_notice_decide', { notice_id: raised.notice.id, approve: false }))
      .rejects.toMatchObject({ code: 'userNoticeReason' })
    const decided = (await host.runTool(lead, 'lead_notice_decide', { notice_id: raised.notice.id, approve: false, reason: 'The delay is not confirmed yet.' })) as
      { notice: { status: string; reason?: string } }
    expect(decided.notice).toMatchObject({ status: 'refused', reason: 'The delay is not confirmed yet.' })
    expect(host.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === worker
      && delivery.text.includes('refused') && delivery.text.includes('The delay is not confirmed yet.'))).toBe(true)
    await expect(host.runTool(lead, 'lead_notice_decide', { notice_id: raised.notice.id, approve: true }))
      .rejects.toMatchObject({ code: 'userNoticeDecided' })
  })

  it('refuses unknown ids and the wrong approver', async () => {
    host = await startRuntime()
    const { ticket: accepted } = await ticket(host, 'notice-wrong')
    const worker = `worker-${accepted.id}`
    const lead = leadSessionId('default')
    const raised = await host.runTool(worker, 'request_user_notice', { text: 'A worker fact.' }) as { notice: { id: string } }
    await expect(host.runTool(lead, 'lead_notice_decide', { notice_id: 'missing', approve: true }))
      .rejects.toMatchObject({ code: 'unknownUserNotice' })
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_notice_decide', { notice_id: raised.notice.id, approve: true }))
      .rejects.toMatchObject({ code: 'userNoticeApprover' })

    const leadRaised = await host.runTool(lead, 'lead_request_user_notice', { text: 'A Lead fact.', ticket_id: accepted.id }) as { notice: { id: string } }
    await expect(host.runTool(lead, 'lead_notice_decide', { notice_id: leadRaised.notice.id, approve: true }))
      .rejects.toMatchObject({ code: 'userNoticeApprover' })
    const listed = await host.runTool(host.runtime.masterId, 'orchestrator_notices', {}) as { notices: { id: string }[] }
    expect(listed.notices.map(entry => entry.id)).toContain(leadRaised.notice.id)
    const approved = (await host.runTool(host.runtime.masterId, 'orchestrator_notice_decide', { notice_id: leadRaised.notice.id, approve: true })) as
      { notice: { status: string } }
    expect(approved.notice.status).toBe('approved')
    await host.runtime.idle()
    expect(host.runtime.store.userNotices.get(leadRaised.notice.id)).toMatchObject({ status: 'sent', via: 'channel' })
    expect(host.runtime.store.information.byDedupe(key('user-notice-decision', leadRaised.notice.id))).toMatchObject({
      source: { role: 'orchestrator' }, target: { role: 'lead' }, direction: 'down' })
    expect(CHAT).toBe('oc_team')
  })

  it('falls back to the alert chat when the request names no Ticket channel', async () => {
    host = await startRuntime()
    const lead = leadSessionId('default')
    await host.acceptedTicket(feishu('notice-alert', 'Warm the Lead up.'))
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
      incidents: { ...settings.executor.incidents, alertChatId: 'oc_alerts' } } })
    const raised = await host.runTool(lead, 'lead_request_user_notice', { text: 'The maintenance window moved.' }) as { notice: { id: string } }
    await host.runTool(host.runtime.masterId, 'orchestrator_notice_decide', { notice_id: raised.notice.id, approve: true })
    await host.runtime.idle()
    expect(host.runtime.store.userNotices.get(raised.notice.id)).toMatchObject({ status: 'sent', via: 'alert' })
  })

  it('makes a delivery failure visible as attention with a durable wake to the Orchestrator', async () => {
    host = await startRuntime()
    const { ticket: accepted } = await ticket(host, 'notice-failure')
    const worker = `worker-${accepted.id}`
    const lead = leadSessionId('default')
    const raised = await host.runTool(worker, 'request_user_notice', { text: 'This must not be lost.' }) as { notice: { id: string } }
    host.runtime.outbox.send = vi.fn(() => { throw new Error('the channel is down') }) as never
    await host.runTool(lead, 'lead_notice_decide', { notice_id: raised.notice.id, approve: true })
    await host.runtime.idle()
    const failed = host.runtime.store.userNotices.get(raised.notice.id)!
    expect(failed.status).toBe('attention')
    expect(failed.error).toContain('the channel is down')
    expect(host.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === host!.runtime.masterId
      && delivery.text.includes('could not be delivered') && delivery.text.includes('This must not be lost.'))).toBe(true)
  })
})
