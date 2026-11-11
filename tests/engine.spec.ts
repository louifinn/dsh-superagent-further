import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Engine, MemoryRepositories, ProjectRequestError, key } from '../src/core/index.ts'
import type { Assessor, Candidate, DomainEvent, EngineOptions, Executor, OutboundMessage, Outbox, Outcome, Policy, SourceScope, Trigger }
  from '../src/core/index.ts'
import { Replies } from '../src/core/replies.ts'
import { Store } from '../src/app/store.ts'

const member = { source: 'chat', id: 'alice' }
const guest = { source: 'chat', id: 'guest' }
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true,
    at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}

/**
 * An Engine over an in-memory repository whose Policy admits `alice`'s addressed messages explicitly, her other messages
 * as `listed`, and a subscribed thread as `followup`; the test drives evals by hand, like the main Session and assessor do.
 */
function harness(overrides: Partial<Policy> = {}) {
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) } }
  const executor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }
  let version = 'v1'
  const policy: Policy = {
    get version() { return version }, paused: false, evalTimeoutMs: 60_000,
    gate: (item, thread) => !item.human ? { admissible: false, reason: 'not human' }
      : item.actor.id === 'alice' && item.addressed ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: item.addressed } }
        : item.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
          : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
            : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked', admitsInferred: () => true, ...overrides,
  }
  let clock = 0
  const scope: SourceScope = { scope: () => ({ listened: true, observed: false }) }
  const queued: Outbox = {
    send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: () => {},
  }
  const options: EngineOptions = { repo, scope, policy: () => policy, assessor, executor, outbox: queued,
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() }
  const engine = new Engine(options)
  /** Take a Trigger in and run the Eval its Thread starts, as the Runtime's passes do. */
  const start = (item: Trigger) => { engine.receive(item); engine.evaluateDue() }
  const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  return { repo, engine, options, outbox, requests, start, decide,
    setVersion: (value: string) => { version = value }, tick: (seconds: number) => { clock += seconds } }
}

it('answers a whitelisted mention it ignores with one notice on the same Channel', () => {
  const h = harness()
  h.start(trigger('1', { addressed: 'mention' }))
  const decision = h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
  expect(decision.kind).toBe('ignore')
  expect(h.outbox).toEqual([{ id: key('explicit-reply', decision.id, '1'), channel: trigger('1').channel,
    text: 'Your request was not taken up: chatter.', kind: 'notice' }])
})

it('writes the answer in the language of the person\'s message', () => {
  const h = harness()
  h.start(trigger('1', { addressed: 'direct', text: '请帮我看看这个页面' }))
  h.decide(h.requests[0]!, { kind: 'ignore', reason: '只是聊天' })
  expect(h.outbox.map(message => message.text)).toEqual(['你的请求未被采纳：只是聊天。'])
})

it('sends the explicit answer once, however often the Decision is replayed', () => {
  const h = harness()
  h.start(trigger('1', { addressed: 'mention' }))
  const decision = h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
  new Replies(h.options).answerExplicit(decision)
  expect(h.outbox).toHaveLength(1)
})

it('keeps the answer the main Session already sent instead of repeating the outcome', () => {
  const h = harness()
  h.start(trigger('1', { addressed: 'direct' }))
  h.engine.reply({ purpose: 'answer', triggerId: '1', text: 'the ticket list' })
  expect(h.outbox.map(message => message.kind)).toEqual(['reply'])
  h.decide(h.requests[0]!, { kind: 'ignore', reason: 'answered directly' })
  // The person already has the answer to this message, so the Decision adds no second message.
  expect(h.outbox.map(message => message.kind)).toEqual(['reply'])
})

it('writes one full stop when the recorded reason already ends with one', () => {
  const h = harness()
  h.start(trigger('1', { addressed: 'direct', text: '请检查工单' }))
  h.decide(h.requests[0]!, { kind: 'ignore', reason: '无需创建工单。' })
  expect(h.outbox.map(message => message.text)).toEqual(['你的请求未被采纳：无需创建工单。'])
})

it('answers an unavailable decision and a stop on an explicit message', () => {
  const unavailable = harness()
  unavailable.start(trigger('1', { addressed: 'direct' }))
  unavailable.setVersion('revoked')
  const decision = unavailable.decide(unavailable.requests[0]!, { kind: 'ignore', reason: 'chatter' })
  expect(decision.kind).toBe('unavailable')
  expect(unavailable.outbox.map(message => message.text)).toEqual(['Your request could not be processed: Policy changed during assessment.'])

  const stopped = harness()
  stopped.start(trigger('1', { addressed: 'mention' }))
  const accepted = stopped.decide(stopped.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
  stopped.outbox.length = 0
  stopped.start(trigger('2', { addressed: 'direct', text: '停一下，别做了' }))
  const stop = stopped.engine.decide('2', { kind: 'stop', ticketId: accepted.ticketId!, reason: 'asked to stop' })
  expect(stop.kind).toBe('stop')
  expect(stopped.outbox).toEqual([{ id: key('explicit-reply', stop.id, '2'), channel: trigger('2').channel,
    text: '已按你的请求停止：asked to stop。', kind: 'notice' }])
})

it('answers nothing when the message is not addressed, the sender is not listed, or the request was accepted', () => {
  const inferred = harness()
  inferred.start(trigger('1'))
  inferred.decide(inferred.requests[0]!, { kind: 'ignore', reason: 'chatter' })
  expect(inferred.outbox).toEqual([])

  const stranger = harness()
  stranger.start(trigger('1', { actor: guest, addressed: 'mention' }))
  expect(stranger.requests).toEqual([])
  expect(stranger.outbox).toEqual([])

  const accepted = harness()
  accepted.start(trigger('1', { addressed: 'mention' }))
  accepted.decide(accepted.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })
  expect(accepted.outbox.map(message => message.kind)).toEqual(['acknowledgement'])
})

it('answers nothing when the explicit message has no Channel', () => {
  const h = harness()
  h.start(trigger('1', { addressed: 'mention', channel: undefined }))
  h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
  expect(h.outbox).toEqual([])
})

const quiet: Policy = {
  version: 'v1', paused: false, evalTimeoutMs: 60_000,
  gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }),
  revalidate: () => true, admitsInferred: () => true,
}
const silent: Outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
const idle: Assessor = { request: () => {} }
const noExecutor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-engine-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('announces a completed project request once so the runtime can report its chain', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const events: DomainEvent[] = []
  const scope: SourceScope = { scope: () => ({ listened: true, observed: false }) }
  const engine = new Engine({ repo: store, scope, policy: () => quiet, assessor: idle, executor: noExecutor, outbox: silent,
    emit: event => { events.push(event) } })
  const root = engine.raiseProjectRequest({ project: 'app', title: 'Add a status page', instruction: 'Build it.',
    raised_by: { session: 'lead-app' }, root: { trigger_id: 'trigger-1', thread_key: 'chat:t1' } })
  engine.disposeProjectRequest(root.id, { by: 'lead-app', action: 'accept', text: 'Accepted' })
  const completed = engine.completeProjectRequest(root.id, { by: 'lead-app', text: 'The page is live' })
  expect(events.filter(event => event.type === 'project-request.completed')).toEqual([
    { type: 'project-request.completed', at: completed.completed_at, data: { projectRequestId: completed.id } },
  ])
  expect(() => engine.completeProjectRequest(root.id, { by: 'lead-app', text: 'Again' })).toThrow(ProjectRequestError)
  expect(events.filter(event => event.type === 'project-request.completed')).toHaveLength(1)
  store.close()
})
