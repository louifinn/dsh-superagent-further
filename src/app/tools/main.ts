/** Main Session tools for routing triggers, assessing candidates, sending replies, and updating settings and prompts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { UserError, followupOwners, key, reasonText, type Decision, type DecisionKind, type EngineForMainSession, type EngineForPeople }
  from '../../core/index.ts'
import { IM_WORDS, NOTE_WORDS, wordCount } from '../../infra/text.ts'
import { AssessmentSchema, EvalReadSchema, WorktreeNameSchema, type MasterAssessor } from '../assessment.ts'
import type { Automations } from '../automations.ts'
import { ticketCard } from '../cards.ts'
import { projectByRepository, projectOf } from '../../projects.ts'
import { PromptConfigSchema, savePrompts, type Prompts } from '../prompts.ts'
import { readResource, type MainResourceHost, type ResourceHost } from '../resources.ts'
import type { Sessions } from '../sessions.ts'
import type { Settings } from '../settings.ts'
import type { Store } from '../store.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'
import { automationTools } from './automation.ts'
import type { SourceLabelChange, SourceLabelResult } from '../../sources/kind.ts'

const RoutingNoteSchema = z.string().trim()
  .refine(text => wordCount(text) <= NOTE_WORDS, `Routing note must not exceed ${NOTE_WORDS} words (Chinese uses word segmentation). Shorten it; do not split it across deliveries.`)
  .describe(`Optional routing background or explicit human constraint, at most ${NOTE_WORDS} words. Never add implementation instructions or replace the original source.`)
export interface MainToolsHost {
  readonly context: Context
  readonly engine: Pick<EngineForMainSession, 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note' | 'raiseInstallationRequest'> & EngineForPeople
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'atomic' | 'replyStatus' | 'settings'>
  readonly prompts: Pick<Prompts, 'preview' | 'save'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block' | 'save' | 'pause' | 'sync' | 'propose' | 'proposals'>
  readonly assessor: Pick<MasterAssessor, 'context' | 'read' | 'decide'>
  readonly resources: ResourceHost
  /** Installation automation tasks, present only when the Host's `schedule` service is installed. */
  readonly automations?: Automations
  /** The registered Execution projects, for validating a request's delivery units. */
  readonly projects: () => readonly { id: string; name: string; workspace: string }[]
  /** Applies existing labels to the Issue or pull request a Trigger names, through that Source kind. */
  label(triggerId: string, change: SourceLabelChange): Promise<SourceLabelResult>
  /** Delivers one file from a project workspace to a chat through the Source kind that supports file messages. */
  sendFile(request: { triggerId?: string; chatId?: string; project: string; path: string }):
  Promise<{ source: string; chatId: string; messageId: string | null }>
  /** Schedules a pass to carry out work queued by an Engine command (such as an Eval or ticket resume). */
  requestPass(): void
  sendReplies(): Promise<void>
  /** Runs an Engine command initiated by the main Session without emitting self-notifications. */
  quietly<T>(run: () => T): T
}
/** Schedules an Engine pass to execute the recorded routing decision and formats the tool response. */
function routed(host: MainToolsHost, result: { decision?: DecisionKind; reason: string; ticketId?: string | undefined }) {
  host.requestPass()
  const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
  return { ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
    ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
}
const fromDecision = (decision: Decision) => ({ decision: decision.kind, reason: reasonText(decision.reason), ticketId: decision.ticketId })
/**
 * One routing decision of `orchestrator_route`. The schema holds only its shape: each kind's fields are checked as its item
 * runs (`FIELDS`), so an item that lacks one, or whose value breaks a limit, is refused alone.
 */
const RouteItemSchema = z.object({
  kind: z.enum(['accept', 'attach', 'ignore', 'stop']),
  trigger_id: z.string().describe('The candidate card\'s trigger_id; deciding it decides its batch.'),
  ticket_id: z.string().nullish().describe('attach and stop: the ticket.'),
  title: z.string().nullish().describe('accept: a short label of at most 200 characters describing the original request.'),
  deliverable: z.enum(['change', 'answer']).nullish().describe('accept: what the work owes; `answer` is read-only and has no branch or pull request (default change).'),
  worktree_name: z.string().nullish().describe(`accept: ${WorktreeNameSchema.description ?? ''}`),
  acknowledgement: z.string().nullish().describe(`accept: one brief sentence of at most ${IM_WORDS} words naming the concrete change and intended result in the source language. It is posted as a reply to the original source, so do not quote it.`),
  note: z.string().nullish().describe(`accept and attach: ${RoutingNoteSchema.description ?? ''}`),
  project: z.string().nullish().describe('accept: the registered Execution project that owns the work, when the Trigger names no repository.'),
  deliverables: z.array(z.object({
    project: z.string().nullish(),
    title: z.string().nullish(),
    after: z.array(z.number().int().min(0)).nullish(),
  })).nullish().describe('accept: one entry per delivery unit when the request splits across projects; `after` names earlier indexes it waits on.'),
  reason: z.string().nullish().describe('ignore and stop: why, at most 500 characters; an ignore needs it.'),
}).strict()
type RouteItem = z.infer<typeof RouteItemSchema>
type Kind = RouteItem['kind']
type Field = Exclude<keyof RouteItem, 'kind' | 'trigger_id'>
/** Each field's check, the kinds whose items read it and those that need it; an item of another kind leaves it unread. */
const FIELDS: Record<Field, { check: z.ZodType; reads: readonly Kind[]; needs: readonly Kind[] }> = {
  ticket_id: { check: z.string(), reads: ['attach', 'stop'], needs: ['attach', 'stop'] },
  title: { check: z.string().max(200), reads: ['accept'], needs: ['accept'] },
  worktree_name: { check: WorktreeNameSchema, reads: ['accept'], needs: [] },
  deliverable: { check: z.enum(['change', 'answer']), reads: ['accept'], needs: [] },
  acknowledgement: { check: AcknowledgementSchema, reads: ['accept'], needs: ['accept'] },
  note: { check: RoutingNoteSchema, reads: ['accept', 'attach'], needs: [] },
  project: { check: z.string().trim().min(1).max(40), reads: ['accept'], needs: [] },
  reason: { check: z.string().max(500), reads: ['ignore', 'stop'], needs: ['ignore'] },
  deliverables: { check: z.array(z.object({ project: z.string().trim().min(1).max(40).nullish(), title: z.string().max(200).nullish(),
    after: z.array(z.number().int().min(0)).nullish() })).max(8), reads: ['accept'], needs: [] },
}
/** Why an item cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
function invalid(item: RouteItem): string | undefined {
  for (const [field, { check, reads, needs }] of Object.entries(FIELDS) as [Field, typeof FIELDS[Field]][]) {
    const value = item[field]
    if (!reads.includes(item.kind)) continue
    const blank = typeof value === 'string' ? value.trim() === '' : Array.isArray(value) && value.length === 0
    if (value === undefined || value === null || blank) {
      if (needs.includes(item.kind)) return `${item.kind} needs ${field}`
      continue
    }
    const checked = check.safeParse(value)
    if (!checked.success) return `${field}: ${checked.error.issues[0]?.message ?? 'invalid'}`
  }
  if (item.kind === 'accept' && (item.deliverable ?? 'change') === 'change' && !item.worktree_name) return 'accept needs worktree_name'
  return undefined
}
type Routed = { decision?: DecisionKind; reason: string; ticketId?: string | undefined; triggerIds?: readonly string[] }
/**
 * Carry out one routing decision as its Engine command, in a transaction of its own. `decided` holds the Triggers that this
 * call's earlier items decided, with their batches.
 */
function route(host: MainToolsHost, item: RouteItem, decided: ReadonlyMap<string, string>): Routed | { refused: string } {
  /**
   * A request must belong to a registered project: that project's checkout holds its worktree and names its repository.
   */
  function projectProblem(): string | undefined {
    const projects = host.store.settings().executor.projects
    if (item.deliverables?.length) {
      for (const unit of item.deliverables) {
        if (!unit.project) return 'Each deliverable names the registered project that owns it; register it in Execution → Projects'
        if (!projectOf(projects, unit.project)) return `Unknown project ${unit.project}; register it in Execution → Projects`
      }
      return undefined
    }
    if (item.project && !projectOf(projects, item.project)) {
      return `Unknown project ${item.project}; register it in Execution → Projects, or omit project to use the Trigger's repository`
    }
    if (item.project) return undefined
    const repository = host.store.triggers.get(item.trigger_id)?.meta.repository
    const named = typeof repository === 'string' ? repository : ''
    if (named && projectByRepository(projects, named)) return undefined
    return named ? `No registered project owns repository ${named}; register it in Execution → Projects`
      : 'This request names no project; register the project in Execution → Projects and accept it again with project'
  }
  const note = item.note ? { note: item.note } : {}
  // A Trigger an earlier item decided went with that item's Decision, also as a member of its batch.
  // A stop of it for another ticket is the Engine's to judge.
  const earlier = decided.get(item.trigger_id)
  if (earlier && item.kind === 'ignore') return { refused: `Decided in this call with ${earlier}, whose Decision took its batch` }
  switch (item.kind) {
    case 'accept': {
      const problem = projectProblem()
      if (problem) return { refused: problem }
      const before = host.store.triggers.disposition(item.trigger_id)?.decisionId
      const decision = host.engine.decide(item.trigger_id, { kind: 'accept', title: item.title!, scope: item.title!, reason: { code: 'explicitRouted' },
        acknowledgement: item.acknowledgement!, deliverable: item.deliverable ?? 'change', ...(item.worktree_name ? { name: item.worktree_name } : {}), ...(item.project ? { project: item.project } : {}),
        ...(item.deliverables?.length ? { deliverables: item.deliverables.map(unit => ({ ...(unit.project ? { project: unit.project } : {}), ...(unit.title ? { title: unit.title } : {}), ...(unit.after?.length ? { after: unit.after } : {}) })) } : {}), ...note })
      // A Decision that created no ticket is the item's refusal; one that existed before keeps what it was accepted with.
      if (decision.kind !== 'accept' || !decision.ticketId) return { refused: `Ticket was not created: ${reasonText(decision.reason)}` }
      if (decision.id === before) {
        return { decision: 'accept', reason: `Already accepted as ${decision.ticketId}; title and acknowledgement unchanged`, ticketId: decision.ticketId }
      }
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'attach': {
      const ticket = host.quietly(() => host.engine.attach(item.ticket_id!, item.trigger_id, item.note ?? undefined))
      return { reason: 'Attached: the ticket follows the trigger\'s thread and receives the trigger', ticketId: ticket.id }
    }
    // Through `engine.decide`, so only a person's message the gate admits with explicit strength stops a ticket.
    case 'stop': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'stop', ticketId: item.ticket_id!, reason: item.reason || { code: 'humanStop' } })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'ignore': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'ignore', reason: item.reason! })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
  }
}
/**
 * `orchestrator_route`: routing decisions for several triggers in one call, in order. Each runs as its own Engine command; one
 * that is refused, or fails, is answered so, and the others still run.
 */
function routeTool(host: MainToolsHost): Tool {
  return tool({
    name: 'orchestrator_route',
    description: 'Route candidates, one item each by trigger_id, in one call: accept an explicit request as a new ticket, attach a trigger to an existing ticket, stop a ticket on a person\'s stop message, or ignore a candidate needing no ticket or stop. Each item is answered alone; a refused item leaves the others. An inferred candidate may only be ignored here.',
    schema: z.object({ decisions: z.array(RouteItemSchema).min(1).max(20) }).strict(),
    execute: async ({ decisions }) => {
      const decided = new Map<string, string>()
      const results = decisions.map(item => {
        const head = { trigger_id: item.trigger_id, kind: item.kind }
        const problem = invalid(item)
        if (problem) return { ...head, refused: problem }
        try {
          const result = route(host, item, decided)
          if ('refused' in result) return { ...head, ...result }
          for (const id of result.triggerIds ?? []) if (!decided.has(id)) decided.set(id, item.trigger_id)
          const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
          return { ...head, ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
            ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
        } catch (error) {
          if (error instanceof UserError) return { ...head, refused: error.message }
          host.context.logger.warn('dsh-superagent-further could not route trigger %s: %s', item.trigger_id, String(error))
          return { ...head, refused: `Not recorded: ${error instanceof Error ? error.message : String(error)}; retry this item` }
        }
      })
      host.requestPass()
      return { results }
    },
  })
}
/** Builds the main Session's tools; `agent` scopes prompt preview resources to that Session. */
export function mainTools(host: MainToolsHost, agent: Agent): Tool[] {
  const resources: MainResourceHost = { ...host.resources, sessions: host.sessions, settings: host.settings }
  return [
    readTool('Read one page of a resource the resource parameter lists, such as the ticket list or a ticket. Follow next_offset, and next_resource where a page names one.',
      false, (resource, offset, limit, signal) => readResource(resources, resource, offset, limit, undefined, signal)),
    routeTool(host),
    tool({
      name: 'orchestrator_ticket_retry',
      description: 'Start a new assignment on an explicit human retry request for a ticket whose worker failed, blocked, or lost an input; the stalled one ends.',
      schema: z.object({ ticket_id: z.string() }).strict(),
      execute: async args => routed(host, { reason: 'Started a new assignment', ticketId: host.engine.retryTicket(args.ticket_id).id }),
    }),
    tool({
      name: 'orchestrator_ticket_request_status',
      description: 'Ask the worker of an idle ticket, whose turn ended without a report, for a status report; other tickets get nothing.',
      schema: z.object({ ticket_id: z.string() }).strict(),
      execute: async args => {
        const reason = host.engine.requestStatus(args.ticket_id) ? 'Asked the worker for a status report' : 'The worker is not waiting; nothing was sent'
        return routed(host, { reason, ticketId: args.ticket_id })
      },
    }),
    tool({
      name: 'orchestrator_ticket_note',
      description: 'Tell a ticket\'s worker a fact from other work, such as what another ticket found; it grants no authority.',
      schema: z.object({
        ticket_id: z.string(),
        text: z.string().trim().min(1).refine(text => wordCount(text) <= IM_WORDS, `At most ${IM_WORDS} words`),
      }).strict(),
      execute: async args => {
        host.engine.note(args.ticket_id, args.text)
        return routed(host, { reason: 'Noted for the worker', ticketId: args.ticket_id })
      },
    }),
    tool({
      name: 'orchestrator_trigger_requeue',
      description: 'Queue a trigger for a fresh assessment, such as after its Source\'s access changed; a follow-up that reached a ticket returns only from its worker.',
      schema: z.object({ trigger_id: z.string() }).strict(),
      execute: async args => {
        // A follow-up that reached a ticket is its worker's to judge, which hands back what is not its own; a person may still requeue it.
        const trigger = host.store.triggers.get(args.trigger_id)
        const owners = trigger ? followupOwners(trigger, host.store) : []
        if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
        const queued = host.quietly(() => host.engine.reevaluate(args.trigger_id))
        host.requestPass()
        return { queued }
      },
    }),
    tool({
      name: 'orchestrator_eval',
      description: 'Load a proactive candidate\'s window and its thread\'s tickets; repeated calls reuse them.',
      schema: z.object({ trigger_id: z.string() }).strict(),
      execute: async (args, signal) => host.assessor.context(args.trigger_id, signal),
    }),
    tool({
      name: 'orchestrator_eval_read',
      description: 'Read more of a candidate\'s context with its trigger_id: a message by message_id, an image by image_id, the root, parent, a thread page by cursor, or a file by path.',
      schema: EvalReadSchema,
      execute: async (read, signal) => host.assessor.read(agent, read, signal),
    }),
    tool({
      name: 'orchestrator_eval_decide',
      description: 'Record an assessment\'s decision after orchestrator_eval with the same trigger_id, as admission describes it.',
      schema: z.object({ trigger_id: z.string().min(1), ...AssessmentSchema.shape }).strict(),
      execute: async ({ trigger_id, ...result }, signal) => {
        const decided = await host.assessor.decide(trigger_id, AssessmentSchema.parse(result), signal)
        return routed(host, { decision: decided.state as DecisionKind, reason: decided.reason, ticketId: decided.ticket_id })
      },
    }),
    tool({
      name: 'orchestrator_reply',
      description: `Send an answer, a ready result, or attention requiring human action, as the replies section says; the gate refuses other purposes. purpose=result needs a ticket in person/review after a ready report, a completed or merged one, or a dropped one whose rule asks for a closing message. IM limit: ${IM_WORDS} words.`,
      schema: z.object({
        trigger_id: z.string().optional().describe('The original human question, for an answer only.'),
        ticket_id: z.string().optional(),
        purpose: z.enum(['answer', 'result', 'attention']),
        human_action: z.string().trim().min(1).optional().describe('Required for attention: the current attention question.'),
        text: z.string().min(1).max(20000),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: args.purpose, text: args.text, ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          ...(args.ticket_id ? { ticketId: args.ticket_id } : {}), ...(args.human_action ? { question: args.human_action } : {}) })
        await host.sendReplies()
        return { status: host.store.replyStatus(reply.id) ?? reply.status }
      },
    }),
    tool({
      name: 'orchestrator_thread_unsubscribe',
      description: 'Drop every ticket subscription on a thread; later messages there no longer reach those tickets, and a positive decision can subscribe it again.',
      schema: z.object({ thread: z.string().describe('Thread key, for example github:123 or feishu:<chat>:<root message>') }).strict(),
      execute: async args => {
        return { removed: host.quietly(() => host.engine.unsubscribe(args.thread)), thread: args.thread }
      },
    }),
    tool({
      name: 'orchestrator_settings_save',
      description: 'Save tier-A settings on an explicit human request; read revisions with orchestrator_read settings.',
      schema: z.object({
        block: z.enum(['policy', 'eval', 'executor', 'pause', 'source']).describe('pause pauses or resumes processing.'),
        source: z.string().min(1).optional().describe('With block source: the Source instance id.'),
        value: z.unknown().describe('The block.'),
        revision: z.number().int().nonnegative().describe('The revision.'),
        reason: z.string().trim().min(1).max(280).describe('The person\'s words asking for the change.'),
      }).strict()
        .refine(args => (args.block === 'source') === (args.source !== undefined), 'source names the Source instance, with block source only'),
      execute: async args => {
        const audit = { actor: agent.id, reason: args.reason }
        if (args.block === 'pause') return host.settings.pause(z.object({ paused: z.boolean() }).parse(args.value).paused, 'tool', audit)
        // Strip context_delivery since the main Session initiated the save itself.
        const { context_delivery: _delivery, ...saved } = await host.settings.save(args.block === 'source' ? `source:${args.source!}` : args.block,
          args.value, args.revision, 'tool', audit)
        return saved
      },
    }),
    tool({
      name: 'orchestrator_settings_propose',
      description: 'Propose a tier-B settings change for the operator to approve in the management panel; read pending ones with orchestrator_read settings/proposals.',
      schema: z.object({
        block: z.enum(['policy', 'eval', 'executor', 'memory', 'language', 'source']),
        source: z.string().min(1).optional(),
        value: z.unknown(),
        reason: z.string().trim().min(1).max(280).describe('The person\'s words asking for the change.'),
      }).strict()
        .refine(args => (args.block === 'source') === (args.source !== undefined), 'source names the Source instance, with block source only'),
      execute: async args => {
        const proposal = host.settings.propose(args.block === 'source' ? `source:${args.source!}` : args.block,
          args.value, args.reason, agent.id)
        return { proposal_id: proposal.id, block: proposal.block, base_revision: proposal.base_revision,
          expires_at: proposal.expires_at, diff: proposal.diff }
      },
    }),
    tool({
      name: 'orchestrator_policy_sync',
      description: 'Refresh one Source\'s part of the Policy from where that Source keeps it, such as the Feishu users of its sync chat.',
      schema: z.object({ source: z.string() }).strict(),
      execute: async args => {
        const before = host.store.settings().policy.sources[args.source]?.allowed ?? []
        const after = (await host.settings.sync(args.source)).allowed
        const names = (from: typeof after, without: typeof after) => from.filter(item => !without.some(other => other.id === item.id))
          .map(item => item.name ?? item.id)
        return { source: args.source, allowed: after.length, added: names(after, before), removed: names(before, after) }
      },
    }),
    ...(host.automations === undefined ? [] : automationTools(host.automations, agent.id)),
    tool({
      name: 'orchestrator_label',
      description: 'Add or remove existing labels on the GitHub Issue or pull request a Trigger names. Never creates labels, changes code, closes work or decides a candidate; use only on an explicit human request to label or triage. A non-GitHub Trigger cannot be labeled.',
      schema: z.object({
        trigger_id: z.string().trim().min(1).describe('The Trigger naming the Issue or pull request.'),
        add: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe('Existing label names to add.'),
        remove: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe('Labels on the target to remove.'),
      }).strict().refine(value => (value.add?.length ?? 0) + (value.remove?.length ?? 0) > 0, 'Name at least one label to add or remove'),
      execute: async args => host.label(args.trigger_id, { add: args.add, remove: args.remove }),
    }),
    tool({
      name: 'orchestrator_send_file',
      description: 'Deliver one existing file from a project workspace to a Feishu chat as a bot file message, so people away from this machine can read a design or decision document. Only workspace-relative paths; never edits files. Use only on an explicit human request, or when a Ticket asks for the document to be delivered.',
      schema: z.object({
        trigger_id: z.string().trim().min(1).optional().describe('The Trigger whose chat receives the file; use instead of chat_id.'),
        chat_id: z.string().trim().min(1).optional().describe('A Feishu chat ID (oc_...) when no Trigger names the chat.'),
        project: z.string().trim().min(1).describe('The registered project whose workspace holds the file.'),
        path: z.string().trim().min(1).describe('Workspace-relative file path; absolute paths and .. are refused.'),
      }).strict().refine(value => (value.trigger_id === undefined) !== (value.chat_id === undefined), 'Name exactly one of trigger_id and chat_id'),
      execute: async args => host.sendFile(args),
    }),
    tool({
      name: 'orchestrator_request_create',
      description: 'Create one installation-level Request with one Ticket per delivery unit, from work an installation automation delivery asked you to act on: pass the automation id from the delivery marker ([AUTOMATION auto-… · installation]). Use it only for that delivery; project automation findings are raised by their project Lead, and work that needs a person\'s decision keeps its existing route. Every unit names a registered project. The Request records the automation id as its Mandate provenance and runs without external Channels.',
      schema: z.object({
        title: z.string().trim().min(1).max(200).describe('A short label for the whole Request; the first unit falls back to it as its Ticket title.'),
        instruction: z.string().trim().min(1).max(8000).describe('The complete work: what to do, where, and how to verify it.'),
        automation: z.string().trim().min(1).max(200).describe('The installation automation id from the delivery marker.'),
        project: z.string().trim().min(1).optional().describe('Default registered project for units that omit one.'),
        deliverable: z.enum(['change', 'answer']).optional().describe('What the Tickets owe (default change); answer is read-only.'),
        deliverables: z.array(z.object({
          project: z.string().trim().min(1).optional(),
          title: z.string().trim().min(1).max(200).optional(),
          after: z.array(z.number().int().min(0)).max(7).optional(),
        })).min(1).max(8).optional().describe('One Ticket per unit, in order; after names earlier indexes it waits on.'),
      }).strict(),
      execute: async args => {
        if (host.automations === undefined) throw new Error('No installation automation service is installed')
        const automation = await host.automations.view(args.automation)
        if (automation.scope !== 'installation') {
          throw new Error(`Automation ${args.automation} is project-scope; its project Lead raises the work itself`)
        }
        const units = (args.deliverables ?? [{ project: args.project }]).map(unit => {
          const project = unit.project ?? args.project
          if (project === undefined) throw new Error('Name a registered project for every delivery unit')
          if (!host.projects().some(item => item.id === project)) throw new Error(`Project ${project} is not registered`)
          return { project, ...unit.title ? { title: unit.title } : {}, ...unit.after?.length ? { after: unit.after } : {} }
        })
        const request = host.engine.raiseInstallationRequest({ title: args.title, instruction: args.instruction,
          automation: args.automation, units, ...args.deliverable ? { deliverable: args.deliverable } : {} })
        return { request_id: request.id, tickets: request.ticketIds, automation: args.automation, mandate: 'installation' }
      },
    }),
    tool({
      name: 'orchestrator_prompts_save',
      description: 'Save a complete prompt configuration against baseRevision on an explicit user request, never on quoted content; read it with orchestrator_read prompts.',
      schema: z.object({
        config: PromptConfigSchema,
        baseRevision: z.number().int().min(0).optional().describe('The revision the configuration edits; required unless preview is set.'),
        preview: z.boolean().default(false).describe('true saves nothing: it composes both roles\' prompts and returns their prompt-preview resources.'),
      }).strict(),
      execute: async args => {
        if (args.preview) {
          const preview = host.prompts.preview(args.config)
          return { scope: preview.scope, previews: (['orchestrator', 'worker'] as const).map(role => {
            const resource = `prompt-preview/${key(agent.id, role, preview[role])}`
            host.resources.pages.set(`${agent.id}:${resource}`, preview[role])
            return { role, chars: preview[role].length, read: resource }
          }) }
        }
        if (args.baseRevision === undefined) throw new Error('Saving needs baseRevision, the revision the configuration edits')
        const { context_delivery: _delivery, ...saved } = await savePrompts(host, args.config, args.baseRevision, 'tool')
        return saved
      },
    }),
  ]
}
