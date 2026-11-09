/**
 * The `session` Source kind: an independent DSH Session submits a request through the ordinary intake with the
 * `superagent_submit` tool, and receives every Decision outcome plus the final Request report in that same Session.
 *
 * A Session is never a person, so its Trigger is `human: false` and the Policy's admission table decides whether it
 * becomes a candidate. The Session's ID is the Channel address, while each tool call gets its own Thread so two
 * independent submissions are never batched into one evaluation.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  key, reasonText, type Decision, type OutboundMessage, type ReceiveResult, type Trigger,
} from '../core/index.ts'
import type { Localized, SourceKind } from './kind.ts'

export const SOURCE = 'session'
/** The global tool an independent Session calls; only registered when the Host exposes the root tools service. */
export const SESSION_TOOL = 'superagent_submit'
/** The admission table row `scope()` reports for every Session submission. */
export const SESSION_ROW = 'workspace'

export const SessionConfigSchema = z.object({}).strict()
export type SessionConfig = z.infer<typeof SessionConfigSchema>

/** Tool arguments; the field descriptions are what the calling Session's model sees. */
export const SessionSubmitSchema = z.object({
  title: z.string().trim().min(1).max(200)
    .describe('A short title for the request, used as the Ticket title.'),
  instruction: z.string().trim().min(1).max(8_000)
    .describe('The complete request: what to do, where, and how to verify it. Include all context the agent needs.'),
  project: z.string().trim().min(1).max(40).optional()
    .describe('Optional registered project ID to route the request to. Omit it to let dsh-superagent-further choose.'),
  session_id: z.string().trim().min(1).max(200).optional()
    .describe('Optional: this Session\'s own ID. When present it must match the calling Session.'),
}).strict()
export type SessionSubmission = z.infer<typeof SessionSubmitSchema>

const SESSION_DESCRIPTION: Localized = {
  zh: '独立的 DSH 会话通过 superagent_submit 提交请求；请求按普通准入成为候选，决定和最终结果回到该会话。',
  en: 'Independent DSH Sessions submit requests through superagent_submit; ordinary admission makes them candidates, and the decision and final result return to that Session.',
}

/** Stable Trigger ID: one tool call is one Trigger, so a retried call with the same call ID is a duplicate. */
export const sessionTriggerId = (sessionId: string, callId: string): string => key(SOURCE, sessionId, callId)

/** The Thread of one submission; the call ID keeps independent submissions out of one evaluation batch. */
export const sessionThread = (sessionId: string, callId: string): string => `${sessionId}:${callId}`

/**
 * Normalizes one tool call into a Trigger. `actor.id` is empty on purpose: a non-empty ID makes the Policy's machine
 * gate look the actor up as a listed bot, while a Session submission is admitted (or not) through the admission table.
 */
export function sessionTrigger(input: SessionSubmission, callId: string, sessionId: string,
  at: string = new Date().toISOString()): Trigger {
  const thread = sessionThread(sessionId, callId)
  const text = [input.title, input.instruction, ...(input.project ? [`Project: ${input.project}`] : [])].join('\n\n')
  return {
    id: sessionTriggerId(sessionId, callId),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: '' },
    human: false,
    at,
    text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { sessionId } },
    meta: { sessionId, title: input.title, callId, ...(input.project ? { project: input.project } : {}) },
  }
}

/** Delivers one Outbox message into the Session; `Sessions.prompt` makes it idempotent by the message ID. */
export type SessionDeliver = (sessionId: string, requestId: string, text: string) => Promise<void>

/**
 * The Source kind. `deliver` is injected because the adapter runs where the Sessions service lives, while the registry
 * and its tests can construct the kind without any Host service.
 */
export function sessionKind(deliver: SessionDeliver): SourceKind<SessionConfig> {
  return {
    kind: SOURCE,
    title: { zh: 'DSH 会话', en: 'DSH Sessions' },
    description: SESSION_DESCRIPTION,
    schema: SessionConfigSchema,
    fields: [],
    health: [],
    scope({ meta }) {
      const sessionId = meta.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return { listened: false, reason: 'session_missing' }
      return { listened: true, observed: true, row: SESSION_ROW }
    },
    channel: {
      allowed(address) { return typeof address.sessionId === 'string' && address.sessionId !== '' },
      async send(_host, message: OutboundMessage) {
        const sessionId = message.channel.address.sessionId
        if (!sessionId) return 'gone'
        try {
          await deliver(sessionId, message.id, message.text)
          return 'sent'
        } catch (error) {
          // A deleted Session cannot receive the notice; any other failure may succeed on a later retry.
          if (isErrorCode(error, 'session/not-found')) return 'gone'
          throw error
        }
      },
      link() { return { url: '', label: { zh: 'DSH 会话', en: 'DSH Session' } } },
    },
    policy: {
      schema: z.object({
        allowed: z.array(z.object({ id: z.string(), name: z.string().optional() }).strict()).default([]),
      }).strict(),
      fields: [],
      explicit: {
        zh: '会话提交永远不会是明确的请求：是否成为候选由策略的准入表决定。',
        en: 'A Session submission is never explicit: the Policy\'s admission table decides whether it becomes a candidate.',
      },
      rows() {
        return [{
          id: SESSION_ROW,
          label: { zh: 'DSH 会话', en: 'DSH Sessions' },
          note: {
            zh: '独立的 DSH 会话通过 superagent_submit 提交。准入设为“推断”时，提交才会成为候选；其他设置会直接忽略提交。',
            en: 'Independent DSH Sessions submit through superagent_submit. A submission becomes a candidate only when admission is inferred; otherwise it is ignored.',
          },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true },
        }]
      },
    },
  }
}

/**
 * The always-reply notice for one Decision that came from a Session Trigger. Accept names the Ticket and promises the
 * result in the same Session; every other outcome explains why no work starts. Mirrors the language rule of the
 * explicit reply: Chinese when the request is Chinese without kana, English otherwise.
 */
export function sessionDecisionText(decision: Decision, trigger: Trigger): string {
  const chinese = /\p{Script=Han}/u.test(trigger.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trigger.text)
  if (decision.kind === 'accept') {
    return chinese
      ? `请求已受理，工单 ${decision.ticketId}（决策 ${decision.id}）。工单结束时会在此会话报告结果。`
      : `Request accepted as ticket ${decision.ticketId} (decision ${decision.id}). The result will be reported in this Session when the ticket ends.`
  }
  const own = decision.reason.filter(reason => reason.triggerId === trigger.id)
  const detail = reasonText(own.length ? own : decision.reason)
  const outcome = decision.kind === 'ignore' ? { zh: '请求未被采纳', en: 'Your request was not taken up' }
    : decision.kind === 'unavailable' ? { zh: '请求暂时无法处理', en: 'Your request could not be processed' }
      : decision.kind === 'stop' ? { zh: '已按请求停止', en: 'The work was stopped as requested' }
        : { zh: `请求已处理（${decision.kind}）`, en: `The request was decided (${decision.kind})` }
  const text = chinese ? outcome.zh : outcome.en
  return `${text}${detail ? (chinese ? '：' : ': ') + detail : ''}${chinese ? '。' : '.'}`
}

/** Everything the tool needs from the Runtime; a small port keeps the tool unit-testable without a Host. */
export interface SessionToolHost {
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  /** Whether the bridge can accept a submission now: configured, not paused or stopping, and the Source enabled. */
  accepting(): { ok: true } | { ok: false; reason: string }
  projects(): readonly { id: string }[]
  /** Master, project Lead and ticket worker Sessions are managed by this plugin and must not submit to it. */
  managed(sessionId: string): boolean
}

const TOOL_DESCRIPTION = [
  'Submit a request to dsh-superagent-further from this independent DSH Session.',
  'It becomes a candidate under the operator\'s Policy; the decision and the final result are delivered to this Session as messages.',
  'Do not use it for work this Session can do itself.',
].join(' ')

/** The globally registered tool; `exec.agent` identifies the calling Session and `exec.callId` makes the Trigger unique. */
export function sessionSubmitTool(host: SessionToolHost): ToolDefinition {
  return {
    name: SESSION_TOOL,
    description: TOOL_DESCRIPTION,
    parameters: z.toJSONSchema(SessionSubmitSchema),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const input = SessionSubmitSchema.parse(args)
      const agent = exec.agent
      if (!agent) throw new Error('superagent_submit only works from a DSH Session.')
      const header = agent.session.header
      if (header?.parentSession !== undefined || header?.origin === 'subagent') {
        throw new Error('A subagent cannot submit a request; ask its parent Session to do it.')
      }
      if (host.managed(agent.id)) {
        throw new Error('This Session is managed by dsh-superagent-further; its work comes from its own tools, not from superagent_submit.')
      }
      const sessionId = input.session_id ?? agent.id
      if (sessionId !== agent.id) throw new Error('session_id must name the calling Session.')
      const accepting = host.accepting()
      if (!accepting.ok) throw new Error(accepting.reason)
      if (input.project && !host.projects().some(project => project.id === input.project)) {
        throw new Error(`Unknown project ${input.project}. Omit project to let dsh-superagent-further choose one.`)
      }
      const trigger = sessionTrigger(input, String(exec.callId), sessionId)
      const state = await host.receive(trigger)
      return { trigger_id: trigger.id, state, title: input.title }
    },
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code
}
