/**
 * Deterministic incident detectors (ADR-0004). Every rule is a pure, bounded reduction over facts the host
 * already records: DomainEvents, operational log entries and health transitions. A detector returns signals — a new
 * candidate or the fingerprint of a condition that cleared — and makes no model call and no decision about writing.
 * The `update-failures` rule is reserved for the update pipeline (M36) and has no detector here.
 */
import { incidentFingerprint, type IncidentCandidate, type IncidentScope } from '../core/incidents.ts'
import type { DomainEvent } from '../core/index.ts'

/** One rule's conclusion: detect a condition, or report that a known condition cleared. */
export type IncidentSignal =
  | { type: 'detect'; candidate: IncidentCandidate }
  | { type: 'recover'; fingerprint: string }

/** The log facts detection reads; a full `LogEntry` satisfies it. */
export interface ObservedLog { at: string; level: string; scope: string; message: string }
/** What a health claim transition looks like from the outside. */
export interface ObservedHealth { state: string; detail: string }

/** Windows the rules use; short enough that a burst is current, long enough not to need a second event. */
export const ASSIGNMENT_BURST_WINDOW_MS = 10 * 60_000
export const ASSIGNMENT_BURST_COUNT = 4
export const AGENT_ERROR_WINDOW_MS = 10 * 60_000
export const AGENT_ERROR_COUNT = 3
export const OUTBOX_FAILURE_WINDOW_MS = 30 * 60_000
export const OUTBOX_FAILURE_COUNT = 3
export const SOURCE_POLL_WINDOW_MS = 10 * 60_000
export const SOURCE_POLL_COUNT = 3

/** The `assignment.ended` reasons that mean work failed rather than finished. */
const FAILED_END_REASONS = new Set(['failed', 'stopped', 'interrupted', 'hostRestarted'])
const STALLED_MS = 10 * 60_000

/** The detector's collaborators: a way to find the project that owns a ticket, which scopes a burst. */
export interface DetectorHost { tickets?(ticketId: string): { project?: string } | undefined }

function time(value: string | undefined): number { return value === undefined ? NaN : Date.parse(value) }
function detailNumber(value: number): string { return String(value) }

/**
 * The deterministic rules. Each keeps only the events inside its own window, resets after a detection so one burst is
 * one signal, and reports a cleared condition for rules the host can observe clearing (source polls and health claims).
 */
export class IncidentDetector {
  /** Assignment-end times per project (or per ticket when the project is unknown). */
  private readonly ends = new Map<string, number[]>()
  /** Uncategorized agent errors inside the rate window. */
  private readonly agentErrors: number[] = []
  /** Reply-delivery failure times inside the outbox window. */
  private readonly outbox: number[] = []
  /** Consecutive poll failures per source, with the candidate that was raised for them. */
  private readonly polls = new Map<string, { at: number[]; candidate?: IncidentCandidate }>()
  /** Fingerprints of open health-error detections, so the recovery can name them. */
  private readonly health = new Map<string, string>()

  constructor(private readonly host: DetectorHost = {}) {}

  /** Feeds one Engine event; only `assignment.ended` participates today. */
  observeEvent(event: DomainEvent, at: Date = new Date(event.at)): IncidentSignal[] {
    if (event.type !== 'assignment.ended') return []
    if (!FAILED_END_REASONS.has(event.data.reason)) return []
    const ticketId = event.data.ticketId
    const project = this.host.tickets?.(ticketId)?.project
    const scope: IncidentScope = project === undefined || project === '' ? { ticket: ticketId } : { project }
    const group = project === undefined || project === '' ? `ticket:${ticketId}` : `project:${project}`
    const now = time(event.at)
    if (!Number.isFinite(now)) return []
    const kept = (this.ends.get(group) ?? []).filter(item => now - item <= ASSIGNMENT_BURST_WINDOW_MS)
    kept.push(now)
    if (kept.length < ASSIGNMENT_BURST_COUNT) { this.ends.set(group, kept); return [] }
    this.ends.delete(group)
    return [this.detect({ rule: 'assignment-burst', scope, severity: 'high',
      title: project === undefined ? 'Repeated Assignment failures' : `Repeated Assignment failures in ${project}`,
      detail: `${detailNumber(ASSIGNMENT_BURST_COUNT)} Assignments failed or stopped within ${ASSIGNMENT_BURST_WINDOW_MS / 60_000} minutes` })]
  }

  /** Feeds one operational log entry; the rules that read logs are agent errors, reply deliveries and source polls. */
  observeLog(entry: ObservedLog, at: Date = new Date(entry.at)): IncidentSignal[] {
    const now = time(entry.at)
    if (!Number.isFinite(now)) return []
    if (entry.message.includes('agent.error') || (entry.scope === 'executor' && entry.message.startsWith('agent.error'))) {
      this.agentErrors.push(now)
      const since = now - AGENT_ERROR_WINDOW_MS
      while (this.agentErrors.length > 0 && this.agentErrors[0]! < since) this.agentErrors.shift()
      if (this.agentErrors.length < AGENT_ERROR_COUNT) return []
      this.agentErrors.length = 0
      return [this.detect({ rule: 'agent-error-rate', severity: 'high', title: 'Agent errors are above the threshold',
        detail: `${detailNumber(AGENT_ERROR_COUNT)} agent errors within ${AGENT_ERROR_WINDOW_MS / 60_000} minutes` })]
    }
    if (entry.scope === 'outbox' && entry.message.startsWith('reply delivery failed')) {
      this.outbox.push(now)
      const since = now - OUTBOX_FAILURE_WINDOW_MS
      while (this.outbox.length > 0 && this.outbox[0]! < since) this.outbox.shift()
      if (this.outbox.length < OUTBOX_FAILURE_COUNT) return []
      this.outbox.length = 0
      return [this.detect({ rule: 'outbox-failures', severity: 'high', title: 'Reply deliveries are failing',
        detail: `${detailNumber(OUTBOX_FAILURE_COUNT)} reply delivery failures within ${OUTBOX_FAILURE_WINDOW_MS / 60_000} minutes` })]
    }
    if (entry.message.startsWith('poll.failed')) {
      const source = /(?:^|\s)source=([^\s]+)/.exec(entry.message)?.[1] ?? 'unknown'
      const current = this.polls.get(source) ?? { at: [] }
      const since = now - SOURCE_POLL_WINDOW_MS
      current.at = current.at.filter(item => item >= since)
      current.at.push(now)
      if (current.at.length < SOURCE_POLL_COUNT) { this.polls.set(source, current); return [] }
      const candidate: IncidentCandidate = { rule: 'source-poll-failures', severity: 'high',
        title: `Source ${source} cannot poll`, detail: `${detailNumber(SOURCE_POLL_COUNT)} consecutive poll failures for ${source} within ${SOURCE_POLL_WINDOW_MS / 60_000} minutes` }
      this.polls.set(source, { at: [], candidate })
      return [this.detect(candidate)]
    }
    if (entry.message.startsWith('poll.recovered')) {
      const source = /(?:^|\s)source=([^\s]+)/.exec(entry.message)?.[1] ?? 'unknown'
      const current = this.polls.get(source)
      if (current === undefined) return []
      this.polls.delete(source)
      return current.candidate === undefined ? [] : [{ type: 'recover', fingerprint: incidentFingerprint(current.candidate) }]
    }
    return []
  }

  /** Feeds one health transition; entering error detects at once, leaving it recovers the same fingerprint. */
  observeHealth(name: string, previous: ObservedHealth | undefined, next: ObservedHealth): IncidentSignal[] {
    if (next.state === 'error' && previous?.state !== 'error') {
      const candidate: IncidentCandidate = { rule: 'health-error', severity: 'high', title: `Health claim ${name} is in error`,
        detail: `${name} reported the error state` }
      this.health.set(name, incidentFingerprint(candidate))
      return [this.detect(candidate)]
    }
    if (next.state !== 'error' && previous?.state === 'error') {
      const fingerprint = this.health.get(name)
      this.health.delete(name)
      return fingerprint === undefined ? [] : [{ type: 'recover', fingerprint }]
    }
    return []
  }

  /**
   * The M21 watchdog raised (or repeated) a stalled-Assignment request; the same ticket and Assignment always produce
   * one fingerprint, so the records service counts a repeat instead of creating another record or request.
   */
  stalled(input: { ticketId: string; project?: string; assignmentId: string }): IncidentSignal[] {
    const scope: IncidentScope = { ticket: input.ticketId, ...(input.project === undefined || input.project === '' ? {} : { project: input.project }) }
    return [this.detect({ rule: 'stalled-assignment', scope, severity: 'high',
      title: 'A worker Assignment is stalled',
      detail: `Assignment ${input.assignmentId} has been idle for ${STALLED_MS / 60_000} minutes` })]
  }

  private detect(candidate: IncidentCandidate): IncidentSignal { return { type: 'detect', candidate } }
}
