/**
 * The incident model (ADR-0004): what a deterministic detector reports, how two reports of the same
 * condition are recognised as one record, and which status changes a record may take. Detection is pure and makes no
 * model call; a fingerprint is a stable hash over the rule, the normalized scope ids and a digit-normalized detail,
 * so a repeating count or a new identifier never creates a second record for the same condition.
 */
import { createHash } from 'node:crypto'
import { UserError } from './errors.ts'

/** Ascending severity; `minimumSeverity` in the Executor settings keeps the quieter records out of the panel. */
export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type IncidentSeverity = typeof INCIDENT_SEVERITIES[number]
export const INCIDENT_SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = { low: 0, medium: 1, high: 2, critical: 3 }

export const INCIDENT_STATUSES = ['detected', 'bundled', 'diagnosed', 'resolved', 'dismissed'] as const
export type IncidentStatus = typeof INCIDENT_STATUSES[number]

/**
 * Every deterministic rule M33 knows. `update-failures` is reserved for the update pipeline (M36) and has no detector
 * yet, so the record type and the panel can name it without any behaviour depending on it.
 */
export const INCIDENT_RULES = ['assignment-burst', 'agent-error-rate', 'outbox-failures', 'source-poll-failures', 'health-error',
  'stalled-assignment', 'update-failures'] as const
export type IncidentRule = typeof INCIDENT_RULES[number]

/**
 * The rules whose first record describes a live outage, so the daily budget must not silence them (ADR-0004). The other
 * gates still apply: the fingerprint deduplication and cooldown, the open-record cap and the minimum severity.
 */
export const INCIDENT_BUDGET_EXEMPT_RULES: readonly IncidentRule[] = ['health-error', 'stalled-assignment']

/** True when a new record for this rule is exempt from the daily budget because it describes a live outage. */
export function incidentBudgetExempt(rule: IncidentRule): boolean {
  return INCIDENT_BUDGET_EXEMPT_RULES.includes(rule)
}

/** The related records a detector can name; absent keys mean installation-wide scope. */
export interface IncidentScope { project?: string; ticket?: string; request?: string; session?: string }

/** One durable incident (schema 25). Times are ISO 8601 strings, as everywhere in the Store. */
export interface Incident {
  id: string
  fingerprint: string
  rule: IncidentRule
  scope: IncidentScope
  severity: IncidentSeverity
  status: IncidentStatus
  first_at: string
  last_at: string
  occurrences: number
  title: string
  detail: string
  evidence_dir: string
  diagnosis?: string
  resolution?: string
  updated_at: string
}

/** The confidence levels a diagnosis may carry; an answer the parser cannot read is always low (ADR-0005). */
export const DIAGNOSIS_CONFIDENCES = ['low', 'medium', 'high'] as const
export type DiagnosisConfidence = typeof DIAGNOSIS_CONFIDENCES[number]

/** Where a diagnosis says the fix belongs: a registered project, this repository, operations, or nowhere yet. */
export type DiagnosisTarget =
  | { kind: 'project'; project: string }
  | { kind: 'self' }
  | { kind: 'operational' }
  | { kind: 'none' }

/**
 * One validated diagnosis, stored as JSON text in the record's existing `diagnosis` column (ADR-0005 keeps schema 25).
 * `parsed: false` keeps the model's answer verbatim in `raw` at low confidence, so an unreadable answer still informs a
 * person without pretending to be structured.
 */
export interface IncidentDiagnosis {
  rootCause: string
  evidence: string[]
  hypotheses: string[]
  fixPlan: string
  confidence: DiagnosisConfidence
  target: DiagnosisTarget
  parsed: boolean
  raw?: string
}

/** Reads a diagnosis target from an unknown value; null when it is not one of the four shapes. */
export function diagnosisTargetOf(value: unknown): DiagnosisTarget | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  switch (record.kind) {
    case 'project': return typeof record.project === 'string' && record.project.trim() !== ''
      ? { kind: 'project', project: record.project.trim() } : null
    case 'self': return { kind: 'self' }
    case 'operational': return { kind: 'operational' }
    case 'none': return { kind: 'none' }
    default: return null
  }
}

function diagnosisStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value.map(item => item.trim()).filter(item => item !== '') : null
}

/**
 * Validates a diagnosis document (the parsed JSON of a model answer or the stored column). Null means the text is not a
 * diagnosis, so the panel shows nothing rather than a guess.
 */
export function parseIncidentDiagnosis(value: unknown): IncidentDiagnosis | null {
  let document = value
  if (typeof value === 'string') {
    try { document = JSON.parse(value) } catch { return null }
  }
  if (typeof document !== 'object' || document === null) return null
  const record = document as Record<string, unknown>
  const target = diagnosisTargetOf(record.target)
  const evidence = diagnosisStrings(record.evidence)
  const hypotheses = diagnosisStrings(record.hypotheses)
  if (typeof record.rootCause !== 'string' || typeof record.fixPlan !== 'string') return null
  if (target === null || evidence === null || hypotheses === null) return null
  const confidence = record.confidence
  if (typeof confidence !== 'string' || !DIAGNOSIS_CONFIDENCES.includes(confidence as DiagnosisConfidence)) return null
  return {
    rootCause: record.rootCause.trim(),
    evidence,
    hypotheses,
    fixPlan: record.fixPlan.trim(),
    confidence: confidence as DiagnosisConfidence,
    target,
    parsed: record.parsed !== false,
    ...(typeof record.raw === 'string' ? { raw: record.raw } : {}),
  }
}

/** What a detector hands the records service: ids and counts only, never a message body or a comment. */
export interface IncidentCandidate {
  rule: IncidentRule
  scope?: IncidentScope
  severity: IncidentSeverity
  title: string
  detail: string
}

/** Filters the panel and the Store list share; `open` means detected, bundled or diagnosed. */
export interface IncidentFilter {
  status?: IncidentStatus | 'open' | 'all'
  severity?: IncidentSeverity
  scope?: IncidentScope
  offset?: number
  limit?: number
}

/** The durable incident records of a schema 25 Store. */
export interface IncidentRepository {
  get(id: string): Incident | undefined
  byFingerprint(fingerprint: string): Incident | undefined
  save(incident: Incident): void
  list(filter?: IncidentFilter): Incident[]
  /** How many open incidents exist, optionally for one project. */
  openCount(project?: string): number
}

export const INCIDENT_TITLE_LIMIT = 200
export const INCIDENT_DETAIL_LIMIT = 800
/** How many open records one installation may hold; a burst of new conditions cannot crowd the panel. */
export const OPEN_INCIDENT_CAP = 100
/** At most this many new records a day; repeats of a known condition still count as occurrences. */
export const INCIDENT_DAILY_BUDGET_MAX = 24
/** A resolved or dismissed condition stays quiet this long before a repeat may reopen its record. */
export const INCIDENT_COOLDOWN_MS = 60 * 60_000
/** How many evidence bundles are kept; the oldest are removed first. */
export const INCIDENT_EVIDENCE_KEEP = 20
/** Evidence bundles older than this are removed even while fewer than `INCIDENT_EVIDENCE_KEEP` exist. */
export const INCIDENT_EVIDENCE_DAYS = 30
/** The log window an evidence bundle covers, ending at the detection. */
export const INCIDENT_LOG_WINDOW_MS = 30 * 60_000
export const INCIDENT_LOG_LIMIT = 500
/** Rows the panel lists per page. */
export const INCIDENT_PAGE_DEFAULT = 20
export const INCIDENT_PAGE_MAX = 100

/** True when an incident still needs a person or the diagnoser; resolved and dismissed records are closed. */
export function isOpenIncident(status: IncidentStatus): boolean {
  return status === 'detected' || status === 'bundled' || status === 'diagnosed'
}

/** 0 for low through 3 for critical, for comparing a candidate with the configured minimum. */
export function incidentSeverityRank(severity: IncidentSeverity): number {
  return INCIDENT_SEVERITY_RANK[severity]
}

/** The severity a repeat keeps: the higher of the record and the new detection. */
export function higherSeverity(a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity {
  return incidentSeverityRank(a) >= incidentSeverityRank(b) ? a : b
}

/**
 * A detail the fingerprint can compare across repetitions: digits become `#` because occurrence counts, durations
 * and ids that a rule deliberately varies must not split one condition into many records. Text is collapsed and
 * lower-cased so two spacings of the same sentence agree.
 */
export function normalizeIncidentDetail(detail: string): string {
  return detail.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The scope's non-empty ids in a fixed order, so insertion order never changes a fingerprint. */
export function incidentScopeEntries(scope: IncidentScope = {}): [keyof IncidentScope, string][] {
  return (['project', 'ticket', 'request', 'session'] as const).flatMap(name => {
    const value = scope[name]
    return typeof value === 'string' && value !== '' ? [[name, value] as [keyof IncidentScope, string]] : []
  })
}

/**
 * The stable identity of one condition: rule, sorted scope ids, and the normalized detail hashed together. Two
 * detections with the same identity increment the same record's occurrences instead of creating a second record.
 */
export function incidentFingerprint(incident: { rule: IncidentRule; scope?: IncidentScope; detail: string }): string {
  const canonical = JSON.stringify({ rule: incident.rule, scope: incidentScopeEntries(incident.scope),
    detail: normalizeIncidentDetail(incident.detail) })
  return createHash('sha256').update(canonical).digest('hex')
}

/** True when a record's scope names every id the filter asks for. */
export function incidentMatchesScope(incident: Incident, scope: IncidentScope = {}): boolean {
  return incidentScopeEntries(scope).every(([name, value]) => incident.scope[name] === value)
}

/**
 * Validates a detector's candidate and returns it trimmed. Detectors build candidates from operational facts, so a
 * malformed one is a programming error; it is refused rather than written as a half-read record.
 */
export function checkIncidentCandidate(candidate: IncidentCandidate): IncidentCandidate {
  if (!INCIDENT_RULES.includes(candidate.rule)) throw new UserError('incidentInvalid', { reason: 'rule' })
  if (!INCIDENT_SEVERITIES.includes(candidate.severity)) throw new UserError('incidentInvalid', { reason: 'severity' })
  const title = candidate.title.trim()
  const detail = candidate.detail.trim()
  if (title === '') throw new UserError('incidentInvalid', { reason: 'title' })
  if (title.length > INCIDENT_TITLE_LIMIT) throw new UserError('incidentInvalid', { reason: 'title' })
  if (detail === '') throw new UserError('incidentInvalid', { reason: 'detail' })
  if (detail.length > INCIDENT_DETAIL_LIMIT) throw new UserError('incidentInvalid', { reason: 'detail' })
  const scope: IncidentScope = {}
  for (const name of ['project', 'ticket', 'request', 'session'] as const) {
    const value = candidate.scope?.[name]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim() === '') throw new UserError('incidentInvalid', { reason: 'scope' })
    scope[name] = value.trim()
  }
  return { ...candidate, title, detail, ...Object.keys(scope).length ? { scope } : {} }
}

/** The status changes the record model allows; a reopen only ever returns a closed record to `detected`. */
const TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  detected: ['bundled', 'diagnosed', 'resolved', 'dismissed'],
  bundled: ['diagnosed', 'resolved', 'dismissed'],
  diagnosed: ['resolved', 'dismissed'],
  resolved: ['detected'],
  dismissed: ['detected'],
}

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * A copy of the record in a new status, with optional diagnosis/resolution text; an invalid change throws
 * `incidentTransition`. `updated_at` is the change time, while `first_at` and `last_at` keep their detection meaning.
 */
export function transitionIncident(incident: Incident, status: IncidentStatus, at: string,
  patch: { diagnosis?: string; resolution?: string } = {}): Incident {
  if (!canTransition(incident.status, status)) throw new UserError('incidentTransition', { from: incident.status, to: status })
  return { ...incident, ...patch, status, updated_at: at }
}
