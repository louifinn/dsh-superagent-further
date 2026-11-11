/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, projectRequestOpen, threadKey, PROJECT_REQUEST_INSTRUCTION_LIMIT, PROJECT_REQUEST_TITLE_LIMIT,
  type EngineForExecutor, type ProjectRequest, type ProjectRequestRoot, type Ticket } from '../../core/index.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import { projectOf, type Project } from '../../projects.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { CaptureLogs } from '../logs.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext' | 'raiseProjectRequest'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic' | 'triggers' | 'projectRequests'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify' | 'lead'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** The projects this installation works on, so a Ticket's own repository can be read for its PR. */
  readonly projects: () => readonly Project[]
  sendReplies(): Promise<void>
  /** Operational log scoped to the executor; a report's summary and any question are never logged. */
  readonly log?: CaptureLogs
}

/** A PR number the report links in its own summary, when the link is in the Ticket's repository. */
const linkedPull = (summary: string, repository: string): number | undefined => {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`github\\.com/${escaped}/pull/(\\d+)`).exec(summary)
  return match ? Number(match[1]) : undefined
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'request_create',
      description: 'Raise a project request when this ticket cannot finish without a decision, a new deliverable, or work in another project of this project. '
        + 'The project Lead answers it; one open request per title exists for this ticket, so raising a duplicate returns it.',
      schema: z.object({
        title: z.string().trim().min(1).max(PROJECT_REQUEST_TITLE_LIMIT).describe('One line naming what the Lead must decide.'),
        instruction: z.string().trim().min(1).max(PROJECT_REQUEST_INSTRUCTION_LIMIT).describe('What is needed, in enough detail for the Lead to decide and for a worker to act on it.'),
        kind: z.enum(['work', 'architecture']).optional().describe('work for deliverable project work, architecture for a change of approach or its approval.'),
        parent: z.string().trim().min(1).optional().describe('An open project request of this project this one refines, so the Lead sees it on that request and its reply.'),
        evidence: z.string().trim().min(1).max(4_000).optional().describe('The facts that justify it, such as an error, a link, or what was tried.'),
      }).strict(),
      execute: async (args: { title: string; instruction: string; kind?: 'work' | 'architecture'; parent?: string; evidence?: string }) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        if (!current.project) throw new Error('This ticket belongs to no registered project, so it has no project Lead to raise a request with')
        const parent = args.parent === undefined ? undefined : host.store.projectRequests.get(args.parent)
        if (args.parent !== undefined && !parent) throw new Error(`Unknown parent project request ${args.parent}`)
        if (parent && parent.project !== current.project) throw new Error(`Project request ${parent.id} belongs to project ${parent.project}, not ${current.project}`)
        const trigger = host.store.triggers.get(current.origin.triggerId)
        const thread = trigger?.threads[0]
        let root: ProjectRequestRoot | undefined
        if (parent) {
          // A derived request reports through its parent's root, or through this ticket's own origin when the parent is a root.
          const triggerId = parent.root?.trigger_id ?? current.origin.triggerId
          const key = parent.root?.thread_key ?? (thread ? threadKey(thread) : undefined)
          if (key === undefined) throw new Error('The parent project request has no source thread to report on')
          const requestId = parent.root?.request_id ?? current.requestId
          root = { project_request_id: parent.id, trigger_id: triggerId, thread_key: key, ...(requestId === undefined ? {} : { request_id: requestId }) }
        } else if (thread) {
          root = { trigger_id: current.origin.triggerId, thread_key: threadKey(thread), ...(current.requestId === undefined ? {} : { request_id: current.requestId }) }
        }
        const assignment = current.assignments.at(-1)?.id
        const request = host.store.atomic(() => host.engine.raiseProjectRequest({
          project: current.project!, title: args.title,
          instruction: args.evidence === undefined ? args.instruction : `${args.instruction}\n\nEvidence: ${args.evidence}`,
          kind: args.kind ?? 'work',
          raised_by: { session: workerSessionId(ticketId), ticket: ticketId, ...(assignment === undefined ? {} : { assignment }) },
          ...(root === undefined ? {} : { root }),
        }))
        // The Lead is prompted for the request even when this tool was called before it existed; a Lead that cannot be
        // reached is logged and the request still waits for it.
        await host.sessions.lead.requestRaised(request)
        return { id: request.id, status: request.status }
      },
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress. An answer ticket\'s ready report already answers the question that started it.'),
        requests: z.array(z.string().trim().min(1)).max(50).optional().describe('The project requests this ticket raised that this report answers or leaves behind; '
          + 'a ready, blocked, failed or dropped report must name every open one it still leaves unanswered, or the report is refused.'),
        checks: z.array(z.object({
          name: z.string().trim().min(1).max(200).describe('What was verified, such as "pnpm check" or "reproduced the crash".'),
          command: z.string().trim().min(1).max(500).optional().describe('The command that produced the evidence.'),
          exit_code: z.number().int().min(-1000).max(1000).optional().describe('The command\'s exit code.'),
          evidence: z.string().trim().min(1).max(1000).optional().describe('A short line of evidence, such as the key output or the test count.'),
        }).strict()).max(20).optional().describe('The verifications this report rests on; list only checks you actually ran.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const project = current.project
        // Every named request must be this ticket's own, so a typo cannot silently leave a request unanswered.
        const requests = args.requests ?? []
        for (const id of requests) {
          const request = host.store.projectRequests.get(id)
          if (!request || request.raised_by.ticket !== ticketId) throw new Error(`Project request ${id} was not raised by this ticket`)
        }
        // The PR lives in the Ticket's project repository, not in the deployment's own; reading it from the wrong repository refuses a valid claim.
        const repository = projectOf(host.projects(), project)?.repository
        // A worker may link its PR in the summary instead of passing pr_number; bind it anyway so the merge can end the Ticket.
        const linked = args.pr_number ?? linkedPull(args.summary, repository ?? host.github.deployment.repository)
        const pull = linked != null ? await readPull(host.github, linked, signal, repository) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        const outcome = host.store.atomic(() => {
          // A finished report must name every open request this ticket still leaves unanswered; the Lead is prompted for
          // the ones it named, and the report is refused rather than losing one silently.
          if (args.state !== 'progress' && project) {
            const open = host.store.projectRequests.list(project)
              .filter(request => request.raised_by.ticket === ticketId && projectRequestOpen(request.status) && request.replies.length === 0)
            const missing = open.filter(request => !requests.includes(request.id))
            if (missing.length > 0) {
              throw new Error(`Name the unanswered project requests this report leaves behind in requests: ${missing.map(request => request.id).join(', ')}`)
            }
          }
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
            ...(args.checks === undefined ? {} : { checks: args.checks.map(check => ({
              name: check.name,
              ...(check.command ? { command: check.command } : {}),
              ...(check.exit_code !== undefined ? { exitCode: check.exit_code } : {}),
              ...(check.evidence ? { evidence: check.evidence } : {}),
            })) }) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { result: { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }, updated }
        })
        host.log?.info('report.recorded ticket=%s state=%s outcome=%s', ticketId, args.state, outcome.updated.ended?.outcome ?? 'none')
        // Prompting the Lead is best-effort and outside the transaction: the report is already durable, and a Lead that
        // cannot be woken leaves the request waiting for the next reconciliation or Lead turn.
        await host.sessions.lead.reported(outcome.updated, { state: args.state, summary: args.summary }, requests)
        return { ...outcome.result, ...(requests.length === 0 ? {} : { requests }) }
      },
    }),
  ]
}
