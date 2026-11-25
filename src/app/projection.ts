import type { RoleId } from './surfaces.ts'

/**
 * One pure, total function that decides how much of a model-facing text a surface inlines (docs/015 D2). Every field the
 * runtime delivers to a model names a {@link FieldKey}; the policy table maps that key to a closed policy, the character
 * width it may inline and the transformation display fields use. Call sites never slice model-facing text themselves, so a
 * field cannot silently lose content: a cut field always records its full length and, when the text is followable, the
 * resource pointer that reveals the rest.
 */
export const PROJECTION_POLICIES = ['inline', 'near', 'far', 'stub', 'pointer'] as const
export type ProjectionPolicy = typeof PROJECTION_POLICIES[number]

/** The closed set of model-facing fields that carry bounded text; each is one row of the generated context policy page. */
export const FIELD_KEYS = ['assessment.trigger', 'assessment.near', 'assessment.window', 'assessment.stub', 'card.trigger',
  'card.ticket', 'card.input', 'card.report', 'card.error', 'card.transcript', 'notice.summary', 'lead.fact', 'fact.pending', 'worker.prompt', 'worker.trigger', 'worker.assignment',
  'worker.input', 'worker.nudge', 'notice.request', 'diagnosis.rootCause'] as const
export type FieldKey = typeof FIELD_KEYS[number]

/** How a field renders text shorter than its width: as written, collapsed to one line, or with an ellipsis when cut. */
export const PROJECTION_STYLES = ['plain', 'collapse', 'ellipsis'] as const
export type ProjectionStyle = typeof PROJECTION_STYLES[number]

/** The resource a truncated field points a reader at, in the form `read` accepts (for example `ticket/<id>`). */
export type ProjectionReference = { resource: string; id: string }

/** A field descriptor: the policy key and, for a followable field, the resource its `read` pointer names. */
export interface Field {
  readonly key: FieldKey
  readonly resource?: string
  readonly id?: string
}

export interface Projection {
  /** What the model sees in place of the field. */
  readonly inline: string
  /** The full length when the field was cut, so a reader knows how much it did not see. */
  readonly chars?: number
  /** The resource that reveals the rest, when the policy lets a reader follow the cut text. */
  readonly read?: string
}

interface Rule {
  readonly policy: ProjectionPolicy
  /** The field's inline width; `inline` and `pointer` ignore it. */
  readonly width?: number
  readonly style?: ProjectionStyle
  /** The resource the field points at when the text is cut; absent means the field is not followable. */
  readonly resource?: string
  /** Why the width and policy exist, rendered into docs/context-policy.md next to the row. */
  readonly reason?: string
}

const rule = (policy: ProjectionPolicy, width: number, style: ProjectionStyle, reason: string, resource?: string): Rule =>
  ({ policy, width, style, reason, ...resource === undefined ? {} : { resource } })

/**
 * The policy table: the runtime's existing truncation behaviour, moved here unchanged (docs/015 D2). Widths are inline
 * characters; a call site with a followable resource names it below so the returned `read` pointer is derivable alone.
 */
export const PROJECTION_POLICY: Readonly<Record<FieldKey, Rule>> = {
  'assessment.trigger': rule('inline', 4000, 'ellipsis', 'The trigger that opened an Eval is read whole, or cut at its bound.'),
  'assessment.near': rule('near', 1200, 'ellipsis', 'The two messages nearest the trigger in the first thread window.'),
  'assessment.window': rule('far', 400, 'ellipsis', 'Other messages of the first thread window; the rest is read with orchestrator_eval_read.'),
  'assessment.stub': rule('stub', 50, 'collapse', 'A one-line preview of a message the window did not load.'),
  'card.trigger': rule('stub', 160, 'collapse', 'The trigger preview in a Ticket or Request card.', 'trigger'),
  'card.ticket': rule('stub', 80, 'collapse', 'A Ticket preview in a card or link list.'),
  'card.input': rule('stub', 80, 'collapse', 'The Input preview in a delivery: the old INPUT_TEXT width.'),
  'card.report': rule('stub', 100, 'collapse', 'The latest report summary in a Ticket card.'),
  'card.error': rule('stub', 160, 'collapse', 'A source or thread error preview shown on a card.'),
  'notice.summary': rule('far', 600, 'plain', 'A result summary in a notice, cut with its length kept.'),
  'lead.fact': rule('far', 1200, 'plain', 'The Input body the Lead receives with a fact request.'),
  'fact.pending': rule('stub', 200, 'collapse', 'The one-line Input preview in a fact-pending notice.'),
  'worker.trigger': rule('far', 600, 'ellipsis', 'The source Trigger a worker receives with its first assignment message.', 'trigger'),
  'worker.assignment': rule('far', 1500, 'ellipsis', 'The assignment text in a worker delivery or activation.', 'ticket'),
  'worker.input': rule('far', 1500, 'ellipsis', 'An Input carried to a running worker.', 'ticket'),
  'worker.prompt': rule('pointer', 0, 'plain', 'A worker prompt always arrives whole; the pointer is the Ticket.'),
  'worker.nudge': rule('stub', 200, 'collapse', 'The error text quoted in a passing-failure nudge.'),
  'notice.request': rule('stub', 200, 'collapse', 'The Request title quoted in its ending notice.'),
  'card.transcript': rule('stub', 80, 'collapse', 'One transcript message preview.'),
  'diagnosis.rootCause': rule('inline', 4000, 'plain', 'The incident diagnosis model reads the root cause whole.')
}

/** Names a model-facing field with the resource that reveals it, so {@link project} can derive the read pointer alone. */
export function field(key: FieldKey, reference?: ProjectionReference): Field {
  return { key, ...(reference === undefined ? {} : { resource: reference.resource, id: reference.id }) }
}

const pointer = (target: Field): string | undefined => {
  if (target.resource === undefined || target.id === undefined) return undefined
  return `${target.resource}/${target.id}`
}

/**
 * Projects one model-facing text under its field's policy. Pure and total: the same `(field, text)` always produces the
 * same projection, the original length survives a cut, and a followable field names the resource that reveals the rest.
 */
export function project(target: Field, text: string): Projection {
  const entry = PROJECTION_POLICY[target.key]
  const width = entry.width ?? 0
  const read = pointer(target) ?? (entry.resource === undefined || target.id === undefined ? undefined : `${entry.resource}/${target.id}`)
  if (entry.policy === 'pointer') return { inline: '', chars: text.length, ...read === undefined ? {} : { read } }
  // A preview style normalizes whitespace whether or not the text is cut, as the preview it replaced did.
  const source = entry.style === 'collapse' ? text.replace(/\s+/g, ' ') : text
  // Text within the field's width is inlined whole: a read pointer would ask a model to fetch what it already has.
  if (text.length <= width) return { inline: source }
  const inline = entry.style === 'ellipsis' ? `${source.slice(0, width)}…` : source.slice(0, width)
  return { inline, chars: text.length, ...read === undefined ? {} : { read } }
}

/** The surface ids a policy applies to; today one project-wide policy serves every registered surface. */
export const POLICY_SURFACES = ['orchestrator', 'worker', 'lead', 'reviewer'] as const satisfies readonly RoleId[]
