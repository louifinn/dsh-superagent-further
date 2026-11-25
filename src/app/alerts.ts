/**
 * Incident alerts (issue #19): a person hears about an incident outside the panel. The service turns the
 * incident record's opened/reopened/resolved changes into one Feishu message per incident and change, filtered by
 * the configured minimum severity, deduplicated by key and capped per UTC day. A failed send is only logged (and is
 * retried by the next change); the daily digest keeps repeating open incidents as a low-frequency backstop.
 */
import type { Commands } from '../infra/commands.ts'
import type { Key } from '../kv.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import { key } from '../core/ids.ts'
import { incidentSeverityRank, INCIDENT_TITLE_LIMIT, type Incident } from '../core/incidents.ts'
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

/** Turns an incident change into the operator's alert chat, once, within its daily cap. */
export class Alerts {
  private readonly host: AlertsHost

  constructor(host: AlertsHost) { this.host = host }

  /** Sends the alert when the configuration and the caps allow it, and reports whether it was sent. */
  async notify(incident: Incident, change: AlertChange): Promise<boolean> {
    const config = this.host.settings().executor.incidents
    const chat = config.alertChatId.trim()
    if (chat === '') return false
    if (change === 'resolved' && !config.alertRecovery) return false
    if (incidentSeverityRank(incident.severity) < incidentSeverityRank(config.alertMinimumSeverity)) return false
    const replay = this.host.state.get(KV.incidents.alert(incident.id, change))
    if (replay === true) return false
    const day = new Date().toISOString().slice(0, 10)
    const sent = this.host.state.get(KV.incidents.alertDay(day)) ?? 0
    if (sent >= config.alertDailyLimit) return false
    const subject = change === 'resolved' ? 'Incident resolved' : `Incident ${change}`
    const text = [
      `[dsh-superagent] ${subject}: ${incident.severity} ${incident.rule} — ${incident.status === 'resolved' ? '' : ''}${incident.title.slice(0, INCIDENT_TITLE_LIMIT)}`,
      incident.detail,
      'The incident record and its evidence bundle are in the panel; this message is a notification, not a fix.',
    ].join('\n\n')
    try {
      await this.host.commands.lark(['im', '+messages-send', '--chat-id', chat, '--markdown', '-', '--idempotency-key',
        key('incident-alert', incident.id, change)], undefined, text)
      this.host.state.set(KV.incidents.alert(incident.id, change), true)
      this.host.state.set(KV.incidents.alertDay(day), sent + 1)
      return true
    } catch (error) {
      this.host.logs.record('warn', 'alerts', `Alert for incident ${incident.id} (${change}) could not be sent: ${
        error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
}
