/**
 * The model-facing surface inventory (issue #6, docs/015 D1): what each role's model actually sees, read from the
 * runtime's own registrations instead of a hand list. Step 2 of the migration order moves the test-only `collect()`
 * sweep here; the declarative `SURFACES` record, the projection table and the generated budgets arrive in the next
 * steps.
 */
import { RESOURCE_NAMES, RESOURCES } from './resources.ts'

/** Every role whose model-facing surface the design has to account for; the Lead and reviewer gap is declared below. */
export type RoleId = 'orchestrator' | 'worker' | 'lead' | 'reviewer'
export const ROLE_IDS: readonly RoleId[] = ['orchestrator', 'worker', 'lead', 'reviewer']

/**
 * Roles the runtime assembles and registers today. `promptParts` composes only the Orchestrator and the worker; the
 * Lead's prompt is composed by its own function and the reviewer has no prompt of its own yet, so neither appears in
 * the inventory. Step 3 of docs/015 closes this gap; until then the pair is declared, not silently omitted.
 */
export const COLLECTED_ROLES: readonly RoleId[] = ['orchestrator', 'worker']
export const UNCOLLECTED_ROLES: readonly RoleId[] = ['lead', 'reviewer']

/** One composed prompt part, as `promptParts` returns it. */
export interface SurfacePart { readonly name: string; readonly text: string }
/** One registered application tool, reduced to the text its model reads. */
export interface SurfaceTool { readonly name: string; readonly description: string; readonly parameters: unknown }
/** One registered skill, as a Session sees it. */
export interface SurfaceSkill { readonly name: string; readonly description: string; readonly content: string }

/** What a running runtime registered for one role, as opposed to what docs/015 declares it should register. */
export interface RoleRegistration {
  readonly role: RoleId
  readonly parts: readonly SurfacePart[]
  /** Prompt text the runtime generates beyond the parts: revision, environment, the projects a Lead owns. */
  readonly generated: string
  readonly tools: readonly SurfaceTool[]
  readonly skills: readonly SurfaceSkill[]
}

/** One model-facing text in the inventory. */
export interface SurfaceText { readonly role: RoleId; readonly where: string; readonly text: string }

/**
 * The model-facing text of every registered role: one entry per prompt part, one for the generated part, one per tool
 * description and one per skill. The inventory is a function of the runtime's registrations, so the tests, the panel
 * and (later) the reference generator can read the same answer instead of each keeping its own list.
 */
export function collectSurfaces(registrations: readonly RoleRegistration[]): SurfaceText[] {
  const surfaces: SurfaceText[] = []
  for (const registration of registrations) {
    for (const part of registration.parts) surfaces.push({ role: registration.role, where: `${registration.role} prompt ${part.name}`, text: part.text })
    if (registration.generated !== '') surfaces.push({ role: registration.role, where: `${registration.role} prompt from the runtime`, text: registration.generated })
    for (const tool of registration.tools) surfaces.push({ role: registration.role, where: `${registration.role} tool ${tool.name}`, text: tool.description })
    for (const skill of registration.skills) surfaces.push({ role: registration.role, where: `skill ${skill.name}`, text: `${skill.description}\n${skill.content}` })
  }
  return surfaces
}

/** The declared roles a set of registrations leaves out; the Lead and reviewer are expected until docs/015 step 3. */
export function uncollectedRoles(registered: readonly RoleId[]): RoleId[] {
  const seen = new Set(registered)
  return ROLE_IDS.filter(role => !seen.has(role))
}

/** The resource grammar, as the inventory snapshots it; which role may read a name comes from that role's reads. */
export const RESOURCE_GRAMMAR: readonly { name: string; holds: string }[] = RESOURCES.map(({ name, holds }) => ({ name, holds }))

const array = (items: readonly string[]): readonly string[] => [...items]

/** The worker's reads (docs/015 D5): its own ticket, its messages, and the thread and trigger it was reached by. */
export const WORKER_READS: readonly string[] = array([
  'thread/<key>', 'ticket/<id>', 'ticket/<id>/assignment', 'ticket/<id>/assignments', 'ticket/<id>/inputs',
  'ticket/<id>/result', 'ticket/<id>/report/<id>', 'ticket/<id>/transcript', 'ticket/<id>/message/<n>',
  'ticket/<id>/input/<id>', 'trigger/<id>', 'prompts/<revision>', 'feishu/<trigger-id>/…', 'github/…',
])

/** The reviewer's reads are a subset of the worker's: the change it reviews is one ticket (docs/015 D5/D6). */
export const REVIEWER_READS: readonly string[] = array([
  'ticket/<id>', 'ticket/<id>/result', 'ticket/<id>/report/<id>', 'ticket/<id>/transcript', 'ticket/<id>/message/<n>',
])

/**
 * The prompt sections a surface may name, in the order the composer emits them. The names are the composer's vocabulary,
 * not `PART_KEYS` verbatim: `role` and `team/*` expand against the role, and `project` is generated from the project a Lead
 * owns (docs/015 D1). A section the composer does not know fails to compile here, before it can drift from `PART_KEYS`.
 */
export const SURFACE_SECTIONS = ['shared', 'role', 'team/communication', 'team/scope', 'team/delivery', 'subscriptions',
  'replies', 'dispatch', 'work', 'admission', 'handoff', 'environment', 'policy', 'project'] as const
export type SurfaceSection = typeof SURFACE_SECTIONS[number]

/** The runtime-context contributions a role receives; the scope each one takes is decided by the registration code. */
export type RuntimeKey = 'memory' | 'automations' | 'language'

/** Which bucket one budget entry bounds (docs/015 D4): the prompt text, the tool-schema text, or what the runtime injects. */
export type BudgetKind = 'prompt' | 'tool-schemas' | 'injection'
/**
 * Why a budget is the number it is (docs/015 D4): a budget change is a data change with a reason, reviewed in a diff. `delta`
 * names the measured movement, `issue` the request that asked for it, and `date` when the reason was recorded.
 */
export interface BudgetReason {
  readonly change: string
  readonly delta: string
  readonly issue: string
  readonly date: string
}
/** One bound of one role's model-facing text. */
export interface BudgetEntry { readonly kind: BudgetKind; readonly chars: number; readonly reason: BudgetReason }

/** A structured reason helper: the current numbers are the 0.4.x surface, measured 2026-11-26 for issue #6. */
const budgetReason = (change: string, delta: string): BudgetReason => ({ change, delta, issue: '#6', date: '2026-11-26' })

/** What docs/015 declares one role's model should see; the whole point is that the assembly code reads this, not a second list. */
export interface Surface {
  readonly sections: readonly SurfaceSection[]
  /** Application tool names; DSH-native preset tools (bash, read, jobs, subagent) stay preset configuration, not surface entries. */
  readonly tools: readonly string[]
  /** Resource visibility over the `RESOURCES` name templates; empty until docs/015 step 6 derives it. */
  readonly reads: readonly string[]
  readonly runtimes: readonly RuntimeKey[]
  /** The bounds a test and the generated docs/budgets.md page read, each with its structured reason (docs/015 D4). */
  readonly budget: readonly BudgetEntry[]
  /** The reviewer is a subagent activation without a prompt of its own: this is the instruction its activation carries. */
  readonly activation?: string
}

/**
 * The one declaration each role's assembly reads (docs/015 D1). It is exhaustive by TypeScript's own rule: adding a role
 * without an entry fails to compile, and a knowingly empty surface (the reviewer's) is still declared.
 *
 * Assembly: `promptParts`/`composeSurfacePrompt` iterate `sections`; `Sessions` checks every registered application tool
 * against `tools`; the reviewer's activation text comes from `activation`. `reads` and the projection table arrive in
 * docs/015 steps 4–6, which is why they are empty here rather than guessed.
 */
export const SURFACES: Record<RoleId, Surface> = {
  orchestrator: {
    sections: ['shared', 'role', 'team/communication', 'team/scope', 'team/delivery', 'subscriptions', 'replies', 'dispatch',
      'admission', 'handoff', 'environment', 'policy'],
    tools: ['orchestrator_read', 'orchestrator_route', 'orchestrator_lead_instruction', 'orchestrator_trigger_requeue', 'orchestrator_eval',
      'orchestrator_eval_read', 'orchestrator_eval_decide', 'orchestrator_reply', 'orchestrator_thread_unsubscribe',
      'orchestrator_settings_save', 'orchestrator_settings_propose', 'orchestrator_policy_sync', 'orchestrator_label',
      'orchestrator_send_file', 'orchestrator_request_create', 'orchestrator_issue_create', 'orchestrator_incident',
      'orchestrator_escalations', 'orchestrator_escalation_decide', 'orchestrator_correlate', 'orchestrator_prompts_save', 'automation_create',
      'automation_list', 'automation_view', 'automation_edit', 'automation_run', 'automation_delete', 'memory_write',
      'memory_search', 'memory_forget'],
    reads: RESOURCE_NAMES,
    runtimes: ['memory', 'automations', 'language'],
    budget: [
      { kind: 'prompt', chars: 47_400, reason: budgetReason('the headline prompt plus its generated parts, as the surface test composes it',
        '45,145 measured on 2026-11-26; the 5% headroom covers the team sections') },
      { kind: 'tool-schemas', chars: 31_000, reason: budgetReason('the JSON of the main Session application tool definitions, excluding DSH-native tools',
        '28,617 measured on 2026-11-26; tools move together with capability, never silently') },
      { kind: 'injection', chars: 6_000, reason: budgetReason('the runtime-context text the main Session receives around its prompt',
        'memory, language and automation snapshots stay together under this bound') },
    ],
  },
  worker: {
    sections: ['shared', 'role', 'team/communication', 'team/scope', 'team/delivery', 'subscriptions', 'replies', 'work', 'handoff',
      'environment'],
    tools: ['orchestrator_read', 'orchestrator_ack', 'orchestrator_thread_unrelated', 'orchestrator_thread_follow', 'orchestrator_trigger_handback',
      'request_create', 'orchestrator_report'],
    reads: WORKER_READS,
    runtimes: ['language'],
    budget: [
      { kind: 'prompt', chars: 38_800, reason: budgetReason('the worker prompt, as the runtime hands it to the Executor Session',
        '36,872 measured on 2026-11-26; the 5% headroom covers the work and handoff sections') },
      { kind: 'tool-schemas', chars: 8_200, reason: budgetReason('the JSON of the worker application tool definitions',
        '7,697 measured on 2026-11-26; a worker tool is added only with the rule that names it') },
      { kind: 'injection', chars: 1_000, reason: budgetReason('the language directive a worker receives around its prompt',
        'the worker has no memory or automation injection by design') },
    ],
  },
  lead: {
    sections: ['shared', 'role', 'team/communication', 'team/scope', 'team/delivery', 'subscriptions', 'replies', 'environment',
      'project'],
    tools: ['orchestrator_read', 'lead_status', 'lead_requests', 'lead_assign', 'lead_fact', 'lead_request_create', 'lead_request_escalate',
      'lead_review', 'lead_review_record', 'lead_request_decide', 'lead_request_approval', 'lead_request_approve',
      'lead_request_reply', 'lead_request_complete', 'lead_ticket_note', 'lead_ticket_request_status', 'lead_ticket_retry',
      'lead_ticket_stop', 'lead_ticket_attach', 'lead_instruction_reply', 'lead_notify_worker', 'lead_report', 'memory_write',
      'memory_search', 'memory_forget'],
    reads: WORKER_READS,
    runtimes: ['memory', 'automations', 'language'],
    budget: [
      { kind: 'prompt', chars: 50_000, reason: budgetReason('the Lead prompt assembled from its surface sections and the project it owns',
        'the Lead was outside the budget until #6; its prompt derives from SURFACES now, so this entry can be measured') },
      { kind: 'tool-schemas', chars: 30_000, reason: budgetReason('the JSON of the Lead application tool definitions, including the project memory tools',
        'the Lead tool set is the widest of the four roles, which is why it had to enter the same table') },
      { kind: 'injection', chars: 8_000, reason: budgetReason('the runtime-context text a Lead receives around its prompt',
        'memory, language and automation snapshots stay together under this bound') },
    ],
  },
  reviewer: {
    sections: [],
    tools: [],
    reads: REVIEWER_READS,
    runtimes: [],
    budget: [
      { kind: 'prompt', chars: 400, reason: budgetReason('the reviewer activation text, which is the only model-facing text this role has',
        'the same text the review dispatch carries; a longer review instruction raises this entry in the same diff') },
    ],
    activation: 'Review this change independently in the project worktree: read the diff and the relevant code, run the checks '
      + 'that matter, and answer with a concise verdict. The Lead records it with lead_review_record; do not edit files, commit '
      + 'or merge.',
  },
}

/** Whether a surface section is one the composer can emit; used by the tests that keep `SURFACES` and `PART_KEYS` aligned. */
export function isSurfaceSection(value: string): value is SurfaceSection {
  return (SURFACE_SECTIONS as readonly string[]).includes(value)
}
