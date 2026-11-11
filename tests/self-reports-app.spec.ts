/**
 * The self-evolution Issue outlet's application service (docs/014 D3): the three-state Eval gate, jurisdiction refusal,
 * observance vs automatic filing, deduplication against open Issues and recent filed reports, the daily cap, existing
 * labels only, the disclosure body, and the health and log records a failed filing leaves behind.
 */
import { describe, expect, it } from 'vitest'
import { SelfReports, type SelfReportOutcome } from '../src/app/self-reports.ts'
import { SELF_REPORT_DAILY_LIMIT, SELF_REPOSITORY, type SelfReport, type SelfReportRepository, type SelfReportStatus }
  from '../src/core/index.ts'
import type { Health } from '../src/sources/host.ts'
import { SettingsSchema, type Settings } from '../src/policy.ts'

/** Insertion-ordered in-memory `self_report` table: the service's contract without SQLite. */
class MemoryRecords implements SelfReportRepository {
  readonly rows = new Map<string, SelfReport>()
  get(id: string): SelfReport | undefined { return this.rows.get(id) }
  save(report: SelfReport): void { this.rows.set(report.id, report) }
  list(status?: SelfReportStatus): SelfReport[] {
    return [...this.rows.values()].filter(report => status === undefined || report.status === status)
  }
}

/** The GitHub CLI calls the outlet may make: list open Issues, list labels, and create one Issue. */
class FakeCommands {
  issues: { number: number; title?: string; pull_request?: unknown }[] = []
  labels: string[] = []
  readonly writes: { repository: string; method: 'POST' | 'DELETE'; path: string; body?: unknown }[] = []
  readonly reads: string[][] = []
  fail: Error | undefined
  async gh<T>(args: string[]): Promise<T> {
    this.reads.push(args)
    if (args[1]?.includes('/issues?state=open')) return this.issues as T
    if (args[1]?.includes('/labels?per_page=')) return this.labels.map(name => ({ name })) as T
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  async apiWrite(repository: string, method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<string> {
    this.writes.push({ repository, method, path, body })
    if (this.fail) throw this.fail
    return JSON.stringify({ number: 40 + this.writes.length })
  }
}

const AT = '2026-11-10T12:00:00.000Z'
const settings = (selfReport: 'off' | 'observe' | 'auto'): Settings => {
  const base = SettingsSchema.parse({})
  return { ...base, eval: { ...base.eval, selfReport } }
}

function outlet(options: { mode?: 'off' | 'observe' | 'auto'; records?: MemoryRecords; commands?: FakeCommands
  projects?: { repository?: string }[]; now?: string } = {}) {
  const records = options.records ?? new MemoryRecords()
  const commands = options.commands ?? new FakeCommands()
  const health: Health[] = [], logged: string[] = []
  const service = new SelfReports({
    store: { selfReports: records, settings: () => settings(options.mode ?? 'observe') },
    commands, projects: () => options.projects ?? [],
    health: { set: item => health.push(item) }, record: message => logged.push(message),
    now: () => options.now ?? AT, version: () => '0.3.0',
  })
  return { service, records, commands, health, logged }
}

const finding = { title: 'Watcher crashes after a failed poll', evidence: 'The watcher exits with ENOENT in state/watcher.json.',
  reproduction: 'Run the watcher, then stop polling.', session: 'master' }

const filed = (id: string, filedAt: string, issue = 1, title = 'Watcher crashes after a failed poll'): SelfReport => ({
  id, title, body: '', evidence: '', raised_by: { session: 'master' }, target_repo: SELF_REPOSITORY, status: 'filed',
  issue_number: issue, filed_at: filedAt, created_at: filedAt })

describe('self report outlet service', () => {
  it('records nothing in off mode', async () => {
    const h = outlet({ mode: 'off' })
    expect(await h.service.raise(finding)).toEqual({ status: 'off' })
    expect(h.records.list()).toEqual([])
    expect(h.commands.writes).toEqual([])
  })

  it('keeps a draft in the default observe mode, with the session and ticket provenance and the disclosure body', async () => {
    const h = outlet({ mode: 'observe' })
    const outcome = await h.service.raise({ ...finding, ticket: 'ticket-1' }) as Extract<SelfReportOutcome, { status: 'draft' }>
    expect(outcome.status).toBe('draft')
    expect(outcome.reason).toBe('observe')
    expect(outcome.report).toMatchObject({ status: 'draft', target_repo: SELF_REPOSITORY,
      raised_by: { session: 'master', ticket: 'ticket-1' }, created_at: AT, title: finding.title })
    expect(outcome.report.body).toContain('automated agent')
    expect(outcome.report.body).toContain('## Running version\n\nDSH Superagent Further 0.3.0')
    expect(h.records.list()).toEqual([outcome.report])
    expect(h.commands.writes).toEqual([])
    expect(h.service.drafts().map(report => report.id)).toEqual([outcome.report.id])
  })

  it('refuses when the self repository is registered as a project, naming the Request and Ticket route', async () => {
    const h = outlet({ mode: 'auto', projects: [{ repository: 'LouiFinn/DSH-SuperAgent-Further' }] })
    await expect(h.service.raise(finding)).rejects.toMatchObject({ code: 'selfReportJurisdiction',
      values: { repository: SELF_REPOSITORY }, missing: false })
    expect(h.records.list()).toEqual([])
    expect(h.commands.writes).toEqual([])
  })

  it('refuses text with Feishu content and keeps nothing', async () => {
    const h = outlet({ mode: 'auto' })
    await expect(h.service.raise({ ...finding, evidence: 'The chat was om_0123456789abcdef.' }))
      .rejects.toMatchObject({ code: 'selfReportContent', values: { rule: 'Feishu content' } })
    expect(h.records.list()).toEqual([])
  })

  it('files directly in auto mode with only the labels the repository already has', async () => {
    const h = outlet({ mode: 'auto' })
    h.commands.labels = ['bug']
    const outcome = await h.service.raise({ ...finding, labels: ['bug', 'not-a-label'] }) as Extract<SelfReportOutcome, { status: 'filed' }>
    expect(outcome.status).toBe('filed')
    expect(outcome.issue_number).toBe(41)
    expect(outcome.report).toMatchObject({ status: 'filed', issue_number: 41, filed_at: AT })
    expect(h.commands.writes).toEqual([{ repository: SELF_REPOSITORY, method: 'POST', path: 'issues',
      body: { title: finding.title, body: expect.stringContaining('automated agent'), labels: ['bug'] } }])
    expect(h.service.reports('filed')).toEqual([outcome.report])
  })

  it('links an existing open Issue instead of filing a duplicate', async () => {
    const h = outlet({ mode: 'auto' })
    h.commands.issues = [{ number: 9, title: 'watcher crash after failed polling' },
      { number: 12, title: finding.title, pull_request: {} }]
    const outcome = await h.service.raise(finding) as Extract<SelfReportOutcome, { status: 'linked' }>
    expect(outcome.status).toBe('linked')
    expect(outcome.issue_number).toBe(9)
    expect(outcome.report).toMatchObject({ status: 'dismissed', issue_number: 9 })
    expect(h.commands.writes).toEqual([])
  })

  it('links a report this installation filed in the last 14 days, and ignores one older than that', async () => {
    const records = new MemoryRecords()
    records.save(filed('recent', '2026-11-07T09:00:00.000Z', 5))
    const h = outlet({ mode: 'auto', records })
    expect(await h.service.raise(finding)).toMatchObject({ status: 'linked', issue_number: 5 })
    expect(h.commands.writes).toEqual([])

    const older = new MemoryRecords()
    older.save(filed('old', '2026-10-20T09:00:00.000Z', 3))
    const second = outlet({ mode: 'auto', records: older })
    expect(await second.service.raise({ ...finding, title: 'Watcher crashes on start after a failed poll' }))
      .toMatchObject({ status: 'filed' })
    expect(second.commands.writes).toHaveLength(1)
  })

  it('keeps the finding as a draft when the daily cap is reached', async () => {
    const records = new MemoryRecords()
    for (let index = 0; index < SELF_REPORT_DAILY_LIMIT; index++) {
      records.save(filed(`filed-${index}`, '2026-11-10T0${index + 1}:00:00.000Z', 10 + index, `Earlier finding ${index}`))
    }
    const h = outlet({ mode: 'auto', records })
    const outcome = await h.service.raise(finding) as Extract<SelfReportOutcome, { status: 'draft' }>
    expect(outcome.status).toBe('draft')
    expect(outcome.reason).toBe('daily-limit')
    expect(h.commands.writes).toEqual([])
    expect(h.service.drafts()).toHaveLength(1)
    // A person approving it hits the same cap and is told so; the draft stays.
    await expect(h.service.approve(outcome.report.id)).rejects.toMatchObject({ code: 'selfReportLimit', values: { limit: '3' } })
    expect(h.service.drafts()).toHaveLength(1)
  })

  it('approves a draft, files it, and refuses a second approval or an unknown report', async () => {
    const h = outlet({ mode: 'observe' })
    const draft = await h.service.raise(finding) as Extract<SelfReportOutcome, { status: 'draft' }>
    const approved = await h.service.approve(draft.report.id) as Extract<SelfReportOutcome, { status: 'filed' }>
    expect(approved).toMatchObject({ status: 'filed', issue_number: 41 })
    expect(h.service.drafts()).toEqual([])
    await expect(h.service.approve(draft.report.id)).rejects.toMatchObject({ code: 'selfReportNotDraft' })
    await expect(h.service.approve('srep-unknown')).rejects.toMatchObject({ code: 'selfReportUnknown', missing: true })
  })

  it('refuses approval once the self repository becomes a registered project, files nothing, and still dismisses', async () => {
    const projects: { repository?: string }[] = []
    const h = outlet({ mode: 'observe', projects })
    const draft = await h.service.raise(finding) as Extract<SelfReportOutcome, { status: 'draft' }>
    expect(draft.status).toBe('draft')
    // The draft predates the registration: approving it would publish content the mission says must become a Request instead.
    projects.push({ repository: SELF_REPOSITORY })
    h.commands.reads.length = 0
    await expect(h.service.approve(draft.report.id)).rejects.toMatchObject({ code: 'selfReportJurisdiction',
      values: { repository: SELF_REPOSITORY }, missing: false })
    expect(h.commands.reads).toEqual([])
    expect(h.commands.writes).toEqual([])
    expect(h.service.drafts()).toEqual([draft.report])
    // The automatic path stays refused as well, and the draft can still be dismissed.
    await expect(h.service.raise({ ...finding, title: 'The watcher crashes on a second start' }))
      .rejects.toMatchObject({ code: 'selfReportJurisdiction' })
    expect(h.service.drafts()).toHaveLength(1)
    expect(h.service.dismiss(draft.report.id)).toMatchObject({ status: 'dismissed' })
  })

  it('dismisses a draft and refuses to dismiss a filed report', async () => {
    const h = outlet({ mode: 'observe' })
    const draft = await h.service.raise(finding) as Extract<SelfReportOutcome, { status: 'draft' }>
    expect(h.service.dismiss(draft.report.id)).toMatchObject({ id: draft.report.id, status: 'dismissed' })
    expect(h.service.reports()).toEqual([expect.objectContaining({ id: draft.report.id, status: 'dismissed' })])
    await expect(async () => h.service.dismiss(draft.report.id)).rejects.toMatchObject({ code: 'selfReportNotDraft' })

    const second = outlet({ mode: 'auto' })
    const auto = await second.service.raise(finding) as Extract<SelfReportOutcome, { status: 'filed' }>
    expect(() => second.service.dismiss(auto.report.id)).toThrowError(expect.objectContaining({ code: 'selfReportNotDraft' }))
  })

  it('keeps the draft, reports health and logs without the finding text when filing fails', async () => {
    const h = outlet({ mode: 'auto' })
    h.commands.fail = new Error('network down')
    await expect(h.service.raise(finding)).rejects.toMatchObject({ code: 'selfReportFileFailed', values: { error: 'network down' } })
    expect(h.service.drafts()).toHaveLength(1)
    expect(h.health.at(-1)).toMatchObject({ state: 'error', detail: 'Filing a self report failed: network down' })
    expect(h.logged).toEqual([expect.stringContaining('network down')])
    expect(h.logged.join(' ')).not.toContain('ENOENT')
    expect(h.commands.writes).toHaveLength(1)
  })
})
