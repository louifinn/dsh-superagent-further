import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ticketCard } from '../src/app/cards.ts'
import { assessmentOutcome, type Assessment } from '../src/policy.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined

afterEach(async () => {
  await host?.stop()
  host = undefined
})

const scope = { repository: 'acme/widgets', ref: 'main', standard: 'No dead code and no unhandled promise rejections.' }

describe('review deliverable subtype (issue #34)', () => {
  it('accepts a review with its named subject and runs it read-only', async () => {
    host = await startRuntime()
    const { ticket, sessionId } = await host.acceptedTicket(feishu('review-subject', 'Review the whole widgets repository.'),
      'review', { review_scope: scope })
    expect(ticket.deliverable).toBe('review')
    expect(ticket.reviewScope).toEqual(scope)
    expect(ticket.follows ?? []).toEqual([])
    expect(host.permissionPresets.set.mock.calls.some(([, preset]) => preset === 'read-only')).toBe(true)
    expect(host.runtime.store.tickets.get(ticket.id)!.deliverable).toBe('review')
    expect(sessionId).toBe(`worker-${ticket.id}`)
  })

  it('refuses a review accept without the standard it is judged against, with a correction hint', async () => {
    host = await startRuntime()
    host.runtime.receive(feishu('review-no-scope', 'Review the repository.'))
    await host.runtime.idle()
    await expect(host.route({ kind: 'accept', trigger_id: 'review-no-scope', title: 'Review', deliverable: 'review', acknowledgement: '收到。' }))
      .rejects.toThrow(/review_scope\.standard/)
    await expect(host.route({ kind: 'accept', trigger_id: 'review-no-scope', title: 'Review', deliverable: 'change', acknowledgement: '收到。',
      worktree_name: 'review-change', review_scope: scope })).rejects.toThrow(/review_scope/)
  })

  it('records a blocked verdict, keeps the Ticket open, and accepts a clean ready report once', async () => {
    host = await startRuntime()
    const { ticket } = await host.acceptedTicket(feishu('review-blocked', 'Review the release.'), 'review', { review_scope: scope })
    const worker = `worker-${ticket.id}`
    await expect(host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Found problems.',
      review: { verdict: 'blocked', coverage: 'Every file under src/', findings: ['Dead branch in card.ts'] } }))
      .rejects.toMatchObject({ code: 'reviewBlocked' })
    expect(host.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()

    await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Clean now.', review: {
      verdict: 'clean', coverage: 'Every file under src/', evidence: ['pnpm check is green'] } })
    const done = host.runtime.store.tickets.get(ticket.id)!
    expect(done.ended).toMatchObject({ outcome: 'completed' })
    expect(done.reviewReport).toMatchObject({ verdict: 'clean', coverage: 'Every file under src/', evidence: ['pnpm check is green'] })
    expect(done.follows ?? []).toEqual([])
  })

  it('refuses a ready review report without a verdict and one without coverage', async () => {
    host = await startRuntime()
    const { ticket } = await host.acceptedTicket(feishu('review-report', 'Review the docs.'), 'review', { review_scope: scope })
    const worker = `worker-${ticket.id}`
    await expect(host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Looks fine.' }))
      .rejects.toMatchObject({ code: 'reviewReportMissing' })
    await expect(host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Looks fine.',
      review: { verdict: 'clean', coverage: '   ' } })).rejects.toMatchObject({ code: 'reviewCoverageMissing' })
  })

  it('labels the review on its Ticket card, including the subject and the coverage once reported', async () => {
    host = await startRuntime()
    const { ticket } = await host.acceptedTicket(feishu('review-card', 'Review the CLI.'), 'review', { review_scope: scope })
    const card = ticketCard(ticket)
    expect(card).toMatchObject({ deliverable: 'review', review_scope: scope })
    await host.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'Reading the CLI.',
      review: { verdict: 'clean', coverage: 'Packages cli/**' } })
    const reported = ticketCard(host.runtime.store.tickets.get(ticket.id)!)
    expect(reported.review_report).toMatchObject({ verdict: 'clean', coverage: 'Packages cli/**' })
  })

  it('accepts two review subjects of one request and reports one aggregate result', async () => {
    host = await startRuntime()
    const second = join(host.directory, 'second')
    mkdirSync(second, { recursive: true })
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, projects: [...settings.executor.projects,
      { id: 'second', name: 'Second', workspace: second, repository: 'acme/other', branch: '' }] } })
    const trigger = feishu('review-two', 'Review both repositories.')
    host.runtime.receive(trigger)
    await host.runtime.idle()
    const result = await host.route({ kind: 'accept', trigger_id: trigger.id, title: 'Review both repositories',
      acknowledgement: '收到。', deliverable: 'review', review_scope: { standard: 'No dead code.' }, deliverables: [
        { title: 'Review widgets', project: 'default' }, { title: 'Review other', project: 'second' }] })
    const tickets = result.ticket as { ticket_id: string }
    const first = host.runtime.store.tickets.get(tickets.ticket_id)!
    const ids = host.runtime.store.requests.get(first.requestId!)!.ticketIds
    expect(ids.length).toBe(2)
    const reviews = ids.map(id => host!.runtime.store.tickets.get(id)!)
    expect(reviews.every(review => review.deliverable === 'review')).toBe(true)
    expect(reviews.map(review => review.reviewScope?.standard)).toEqual(['No dead code.', 'No dead code.'])
    expect(new Set(reviews.map(review => review.requestId)).size).toBe(1)
  })

  it('refuses a change accept that matched the review rule, naming the review subtype', async () => {
    host = await startRuntime()
    const settings = host.runtime.store.settings()
    const enabled = settings.policy.rules.filter(rule => rule.enabled)
    const assessment = {
      decision: 'accept', title: 'Review the repository', scope: 'whole repository', reason: 'A review was asked for.',
      intent_evidence: 'The person asked for a review of the whole repository.', acknowledgement: '收到。',
      deliverable: 'change',
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false,
        evidence: 'The person asked for a review of the whole repository.' },
      rule_assessments: enabled.map(rule => ({ rule_id: rule.id, matched: rule.id === 'review', reason: rule.id === 'review' ? 'A review.' : 'Not this rule.' })),
    } as unknown as Assessment
    expect(() => assessmentOutcome(assessment, settings, 'explicit')).toThrowError(expect.objectContaining({ code: 'reviewNeedsSubtype' }))
    expect(() => assessmentOutcome({ ...assessment, deliverable: 'review' }, settings, 'explicit'))
      .toThrowError(expect.objectContaining({ code: 'reviewNeedsScope' }))
    const outcome = assessmentOutcome({ ...assessment, deliverable: 'review', review_scope: { standard: 'No dead code.' } }, settings, 'explicit')
    expect(outcome).toMatchObject({ kind: 'accept', deliverable: 'review', review_scope: { standard: 'No dead code.' } })
  })
})
