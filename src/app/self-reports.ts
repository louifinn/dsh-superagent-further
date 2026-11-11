/**
 * The self-evolution Issue outlet (docs/014 D3, schema 24): the durable `self_report` table, and the service that drafts,
 * files, links and dismisses findings about the agent's own repository.
 *
 * The service owns every side effect of the outlet: the jurisdiction check against the registered projects, the three-state
 * Eval gate, deduplication against the target repository's open Issues and the installation's recently filed reports, the
 * daily cap, existing-label filtering, the automated disclosure body, and the health and audit records. Tools and HTTP
 * routes only translate their input and output around it.
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import { checkSelfReportText, composeSelfReportBody, filedSelfReportsToday, recentFiledSelfReports, sameSelfReportTitle,
  SELF_REPORT_DAILY_LIMIT, SELF_REPOSITORY, UserError, type SelfReport, type SelfReportRepository, type SelfReportStatus } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import { sameName } from '../infra/text.ts'
import type { Settings } from '../policy.ts'

/** The three states of the Eval self-report gate (docs/014 D3): record nothing, draft for approval, or file directly. */
export type SelfReportMode = 'off' | 'observe' | 'auto'
/** What raising or approving a finding did: nothing, kept a draft, filed an Issue, or linked an existing one. */
export type SelfReportOutcome =
  | { status: 'off' }
  | { status: 'draft'; report: SelfReport; reason: 'observe' | 'daily-limit' }
  | { status: 'filed'; report: SelfReport; issue_number: number }
  | { status: 'linked'; report: SelfReport; issue_number: number }

/** What a Session found: the text of the finding, who found it, and labels to apply when they already exist. */
export interface SelfReportRaiseInput {
  title: string
  evidence: string
  reproduction: string
  /** The main Session that found the problem. */
  session: string
  /** The Ticket whose worker found it, when a ticket's worker did. */
  ticket?: string
  /** Labels to apply only if the target repository already has them; none by default (docs/014 D3). */
  labels?: string[]
}

/** The host services the outlet needs: settings, durable records, the GitHub CLI, the registered projects, and health. */
export interface SelfReportsHost {
  store: { selfReports: SelfReportRepository; settings(): Settings }
  commands: {
    gh<T>(args: string[]): Promise<T>
    apiWrite(repository: string, method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<string>
  }
  projects: () => readonly { repository?: string }[]
  health?: Pick<HealthEntry, 'set'>
  /** Operational log line for a filing failure; carries the error, never the finding's text. */
  record?: (message: string) => void
  now?: () => string
  /** The running version the Issue body states; defaults to this package's version. */
  version?: () => string
}

/** One Issue as the GitHub REST list returns it, reduced to the fields deduplication reads. */
interface OpenIssue { number: number; title?: string; pull_request?: unknown }
/** One label as the GitHub REST list returns it. */
interface ExistingLabel { name: string }

const require = createRequire(import.meta.url)
/** This package's version, which every Issue body states (docs/014 D3). */
function packageVersion(): string {
  try {
    const pkg = require('dsh-superagent-further/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch { return 'unknown' }
}

/**
 * The `self_report` table: each report's JSON record with the status and update time its listings read, written by the
 * outlet service through the Store's `Repositories.selfReports` repository.
 */
export class SelfReportRecords implements SelfReportRepository {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): SelfReport | undefined {
    const row = this.db.prepare('SELECT value FROM self_report WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as SelfReport : undefined
  }
  /** Saves a report, refreshing the status and update time its listing reads. */
  save(report: SelfReport): void {
    this.db.prepare(`INSERT INTO self_report (id, status, updated, value) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated=excluded.updated, value=excluded.value`)
      .run(report.id, report.status, report.filed_at ?? report.created_at, JSON.stringify(report))
  }
  /** Oldest first; `status` narrows the list to one lifecycle state. */
  list(status?: SelfReportStatus): SelfReport[] {
    const rows = status === undefined ? this.db.prepare('SELECT value FROM self_report ORDER BY rowid').all()
      : this.db.prepare('SELECT value FROM self_report WHERE status=? ORDER BY rowid').all(status)
    return rows.map(row => JSON.parse(String(row.value)) as SelfReport)
  }
}

/** The self-evolution Issue outlet's application service (docs/014 D3). */
export class SelfReports {
  constructor(private readonly host: SelfReportsHost) {
    this.host.health?.set({ state: 'ready', detail: 'The Issue outlet is ready', at: this.now() })
  }
  /** The gate state from the Eval settings block. */
  mode(): SelfReportMode { return this.host.store.settings().eval.selfReport }
  /** The drafts the Overview's review group shows, oldest first. */
  drafts(): SelfReport[] { return this.records().list('draft') }
  /** All records, oldest first, optionally narrowed to one lifecycle state; mostly for tests and diagnostics. */
  reports(status?: SelfReportStatus): SelfReport[] { return this.records().list(status) }

  /**
   * Raise a finding about superagent itself: in `observe` mode keep it as a draft, in `auto` mode file it within the
   * deduplication and daily limits, in `off` mode record nothing (docs/014 D3). The tool refuses when the self repository is
   * a registered project, because then the finding belongs to the Request → Ticket route instead.
   * @throws UserError (`selfReportJurisdiction`) when the self repository is a registered project, (`selfReportInvalid` or
   * `selfReportContent`) when the text breaks the content rules, and (`selfReportFileFailed`) when `auto` filing fails.
   */
  async raise(input: SelfReportRaiseInput): Promise<SelfReportOutcome> {
    this.jurisdiction()
    const mode = this.mode()
    if (mode === 'off') return { status: 'off' }
    const text = checkSelfReportText(input)
    const at = this.now()
    const report: SelfReport = {
      id: `srep-${randomBytes(4).toString('hex')}`,
      title: text.title,
      body: composeSelfReportBody({ evidence: text.evidence, reproduction: text.reproduction, version: this.version() }),
      evidence: text.evidence,
      raised_by: { session: input.session, ...input.ticket === undefined ? {} : { ticket: input.ticket } },
      target_repo: SELF_REPOSITORY,
      status: 'draft',
      created_at: at,
    }
    this.records().save(report)
    if (mode === 'observe') return { status: 'draft', report, reason: 'observe' }
    try { return await this.file(report, input.labels ?? []) } catch (error) {
      // The daily cap is not a failure of this finding: it stays a draft for approval, and the panel says why.
      if (error instanceof UserError && error.code === 'selfReportLimit') return { status: 'draft', report, reason: 'daily-limit' }
      throw error
    }
  }

  /**
   * Approve a draft: file it under the same deduplication and daily limits, or link it to the Issue that already tracks it.
   * @throws UserError when the report is unknown, is not a draft, or the daily cap is reached.
   */
  async approve(id: string): Promise<SelfReportOutcome> {
    const report = this.records().get(id)
    if (!report) throw new UserError('selfReportUnknown', { report: id })
    if (report.status !== 'draft') throw new UserError('selfReportNotDraft')
    return this.file(report, [])
  }

  /**
   * Dismiss a draft permanently. A filed report is the remote Issue's own record and cannot be dismissed here.
   * @throws UserError when the report is unknown or is not a draft.
   */
  dismiss(id: string): SelfReport {
    const report = this.records().get(id)
    if (!report) throw new UserError('selfReportUnknown', { report: id })
    if (report.status !== 'draft') throw new UserError('selfReportNotDraft')
    const dismissed: SelfReport = { ...report, status: 'dismissed' }
    this.records().save(dismissed)
    return dismissed
  }

  /** Every registered project's repository, compared the way the rest of the app compares names. */
  private jurisdiction(): void {
    if (this.host.projects().some(project => project.repository !== undefined && sameName(project.repository, SELF_REPOSITORY))) {
      throw new UserError('selfReportJurisdiction', { repository: SELF_REPOSITORY })
    }
  }
  private records(): SelfReportRepository {
    const records = this.host.store.selfReports
    if (!records) throw new UserError('selfReportInvalid', { reason: 'this store has no self_report table' })
    return records
  }
  private now(): string { return this.host.now?.() ?? new Date().toISOString() }
  private version(): string { return this.host.version?.() ?? packageVersion() }

  /** File one report: a duplicate links instead, a full day's cap refuses, and a failed filing keeps the draft. */
  private async file(report: SelfReport, requested: readonly string[]): Promise<SelfReportOutcome> {
    try {
      const linked = await this.duplicate(report)
      if (linked !== undefined) {
        const dismissed: SelfReport = { ...report, status: 'dismissed', issue_number: linked }
        this.records().save(dismissed)
        return { status: 'linked', report: dismissed, issue_number: linked }
      }
      if (filedSelfReportsToday(this.records().list('filed'), this.now()).length >= SELF_REPORT_DAILY_LIMIT) {
        throw new UserError('selfReportLimit', { limit: String(SELF_REPORT_DAILY_LIMIT) })
      }
      const labels = await this.existingLabels(requested)
      const raw = await this.host.commands.apiWrite(SELF_REPOSITORY, 'POST', 'issues',
        { title: report.title, body: report.body, ...labels.length ? { labels } : {} })
      const created = JSON.parse(raw) as { number?: unknown }
      if (typeof created.number !== 'number') throw new Error('github returned no issue number')
      const filed: SelfReport = { ...report, status: 'filed', issue_number: created.number, filed_at: this.now() }
      this.records().save(filed)
      this.host.health?.set({ state: 'ready', detail: 'The Issue outlet is ready', at: this.now() })
      return { status: 'filed', report: filed, issue_number: created.number }
    } catch (error) {
      if (error instanceof UserError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      this.host.health?.set({ state: 'error', detail: `Filing a self report failed: ${reason}`, at: this.now() })
      this.host.record?.(`self report ${report.id} was not filed: ${reason}`)
      throw new UserError('selfReportFileFailed', { error: reason })
    }
  }
  /** The number of an open Issue or a recently filed report that already tracks this finding, if any. */
  private async duplicate(report: SelfReport): Promise<number | undefined> {
    const issues = await this.host.commands.gh<OpenIssue[]>(['api', `repos/${SELF_REPOSITORY}/issues?state=open&per_page=100`])
    const remote = (Array.isArray(issues) ? issues : [])
      .find(issue => !issue.pull_request && typeof issue.title === 'string' && sameSelfReportTitle(issue.title, report.title))
    if (remote) return remote.number
    const local = recentFiledSelfReports(this.records().list('filed'), this.now())
      .find(candidate => candidate.issue_number !== undefined && sameSelfReportTitle(candidate.title, report.title))
    return local?.issue_number
  }
  /** The labels the target repository already has, out of the requested names; never creates a label (docs/014 D3). */
  private async existingLabels(requested: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(requested.map(name => name.trim()).filter(name => name.length > 0))]
    if (!wanted.length) return []
    const labels = await this.host.commands.gh<ExistingLabel[]>(['api', `repos/${SELF_REPOSITORY}/labels?per_page=100`])
    const known = new Set((Array.isArray(labels) ? labels : []).map(label => label.name))
    return wanted.filter(name => known.has(name))
  }
}
