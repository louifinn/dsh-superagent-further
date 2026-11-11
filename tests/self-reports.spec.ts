/**
 * The self-evolution Issue outlet's pure rules (docs/014 D3): the fixed target repository and limits, the content rules
 * that keep private material out of a public Issue, the disclosure body, and the title/day-window helpers the service's
 * deduplication and daily cap rely on.
 */
import { describe, expect, it } from 'vitest'
import { checkSelfReportText, composeSelfReportBody, filedSelfReportsToday, recentFiledSelfReports, sameSelfReportTitle,
  selfReportKeywords, selfReportTitleKey, SELF_REPORT_DAILY_LIMIT, SELF_REPORT_DEDUPE_DAYS, SELF_REPORT_DISCLOSURE,
  SELF_REPORT_TEXT_LIMIT, SELF_REPORT_TITLE_LIMIT, SELF_REPOSITORY, UserError, type SelfReport, type UserErrorCode }
  from '../src/core/index.ts'

const text = (over: Partial<{ title: string; evidence: string; reproduction: string }> = {}) => ({ title: 'Watcher crashes after a failed poll',
  evidence: 'The watcher exits with ENOENT in state/watcher.json after one failed poll.', reproduction: 'Run the watcher, then stop polling.',
  ...over })

/** Run `work` and return the UserError code it threw, failing when it throws anything else or nothing. */
function errorCode(work: () => unknown): { code: UserErrorCode; values: Record<string, string> } {
  try { work() } catch (error) {
    if (!(error instanceof UserError)) throw error
    return { code: error.code, values: error.values }
  }
  throw new Error('expected a UserError')
}

const report = (over: Partial<SelfReport> = {}): SelfReport => ({ id: 'srep-1', title: 'Watcher crashes', body: '', evidence: '',
  raised_by: { session: 'master' }, target_repo: SELF_REPOSITORY, status: 'filed', issue_number: 1,
  filed_at: '2026-11-10T09:00:00.000Z', created_at: '2026-11-10T08:00:00.000Z', ...over })

describe('self report outlet rules', () => {
  it('targets one fixed repository and names the documented limits', () => {
    expect(SELF_REPOSITORY).toBe('louifinn/dsh-superagent-further')
    expect(SELF_REPORT_DAILY_LIMIT).toBe(3)
    expect(SELF_REPORT_DEDUPE_DAYS).toBe(14)
    expect(SELF_REPORT_TITLE_LIMIT).toBe(120)
    expect(SELF_REPORT_TEXT_LIMIT).toBe(8000)
  })

  it('accepts a checkable finding and trims every part', () => {
    expect(checkSelfReportText(text({ title: '  Watcher crashes  ', evidence: '  ENOENT  ', reproduction: '  Run it  ' })))
      .toEqual({ title: 'Watcher crashes', evidence: 'ENOENT', reproduction: 'Run it' })
  })

  it('refuses a missing or oversized part with the reason', () => {
    expect(errorCode(() => checkSelfReportText(text({ title: '  ' }))).code).toBe('selfReportInvalid')
    expect(errorCode(() => checkSelfReportText(text({ evidence: ' ' }))).values.reason).toBe('evidence is required')
    expect(errorCode(() => checkSelfReportText(text({ reproduction: '' }))).values.reason).toBe('reproduction steps are required')
    expect(errorCode(() => checkSelfReportText(text({ title: 'x'.repeat(SELF_REPORT_TITLE_LIMIT + 1) }))).values.reason)
      .toContain('title is longer')
    expect(errorCode(() => checkSelfReportText(text({ evidence: 'x'.repeat(SELF_REPORT_TEXT_LIMIT + 1) }))).values.reason)
      .toContain('evidence is longer')
  })

  it('refuses Feishu content, credentials and private local paths with the rule it broke', () => {
    for (const finding of ['Chat om_0123456789abcdef was private', 'The token ghp_0123456789abcdefghijklmnop leaked',
      'A Bearer abcdefghijklmnopqrstuvwxyz token', 'AKIAABCDEFGHIJKLMNOP was in the log', 'The key sk-0123456789abcdefghijkl was logged',
      'The file C:\\Users\\alice\\secret.txt was read', 'The share \\\\fileserver\\private\\log.md was read', 'The file /home/alice/.config was read']) {
      const failure = errorCode(() => checkSelfReportText(text({ evidence: finding })))
      expect(failure.code, finding).toBe('selfReportContent')
      expect(failure.values.rule, finding).toMatch(/Feishu content|credentials|private local paths/)
    }
    // The same material in the title or reproduction is refused too, not only in evidence.
    expect(errorCode(() => checkSelfReportText(text({ title: 'om_0123456789abcdef' }))).code).toBe('selfReportContent')
    expect(errorCode(() => checkSelfReportText(text({ reproduction: '/home/alice/run.sh' }))).code).toBe('selfReportContent')
  })

  it('composes an Issue body that opens with the automated-agent disclosure and states evidence, reproduction and version', () => {
    const body = composeSelfReportBody({ evidence: 'ENOENT', reproduction: 'Run it', version: '0.3.0' })
    expect(body.startsWith(SELF_REPORT_DISCLOSURE)).toBe(true)
    expect(body).toContain('## Evidence\n\nENOENT')
    expect(body).toContain('## Reproduction\n\nRun it')
    expect(body).toContain('## Running version\n\nDSH Superagent Further 0.3.0')
  })

  it('recognises the same finding by title key or two significant words, and unrelated titles differ', () => {
    expect(selfReportTitleKey('Watcher crashes: after failed poll!')).toBe('watcher crashes after failed poll')
    expect(selfReportKeywords('The watcher crashes after a failed poll')).toEqual(['watcher', 'crashes', 'failed', 'poll'])
    expect(sameSelfReportTitle('Watcher crashes after a failed poll', 'watcher crash after failed polling')).toBe(true)
    expect(sameSelfReportTitle('Watcher crashes after a failed poll', 'Labels are not refreshed when a pull request closes')).toBe(false)
  })

  it('counts today\'s filed reports and only the last 14 days of filed reports for deduplication', () => {
    const reports = [
      report({ id: 'today-1' }),
      report({ id: 'today-2', filed_at: '2026-11-10T23:59:59.000Z' }),
      report({ id: 'yesterday', filed_at: '2026-11-09T23:59:59.000Z' }),
      report({ id: 'recent', filed_at: '2026-11-01T00:00:00.000Z' }),
      report({ id: 'old', filed_at: '2026-10-20T00:00:00.000Z' }),
      report({ id: 'draft', status: 'draft', filed_at: undefined, issue_number: undefined }),
    ]
    expect(filedSelfReportsToday(reports, '2026-11-10T12:00:00.000Z').map(item => item.id)).toEqual(['today-1', 'today-2'])
    expect(recentFiledSelfReports(reports, '2026-11-10T12:00:00.000Z').map(item => item.id))
      .toEqual(['today-1', 'today-2', 'yesterday', 'recent'])
  })
})
