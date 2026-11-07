/** Lead application tools: what a project Lead can read about the project it serves. */
import { z } from 'zod'
import { ticketStage, type Ticket } from '../../core/index.ts'
import type { Project } from '../../projects.ts'
import type { Store } from '../store.ts'
import { tool, type Tool } from './tool.ts'

/** What one Ticket looks like to its project's Lead: the stage a person sees and the executor's latest state. */
function row(ticket: Ticket) {
  return { ticket_id: ticket.id, title: ticket.title, stage: ticketStage(ticket).stage,
    executor: ticket.assignments.at(-1)?.state ?? 'none', ...ticket.ended === undefined ? {} : { ended: ticket.ended.outcome } }
}

/**
 * The tools a project's Lead Session gets. `lead_status` is read-only: a Lead learns the Tickets of its project and the
 * messages waiting for it, which is what it needs to answer a person without guessing from the conversation alone.
 */
export function leadTools(store: Pick<Store, 'tickets' | 'leads'>, project: Project): Tool[] {
  return [tool({
    name: 'lead_status',
    description: 'Read the project this Lead serves: its local clone, repository and base branch, the open and recently ended '
      + 'Tickets of the project, and the messages waiting for the Lead.',
    schema: z.object({}).strict(),
    execute: async () => {
      const open = store.tickets.open().filter(ticket => ticket.project === project.id)
      const ended = store.tickets.list().filter(ticket => ticket.project === project.id && ticket.ended !== undefined).slice(-10)
      return {
        project: { id: project.id, name: project.name, workspace: project.workspace, repository: project.repository,
          branch: project.branch === '' ? 'the repository default branch' : project.branch },
        tickets: { open: open.map(row), ended: ended.map(row) },
        messages: store.leads.waiting('lead', project.id)
          .map(message => ({ kind: message.kind, request: message.requestId, ...message.ticketId === undefined ? {} : { ticket_id: message.ticketId }, body: message.body })),
      }
    },
  })]
}
