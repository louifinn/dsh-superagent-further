/**
 * The self-evolution Issue outlet's durable record (docs/014 D3, schema 24): a finding about the agent's own repository
 * that the main Session raised, either as a draft a person approves or as an Issue the outlet filed itself.
 *
 * The record is `draft` at first, `filed` once it has an Issue number and `dismissed` when a person drops it or the outlet
 * finds that an Issue already tracks it. The repository itself is the history of filed Issues; the Store keeps this table
 * for drafts, deduplication, the daily cap and the audit trail.
 */
import { UserError } from './errors.ts'

/** The repository the Issue outlet always targets. It is a code constant, not a setting: a fork of this fork changes it. */
export const SELF_REPOSITORY = 'louifinn/dsh-superagent-further'
/** The most Issues the outlet may file for one installation in one day (docs/014 D3). */
export const SELF_REPORT_DAILY_LIMIT = 3
/** How many days of filed self reports deduplicate a new finding (docs/014 D3). */
export const SELF_REPORT_DEDUPE_DAYS = 14
/** The longest title, and the longest evidence or reproduction text, one self report accepts. */
export const SELF_REPORT_TITLE_LIMIT = 120
export const SELF_REPORT_TEXT_LIMIT = 8000
/** The disclosure every Issue body opens with: it says an automated agent wrote it and that a person may have reviewed it. */
export const SELF_REPORT_DISCLOSURE = 'This Issue was raised by the self-evolution outlet of DSH Superagent Further, an automated agent. '
  + 'It states evidence, reproduction and the running version so a person can check it before relying on it.'

/** Lifecycle of a self report: a draft awaiting approval, a filed Issue, or a dismissed finding. */
export type SelfReportStatus = 'draft' | 'filed' | 'dismissed'
/** Who raised the finding: the main Session and, for a ticket's worker, the ticket it came from. */
export interface SelfReportRaisedBy { session: string; ticket?: string }
/**
 * One durable self report (schema 24). `issue_number` and `filed_at` are present only after filing; a draft or a dismissed
 * finding has neither, except a finding dismissed because an Issue already tracked it, which keeps that Issue number.
 */
export interface SelfReport {
  id: string
  title: string
  body: string
  evidence: string
  raised_by: SelfReportRaisedBy
  target_repo: string
  status: SelfReportStatus
  issue_number?: number
  filed_at?: string
  created_at: string
}
/** The self-report records of a schema 24 Store, read oldest first. */
export interface SelfReportRepository {
  get(id: string): SelfReport | undefined
  save(report: SelfReport): void
  /** Oldest first; `status` narrows the list to one lifecycle state. */
  list(status?: SelfReportStatus): SelfReport[]
}

/** The text a caller supplies for a self report; `body` is composed from it after validation. */
export interface SelfReportTextInput { title: string; evidence: string; reproduction: string }
/** Text that passed the content rules, trimmed. */
export type SelfReportText = SelfReportTextInput
/** Why a body failed the content rules, named as the panel and the tool message name it. */
export type SelfReportRule = 'Feishu content' | 'credentials' | 'private local paths'

const RULES: readonly { rule: SelfReportRule; pattern: RegExp }[] = [
  // Feishu open ids (chat, message and user), union ids and app ids never belong in a public Issue. The union and app
  // forms require a digit, so an ordinary code identifier such as `on_keydown` stays valid.
  { rule: 'Feishu content', pattern: /\b(?:oc|om|ou)_[0-9a-f]{8,}\b/i },
  { rule: 'Feishu content', pattern: /\bon_(?=[0-9a-z]*\d)[0-9a-z]{8,}\b/i },
  { rule: 'Feishu content', pattern: /\bcli_(?=[0-9a-z]*\d)[0-9a-z]{8,}\b/i },
  // Credentials of every kind the agent may see in its environment.
  { rule: 'credentials', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { rule: 'credentials', pattern: /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/ },
  { rule: 'credentials', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'credentials', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'credentials', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i },
  { rule: 'credentials', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Absolute paths of the operator's machine, which a public Issue must not publish. The drive-letter and UNC patterns
  // accept Unicode segment names, the POSIX pattern names the homes and system roots, and none matches an ordinary URL.
  { rule: 'private local paths', pattern: /\b[A-Za-z]:[\\/][^\s"'`<>|?*]+/u },
  { rule: 'private local paths', pattern: /\\\\[\p{L}\p{N}][\p{L}\p{N}._-]*\\[^\s"'`<>|?*]+/u },
  { rule: 'private local paths', pattern: /(?:^|[\s("'`])\/(?:home|Users|root|opt|srv|var|tmp|mnt|Volumes|private)\/[\p{L}\p{N}._$-]+/u },
]

/**
 * Validate and normalize the text of a self report: the title, evidence and reproduction must be present and bounded, and
 * no part may carry Feishu content, credentials or private local paths (docs/014 D3).
 * @throws UserError (`selfReportInvalid` or `selfReportContent`) describing the first missing, long or forbidden part.
 */
export function checkSelfReportText(input: SelfReportTextInput): SelfReportText {
  const title = input.title.trim(), evidence = input.evidence.trim(), reproduction = input.reproduction.trim()
  if (!title) throw new UserError('selfReportInvalid', { reason: 'a title is required' })
  if (!evidence) throw new UserError('selfReportInvalid', { reason: 'evidence is required' })
  if (!reproduction) throw new UserError('selfReportInvalid', { reason: 'reproduction steps are required' })
  if (title.length > SELF_REPORT_TITLE_LIMIT) throw new UserError('selfReportInvalid', { reason: `the title is longer than ${SELF_REPORT_TITLE_LIMIT} characters` })
  if (evidence.length > SELF_REPORT_TEXT_LIMIT) throw new UserError('selfReportInvalid', { reason: `the evidence is longer than ${SELF_REPORT_TEXT_LIMIT} characters` })
  if (reproduction.length > SELF_REPORT_TEXT_LIMIT) throw new UserError('selfReportInvalid', { reason: `the reproduction is longer than ${SELF_REPORT_TEXT_LIMIT} characters` })
  const scanned = `${title}\n${evidence}\n${reproduction}`
  for (const { rule, pattern } of RULES) {
    if (pattern.test(scanned)) throw new UserError('selfReportContent', { rule })
  }
  return { title, evidence, reproduction }
}

/**
 * The Issue body: the automated-agent disclosure first, then the evidence, the reproduction and the running version, in
 * the repository's own language and Markdown conventions (docs/014 D3).
 */
export function composeSelfReportBody(input: { evidence: string; reproduction: string; version: string }): string {
  return [
    SELF_REPORT_DISCLOSURE,
    '',
    '## Evidence',
    '',
    input.evidence.trim(),
    '',
    '## Reproduction',
    '',
    input.reproduction.trim(),
    '',
    '## Running version',
    '',
    `DSH Superagent Further ${input.version.trim()}`,
  ].join('\n')
}

/** A title reduced to lowercase words, so punctuation and spacing never defeat deduplication. */
export function selfReportTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'at', 'it', 'is', 'are', 'was', 'with',
  'after', 'before', 'when', 'from', 'by', 'this', 'that', 'be', 'as', 'if', 'into', 'its', 'not', 'no', 'but', 'than', 'then', 'them'])

/** The significant words of a title, used to recognise the same finding phrased differently. */
export function selfReportKeywords(title: string): string[] {
  return [...new Set(selfReportTitleKey(title).split(' ').filter(word => word.length >= 4 && !STOPWORDS.has(word)))]
}

/** Whether two titles describe the same finding: the same key, or at least two significant words in common. */
export function sameSelfReportTitle(a: string, b: string): boolean {
  if (selfReportTitleKey(a) === selfReportTitleKey(b)) return true
  const left = new Set(selfReportKeywords(a)), right = new Set(selfReportKeywords(b))
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared >= 2
}

/** The filed reports whose filing date is the same day as `at` (the daily cap counts these). */
export function filedSelfReportsToday(reports: readonly SelfReport[], at: string): SelfReport[] {
  const day = at.slice(0, 10)
  return reports.filter(report => report.status === 'filed' && report.filed_at?.slice(0, 10) === day)
}

/** The filed reports from the last `days` days before `at`, which deduplicate a new finding. */
export function recentFiledSelfReports(reports: readonly SelfReport[], at: string, days = SELF_REPORT_DEDUPE_DAYS): SelfReport[] {
  const since = Date.parse(at) - days * 86_400_000
  return reports.filter(report => report.status === 'filed' && report.filed_at !== undefined && Date.parse(report.filed_at) >= since)
}
