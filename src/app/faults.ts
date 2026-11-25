/**
 * The person's path for failures that would otherwise stay inside the panel (issues #26 and #30):
 * - a model budget failure on one or more managed Sessions becomes one alert listing every affected level,
 *   deduplicated until the whole set recovers, with a recovery alert when recovery alerts are on;
 * - an escalation or a project request with no root Channel has no user Channel, so its decision and its aggregate
 *   result go to the alert chat instead, and the gap is recorded in the log either way.
 */
import type { Key } from '../kv.ts'
import { KV } from '../kv.ts'
import type { ProjectRequest } from '../core/model.ts'
import { key } from '../core/ids.ts'
import type { BudgetRetryStatus } from './retry-health.ts'
import type { Logs } from './logs.ts'
import type { Alerts } from './alerts.ts'

/** The level a managed Session works at, from its id prefix. */
export const modelFaultRole = (sessionId: string): string =>
  sessionId.startsWith('worker-') ? 'Executor' : sessionId.startsWith('lead-') ? 'Lead' : 'Orchestrator'

/** One concrete, actionable message for the model failures across levels; never includes credentials. */
export const modelFaultText = (retries: readonly BudgetRetryStatus[]): string => {
  const lines = retries.map(item => `· ${modelFaultRole(item.sessionId)} session ${item.sessionId}: provider ${item.provider}, ` +
    `attempt ${item.attempts}, waiting since ${item.since} (last ${item.lastAt})`)
  return [
    `[dsh-superagent] Model requests are failing on ${retries.length === 1 ? 'one managed Session' : `${retries.length} managed Sessions`}:`,
    ...lines,
    'The host retried and kept the model and retry policy unchanged; no work was silently dropped. ' +
      'Check the provider quota, credentials and reachability, or switch the model in Settings → Eval/Execution. ' +
      'A recovery message follows when the retries stop; this failure is recorded with the other host health.',
  ].join('\n')
}

/** The collaborators; the Runtime supplies the alert chat, KV and the incident settings. */
export interface FaultsHost {
  alerts: Pick<Alerts, 'send'>
  state: { get<V>(value: Key<V>): V | undefined; set<V>(value: Key<V>, next: V | undefined): void }
  logs: Pick<Logs, 'record'>
  /** Whether the operator asked for recovery messages (the incident recovery switch). */
  recovery(): boolean
}

/** Routes the failures that have no other user Channel; every path is idempotent. */
export class Faults {
  private readonly host: FaultsHost

  constructor(host: FaultsHost) { this.host = host }

  /** Notifies once for the current model-failure set, and sends one recovery alert when it clears (issue #26). */
  async modelRetries(retries: readonly BudgetRetryStatus[]): Promise<void> {
    const notified = this.host.state.get(KV.faults.models)
    if (retries.length === 0) {
      this.host.state.set(KV.faults.models, undefined)
      if (notified !== undefined && this.host.recovery()) {
        await this.host.alerts.send(key('model-fault-recovered', notified),
          '[dsh-superagent] Recovery: model requests succeed again; the retries on the managed Sessions stopped and work continues.')
      }
      return
    }
    const fingerprint = key('model-fault', retries.map(item => `${item.sessionId}:${item.provider}`).join(','))
    if (notified === fingerprint) return
    const sent = await this.host.alerts.send(fingerprint, modelFaultText(retries))
    this.host.logs.record('warn', 'faults', `Model failure on ${retries.length} Session(s); ` +
      `${sent ? 'the person was alerted' : 'no alert chat could be reached'}`)
    if (sent) this.host.state.set(KV.faults.models, fingerprint)
  }

  /** Reports a rootless escalation's decision on the alert chat; with a root Channel the Lead's own path reports it (issue #30). */
  async escalationDecided(request: ProjectRequest, disposition: string): Promise<void> {
    if (request.root) return
    const sent = await this.host.alerts.send(key('escalation-no-channel', request.id, disposition),
      `[dsh-superagent] Project ${request.project} escalated “${request.title}” and the Orchestrator decided ${disposition}. ` +
        'The escalation names no root Channel, so this chat is the only place the decision reaches a person.')
    this.host.logs.record('warn', 'faults', `Escalation ${request.id} has no user Channel; decision ${disposition} ` +
      `${sent ? 'reported on the alert chat' : 'could not be reported (no alert chat configured or send failed)'}`)
  }

  /** Reports a completed project request that has no root Channel anywhere to aggregate into (issue #30). */
  async projectCompletedNoRoot(request: ProjectRequest, tickets: readonly string[]): Promise<void> {
    if (request.root) return
    const sent = await this.host.alerts.send(key('project-no-channel', request.id),
      `[dsh-superagent] Project request “${request.title}” in ${request.project} completed with ${tickets.length} ` +
        `Ticket${tickets.length === 1 ? '' : 's'} (${tickets.join(', ')}). It names no root Channel, so this chat is the only ` +
        'place the result reaches a person.')
    this.host.logs.record('warn', 'faults', `Project request ${request.id} has no root Channel; completion ` +
      `${sent ? 'reported on the alert chat' : 'could not be reported (no alert chat configured or send failed)'}`)
  }
}
