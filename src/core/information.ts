/**
 * One authoritative record per cross-role fact (docs/016-information-discipline.md, P1–P5; issue #13, ADR-0009
 * decision 1). A message is delivered as an effect of this record — delivery can fail, retry or be refused, and it never
 * creates a second source of the same fact. Records carry their origin chain (`root`/`parent`/`hops`), the direction of
 * travel, who was supposed to know (`audience`) and whether the message is consumed once (`oneShot`).
 *
 * The shape is storage- and transport-neutral: `src/app/information.ts` persists it, `LeadMessages` writes one record
 * before it stores a durable message, and the `information` read resource exposes it to the Orchestrator.
 */

/** The roles a record can travel between; the Executor is the worker of a Ticket. */
export type InformationRole = 'orchestrator' | 'lead' | 'worker' | 'reviewer' | 'person'
/** The kind of fact a record carries, mirroring the durable messages between roles. */
export type InformationKind = 'assignment' | 'fact' | 'report' | 'question' | 'notice' | 'instruction' | 'relay'
/** The direction a record travels through the role tree. */
export type InformationDirection = 'down' | 'up' | 'in'
/** One end of a record: a role, and the project when the role is project-scoped. */
export interface InformationParty {
  readonly role: InformationRole
  readonly project?: string
}
/** What a caller supplies to record one fact; the Store stamps `id` (unless given) and `createdAt`. */
export interface InformationInput {
  /** The record id; a sender may reuse the durable message id so the two rows read as one fact. */
  readonly id?: string
  readonly kind: InformationKind
  readonly direction: InformationDirection
  readonly source: InformationParty
  readonly target: InformationParty
  /** The roles that should know this fact. */
  readonly audience: readonly InformationRole[]
  /** 0 for an origin; otherwise the parent's hops plus one. */
  readonly hops: number
  /** Whether consuming the message ends it (an instruction or a command), rather than a durable notice. */
  readonly oneShot: boolean
  /** The idempotency key: the same fact sent twice is one record. */
  readonly dedupe: string
  /** The recorded fact: the text and the ids it concerns. */
  readonly payload: unknown
  readonly root: string
  readonly parent?: string
  readonly createdAt?: string
}
/** One recorded fact. */
export interface InfoRecord extends Required<Pick<InformationInput, 'kind' | 'direction' | 'source' | 'target' | 'audience'
  | 'hops' | 'oneShot' | 'dedupe' | 'payload' | 'root'>> {
  readonly id: string
  readonly parent?: string
  readonly createdAt: string
  /** When the target's Session took the message. */
  readonly deliveredAt?: string
  /** When the target's answer arrived. */
  readonly ackAt?: string
}
/** The roles a record may travel between; any other pair is a forbidden edge (docs/016 P5, acceptance 3). */
export const ALLOWED_EDGES: readonly (readonly [InformationRole, InformationRole])[] = [
  ['orchestrator', 'lead'],
  ['lead', 'orchestrator'],
  ['lead', 'worker'],
  ['worker', 'lead'],
  ['lead', 'reviewer'],
  ['reviewer', 'lead'],
  // A person may address any handled level directly (docs/016 P8, issue #20); the word is recorded in from the person and
  // travels upward through the adjacent hops after that.
  ['person', 'orchestrator'],
  ['person', 'lead'],
  ['person', 'worker'],
  ['lead', 'person'],
]
/** Whether a record from `from` to `to` would cross a forbidden edge. */
export const forbiddenEdge = (from: InformationRole, to: InformationRole): boolean =>
  !ALLOWED_EDGES.some(([a, b]) => a === from && b === to)
/** The direction of a message between two roles: a person is outside the tree, so that direction is `in`. */
export const directionOf = (from: InformationRole, to: InformationRole): InformationDirection => {
  if (from === 'person') return 'in'
  if (from === 'orchestrator') return 'down'
  if (to === 'orchestrator') return 'up'
  if (from === 'lead' && (to === 'worker' || to === 'reviewer')) return 'down'
  if ((from === 'worker' || from === 'reviewer') && to === 'lead') return 'up'
  // lead -> person still travels away from the tree, toward a person.
  return 'down'
}
/** Commands that end when consumed; a notice or report stays available for audit. */
export const ONE_SHOT_KINDS: readonly InformationKind[] = ['assignment', 'fact', 'instruction']
/** Whether `record` may exist: a legal edge, a non-negative hop count and an origin when it has no parent. */
export function informationProblem(record: Pick<InfoRecord, 'source' | 'target' | 'direction' | 'hops' | 'root' | 'parent'>): string | undefined {
  const { source, target, direction, hops, root, parent } = record
  if (forbiddenEdge(source.role, target.role)) return `${source.role} may not send information to ${target.role}`
  if (direction !== directionOf(source.role, target.role)) return `A ${source.role} → ${target.role} message is "${directionOf(source.role, target.role)}", not "${direction}"`
  if (!Number.isInteger(hops) || hops < 0) return 'hops must be a non-negative integer'
  if (parent === undefined && root !== undefined && root !== null && hops !== 0) return 'an origin record has no parent and zero hops'
  return undefined
}
/** Checks a set of records for the invariants issue #13 requires; returns one message per violation. */
export function informationViolations(records: readonly InfoRecord[]): string[] {
  const problems: string[] = []
  const ids = new Map<string, InfoRecord>()
  const dedupes = new Set<string>()
  for (const record of records) {
    if (ids.has(record.id)) problems.push(`duplicate record id ${record.id}`)
    ids.set(record.id, record)
    if (dedupes.has(record.dedupe)) problems.push(`two authoritative sources for ${record.dedupe}`)
    dedupes.add(record.dedupe)
    const problem = informationProblem(record)
    if (problem !== undefined) problems.push(`${record.id}: ${problem}`)
  }
  for (const record of records) {
    if (record.parent === undefined) {
      if (record.root !== record.id) problems.push(`${record.id}: an origin's root is itself`)
      if (record.hops !== 0) problems.push(`${record.id}: an origin has zero hops`)
      continue
    }
    const parent = ids.get(record.parent)
    if (!parent) { problems.push(`${record.id}: its parent ${record.parent} is missing`); continue }
    if (record.root !== parent.root) problems.push(`${record.id}: its root differs from its parent's root`)
    if (record.hops !== parent.hops + 1) problems.push(`${record.id}: its hops are not its parent's plus one`)
    if (parent.direction === 'up' && record.direction === 'down' && record.source.role === parent.source.role) {
      problems.push(`${record.id}: a relay reverses the direction of its parent`)
    }
  }
  return problems
}
