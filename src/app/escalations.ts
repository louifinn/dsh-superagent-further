import type { Deliverable, ProjectRequest } from '../core/model.ts'
import type { DeliveryUnit } from '../core/ports.ts'
import type { Engine } from '../core/engine.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

/** A decision on one escalated project request, from the main Session's tool or the panel; docs/012 D13. */
export interface EscalationDecisionInput {
  id: string
  decision: 'accept' | 'reject' | 'needs-info'
  reply: string
  units?: DeliveryUnit[]
  deliverable?: Deliverable
}

/** What a decision produced: the recorded request, and whether its mandatory reply reached the Lead. */
export interface EscalationDecisionResult {
  id: string
  project: string
  status: ProjectRequest['status']
  replies: ProjectRequest['replies']
  request_id?: string
  tickets: string[]
  reply_delivered: boolean
}

/**
 * Decides one escalated project request and delivers the required reply to the Lead that raised it.
 * The main Session's `orchestrator_escalation_decide` tool and the panel both go through this one path, so a
 * decision made on either surface reads and reaches the Lead the same way.
 */
export async function decideEscalation(engine: Pick<Engine, 'decideEscalation'>, store: Pick<Store, 'settings' | 'leads'>,
  sessions: Pick<Sessions, 'ensureLead' | 'prompt'>, input: EscalationDecisionInput): Promise<EscalationDecisionResult> {
  const request = engine.decideEscalation(input.id, { by: 'orchestrator', action: input.decision, text: input.reply },
    { units: input.units ?? [], ...input.deliverable === undefined ? {} : { deliverable: input.deliverable } })
  let delivered = false
  try {
    const project = store.settings().executor.projects.find(item => item.id === request.project)
    if (project) {
      const body = `Your escalated project request ${request.id} was ${input.decision}: ${input.reply}`
      const message = store.leads.send({ project: project.id, kind: 'notice', from: 'orchestrator', to: 'lead',
        requestId: `escalation-result:${request.id}`, body })
      const session = await sessions.ensureLead(project.id, project.workspace, `Lead · ${project.name}`)
      await sessions.prompt(session.id, message.requestId, message.body, 'queue')
      store.leads.deliver(message.id)
      delivered = true
    }
  } catch { delivered = false }
  return { id: request.id, project: request.project, status: request.status, replies: request.replies,
    ...request.request_id === undefined ? {} : { request_id: request.request_id }, tickets: request.tickets, reply_delivered: delivered }
}
