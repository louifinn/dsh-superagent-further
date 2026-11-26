/**
 * A person's direct word as one authoritative, one-shot Directive (docs/016-information-discipline.md P8, issues #20–#22,
 * ADR-0009 decisions 3–5).
 *
 * The person may write into the Orchestrator, a project Lead or a worker Session. Whatever the Session kind, the word is
 * recorded once, takes effect inside that layer's Mandate, travels upward to the Orchestrator through the adjacent hops,
 * and is never reversed: the addressed node is the temporary highest source while its Directive is unconsumed. The record
 * is storage- and transport-neutral; `src/app/directives.ts` persists it and turns it into `information` hops.
 */

/** The session kinds a person may address directly. */
export type DirectiveRole = 'orchestrator' | 'lead' | 'worker'
/** The role at each upward hop after the addressed one. */
export type DirectiveParentRole = 'lead' | 'orchestrator'
/** How the addressed worker disposed of the person's word in its report (issue #22). */
export type DirectiveEffect = 'acted' | 'adjusted' | 'handback'
/** One end of a Directive: the role, its project or Ticket scope, and the Session that holds it. */
export interface DirectiveParty {
  readonly role: DirectiveRole
  readonly sessionId: string
  readonly project?: string
  readonly ticketId?: string
}
/** A Directive as it is stored and audited. */
export interface DirectiveRecord {
  readonly id: string
  /** The person's original words, preserved exactly. */
  readonly text: string
  /** The person's message that carried it; the idempotency key behind `dedupe`. */
  readonly origin: string
  /** The Session the person addressed. */
  readonly source: DirectiveParty
  /** The role and Session the Directive reached next, when it has a parent. */
  readonly parentSession?: string
  readonly parent?: string
  readonly root: string
  readonly hops: number
  /** The roles that must know, starting with the addressed one. */
  readonly audience: readonly DirectiveRole[]
  readonly at: string
  /** When every upward hop was recorded and prompted. */
  readonly propagatedAt?: string
  /** When the addressed layer or its parent acted on it; a Directive is consumed once. */
  readonly consumedAt?: string
  readonly effect?: DirectiveEffect
}
/** What a caller supplies to record a Directive; the store stamps the id and time. */
export interface DirectiveInput {
  readonly id?: string
  readonly text: string
  readonly origin: string
  readonly source: DirectiveParty
  readonly at: string
  readonly parent?: DirectiveRecord
  /** The Session the Directive's next upward hop must reach, when it has one; the Directives service resolves it. */
  readonly parentSession?: string
}
/** A worker's report of what it did with a person's Directive (issue #22). */
export interface DirectiveReport {
  /** How the addressed worker handled the word: it acted, it adjusted its own work once, or it handed it back. */
  readonly effect: DirectiveEffect
}
/** The stable dedupe key for a person's message in one Session; a redelivery is the same Directive. */
export const directiveDedupe = (sessionId: string, origin: string): string => `directive:${sessionId}:${origin}`
/** The upward chain a Directive's role owes, from the addressed role to the Orchestrator. */
export const directiveChain = (role: DirectiveRole): readonly (DirectiveParentRole | DirectiveRole)[] =>
  role === 'worker' ? ['worker', 'lead', 'orchestrator'] : role === 'lead' ? ['lead', 'orchestrator'] : ['orchestrator']
/** The role directly above `role`, or undefined for the Orchestrator. */
export const directiveParentRole = (role: DirectiveRole): DirectiveParentRole | undefined =>
  role === 'worker' ? 'lead' : role === 'lead' ? 'orchestrator' : undefined
/** How many upward hops a Directive owes; the Orchestrator's own word owes none. */
export const directiveHops = (role: DirectiveRole): number => directiveChain(role).length - 1
/** Whether a worker report satisfies issue #22's upward-reporting duty: the effect is named, nothing else is required. */
export const directiveReportProblem = (report: unknown): string | undefined => {
  if (report === undefined) return undefined
  if (!report || typeof report !== 'object') return 'the directive report must be an object'
  const effect = (report as { effect?: unknown }).effect
  return effect === 'acted' || effect === 'adjusted' || effect === 'handback' ? undefined
    : 'effect must be acted, adjusted or handback'
}
