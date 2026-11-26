/**
 * Operator alerts (issues #19, #26 and #30): a person hears about something the panel alone would not tell them. The
 * service sends one Feishu message to the configured alert chat for an incident change, a model failure or an
 * escalation without a user Channel, deduplicated by the caller's key and capped per UTC day. A failed send is only
 * logged (the next change tries again); the daily digest repeats open incidents as a low-frequency backstop.
 */
import type { Commands } from '../infra/commands.ts'
import type { Key } from '../kv.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import { key } from '../core/ids.ts'
import { incidentSeverityRank, INCIDENT_TITLE_LIMIT, type Incident, type IncidentNotification } from '../core/incidents.ts'
import type { Logs } from './logs.ts'

/** Which incident change an alert describes; dismissals never alert. */
export type AlertChange = 'opened' | 'reopened' | 'resolved'

/** The service's collaborators; the Runtime provides the real clock, settings and Feishu commands. */
export interface AlertsHost {
  settings(): Settings
  state: { get<V>(value: Key<V>): V | undefined; set<V>(value: Key<V>, next: V | undefined): void }
  commands: Pick<Commands, 'lark'>
  logs: Pick<Logs, 'record'>
}

/** Turns an incident change or another operator fact into the alert chat, once, within the daily cap. */
export class Alerts {
  private readonly host: AlertsHost

  constructor(host: AlertsHost) { this.host = host }

  /** Sends one operator message for `dedupeKey` unless it was already sent or the chat is not configured. */
  async send(dedupeKey: string, text: string): Promise<boolean> {
    const config = this.host.settings().executor.incidents
    const chat = config.alertChatId.trim()
    if (chat === '') return false
    if (this.host.state.get(KV.alerts.sent(dedupeKey)) === true) return false
    const day = new Date().toISOString().slice(0, 10)
    const sent = this.host.state.get(KV.alerts.day(day)) ?? 0
    if (sent >= config.alertDailyLimit) return false
    try {
      await this.host.commands.lark(['im', '+messages-send', '--chat-id', chat, '--markdown', '-', '--idempotency-key',
        key('operator-alert', dedupeKey)], undefined, text)
      this.host.state.set(KV.alerts.sent(dedupeKey), true)
      this.host.state.set(KV.alerts.day(day), sent + 1)
      return true
    } catch (error) {
      this.host.logs.record('warn', 'alerts', `Alert ${dedupeKey} could not be sent: ${
        error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** Sends the alert for an incident change when the configuration and the caps allow it, and reports whether it was sent. */
  async notify(incident: Incident, change: AlertChange): Promise<boolean> {
    const config = this.host.settings().executor.incidents
    if (change === 'resolved' && !config.alertRecovery) return false
    if (incidentSeverityRank(incident.severity) < incidentSeverityRank(config.alertMinimumSeverity)) return false
    const subject = change === 'resolved' ? 'Incident resolved' : `Incident ${change}`
    const text = [
      `[dsh-superagent] ${subject}: ${incident.severity} ${incident.rule} — ${incident.title.slice(0, INCIDENT_TITLE_LIMIT)}`,
      incident.detail,
      'The incident record and its evidence bundle are in the panel; this message is a notification, not a fix.',
    ].join('\n\n')
    return this.send(`incident:${incident.id}:${change}`, text)
  }

  /**
   * Sends the alert for a detection the incident daily budget held back (issue #28, ADR-0010). The queue only holds
   * notices at or above the operator's alert threshold, so this path skips the severity test and keeps the alert chat's
   * daily allowance; a refusal keeps the notice queued for the next watchdog pass.
   */
  async notifyQueued(entry: IncidentNotification): Promise<boolean> {
    const text = [
      `[dsh-superagent] Incident held by the daily record budget: ${entry.severity} ${entry.rule} — ${entry.title.slice(0, INCIDENT_TITLE_LIMIT)}`,
      entry.detail,
      'The daily incident allowance was already spent, so this detection has no record yet; the panel shows it if the condition repeats.',
    ].join('\n\n')
    return this.send(`incident-queued:${entry.fingerprint}`, text)
  }
}
