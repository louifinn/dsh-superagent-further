/**
 * Property tests for invariants that must hold for every input, not only the examples a unit test names.
 *
 * A small deterministic PRNG drives each generator, so a failure reproduces from its seed printed in the message. The groups
 * cover the decisions made at the module boundaries: the Policy gate, Trigger identity and intake deduplication, idempotent
 * creates, the schema migrations that must change nothing else, and reconcile being a fixed point.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Automations } from '../src/app/automations.ts'
import { migrateTo22 } from '../src/app/migration.ts'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { Engine, MemoryRepositories, key } from '../src/core/index.ts'
import type { Assessor, Executor, Outcome, Policy, ProjectRequest, Trigger } from '../src/core/index.ts'
import { assessmentOutcome, DEFAULT_RULES, type AdmissionDirection, type Assessment } from '../src/policy.ts'
import { branchCiTrigger, ciTrigger, issueTrigger, pullTrigger } from '../src/sources/github-trigger.ts'

/** A tiny deterministic PRNG: same seed, same sequence on every platform. */
function rng(seed: number) {
  let state = seed >>> 0
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    bool: (chance = 0.5) => next() < chance,
    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items]
      for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!] }
      return copy
    },
  }
}
const SEEDS = [1, 2, 3, 4, 5]

const direction = (r: ReturnType<typeof rng>) => ({
  implementation_requested: r.bool(0.9),
  target_basis: r.pick(['specified', 'existing-standard', 'undetermined'] as const),
  requires_design_decision: r.bool(0.2),
  evidence: 'the request names the target',
})

describe('Policy gate', () => {
  it('accepts only settled, evidenced, matched requests, and observes inferred candidates outside auto', () => {
    for (const seed of SEEDS) {
      const r = rng(seed)
      for (let iteration = 0; iteration < 40; iteration++) {
        const rules = r.shuffle(DEFAULT_RULES).slice(0, r.int(1, DEFAULT_RULES.length)).map(rule => ({ ...rule, enabled: r.bool(0.6) }))
        const enabled = rules.filter(rule => rule.enabled)
        const assessments = enabled.map(rule => ({ rule_id: rule.id, matched: r.bool(0.4), reason: 'matches' }))
        const assessment: Assessment = {
          decision: r.pick(['accept', 'ignore', 'unavailable'] as const),
          rule_assessments: assessments,
          direction: direction(r),
          title: 'Do the thing',
          scope: 'small',
          reason: 'requested',
          intent_evidence: r.bool(0.6) ? 'the person asked for it' : undefined,
        }
        const settings = { policy: { rules, sources: {} }, eval: { mode: r.pick(['off', 'observe', 'auto'] as const) } }
        const strength = r.pick(['explicit', 'inferred'] as const)
        const matched = assessments.filter(item => item.matched).length
        const bounded = assessment.direction as AdmissionDirection
        const settled = bounded.implementation_requested && bounded.target_basis !== 'undetermined' && !bounded.requires_design_decision
        let outcome: Outcome
        try { outcome = assessmentOutcome(assessment, settings as never, strength) as Outcome } catch {
          // The documented refusal for an accept that names matched rules but no intent evidence.
          expect(matched, `seed ${seed}`).toBeGreaterThan(0)
          expect(settled && !assessment.intent_evidence, `seed ${seed}`).toBe(true)
          continue
        }
        if (outcome.kind === 'accept') {
          expect(matched, `seed ${seed}`).toBeGreaterThan(0)
          expect(settled, `seed ${seed}`).toBe(true)
          expect(assessment.intent_evidence, `seed ${seed}`).toBeTruthy()
          expect(strength === 'inferred' && settings.eval.mode !== 'auto', `seed ${seed}`).toBe(false)
        } else if (outcome.kind === 'ignore' && typeof outcome.reason !== 'string' && outcome.reason.code === 'noRuleMatched') {
          expect(matched, `seed ${seed}`).toBe(0)
        } else if (outcome.kind === 'ignore' && typeof outcome.reason !== 'string' && outcome.reason.code === 'observed') {
          expect(strength, `seed ${seed}`).toBe('inferred')
          expect(settings.eval.mode, `seed ${seed}`).not.toBe('auto')
          expect((outcome.audit as { would_accept?: boolean } | undefined)?.would_accept, `seed ${seed}`).toBe(true)
        }
      }
    }
  })
})

const opened = (number: number, login = 'person') => ({
  number, html_url: `https://github.com/acme/widgets/pull/${number}`, title: `Change ${number}`, body: 'body',
  user: { login }, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', state: 'open',
}) as never

describe('Trigger identity', () => {
  it('scopes issue and pull IDs by repository, keeping the deployment repository on its legacy ID', () => {
    for (const seed of SEEDS) {
      const r = rng(seed)
      for (let iteration = 0; iteration < 40; iteration++) {
        const primary = 'acme/widgets'
        const repository = r.bool() ? primary : `acme/repo-${r.int(1, 3)}`
        const number = r.int(1, 20)
        const issue = issueTrigger(opened(number), 'agent', repository, primary)
        const expected = repository === primary ? key('github-issue', String(number)) : key('github-issue', repository, String(number))
        expect(issue.id, `seed ${seed} repo ${repository}`).toBe(expected)
        // The same number in another repository can never share the ID.
        const other = issueTrigger(opened(number), 'agent', 'acme/other', primary)
        expect(other.id, `seed ${seed}`).not.toBe(issue.id)
        expect(pullTrigger(opened(number), 'agent', repository, primary).id).toBe(expected.replace('github-issue', 'github-pull'))
      }
    }
  })

  it('scopes CI IDs by repository while the branch and revision still distinguish runs', () => {
    for (const seed of SEEDS) {
      const r = rng(seed)
      for (let iteration = 0; iteration < 30; iteration++) {
        const branch = `branch-${r.int(1, 3)}`
        const revision = r.int(1, 5)
        const primary = 'acme/widgets'
        const project = branchCiTrigger(branch, 'sha', revision, 'summary', 'url', 'acme/other', primary)
        const deployment = branchCiTrigger(branch, 'sha', revision, 'summary', 'url', primary, primary)
        expect(project.id).toBe(key('github-ci', 'acme/other', `branch:${branch}`, String(revision)))
        expect(deployment.id).toBe(key('github-ci', `branch:${branch}`, String(revision)))
        expect(project.id).not.toBe(deployment.id)
        expect(branchCiTrigger(branch, 'sha', revision, 'summary', 'url', primary, primary).id).toBe(deployment.id)
        expect(branchCiTrigger(branch, 'sha', revision + 1, 'summary', 'url', primary, primary).id).not.toBe(deployment.id)
        expect(ciTrigger({ number: 1, html_url: 'url', user: { login: 'p' } }, revision, 's', 'acme/other', primary).id)
          .not.toBe(ciTrigger({ number: 1, html_url: 'url', user: { login: 'p' } }, revision, 's', primary, primary).id)
      }
    }
  })
})

/** A minimal Engine whose Policy admits every explicit trigger and whose executor never runs. */
function engine() {
  const repo = new MemoryRepositories()
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true, admitsInferred: () => true }
  let clock = 0
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy,
    assessor: { request: vi.fn(), release: vi.fn() } as Assessor,
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() } as Executor,
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, clock++)).toISOString() })
  return { engine, repo }
}
const incoming = (id: string): Trigger => ({ id, source: 'chat', threads: [{ source: 'chat', id: 't1' }],
  actor: { source: 'chat', id: 'alice' }, human: true, at: '2026-11-01T00:00:00Z', text: `message ${id}`,
  channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {} })

describe('Idempotent intake and creates', () => {
  it('stores each Trigger once and reports every repetition as a duplicate', () => {
    for (const seed of SEEDS) {
      const r = rng(seed)
      const { engine: machine, repo } = engine()
      const ids = Array.from({ length: 25 }, () => `trigger-${r.int(1, 8)}`)
      const first = ids.map(id => machine.receive(incoming(id)))
      for (const [index, id] of ids.entries()) {
        if (ids.indexOf(id) === index) expect(first[index], `seed ${seed} ${id}`).toBe('stored')
        else expect(first[index], `seed ${seed} ${id}`).toBe('duplicate')
      }
      for (const id of new Set(ids)) expect(repo.triggers.get(id), `seed ${seed} ${id}`).toBeDefined()
    }
  })

  it('returns the open request when a Lead raises the same title twice, and a new one for a new title', () => {
    for (const seed of SEEDS) {
      const r = rng(seed)
      const { engine: machine } = engine()
      const raise = (title: string) => machine.raiseProjectRequest({ project: 'app', kind: 'work', title, instruction: 'do it',
        raised_by: { session: 'lead-app' } })
      const titles = Array.from({ length: 6 }, () => `Title ${r.int(1, 3)}`)
      const requests: ProjectRequest[] = titles.map(title => raise(title))
      for (const [index, request] of requests.entries()) {
        const same = requests.find((item, at) => titles[at] === titles[index] && at < index)
        if (same) expect(request.id, `seed ${seed} ${titles[index]}`).toBe(same.id)
      }
      expect(new Set(requests.map(request => request.id)).size).toBe(new Set(titles).size)
      expect(machine.listProjectRequests({ project: 'app' }).length).toBe(new Set(titles).size)
    }
  })
})

describe('Schema migration', () => {
  let directory: string | undefined
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

  it('writes every schema 21 Ticket a deliverable contract and changes nothing else', () => {
    for (const seed of SEEDS) {
      const r = rng(seed)
      directory = mkdtempSync(join(tmpdir(), 'orchestrator-property-'))
      const path = join(directory, 'db.sqlite')
      const seeded = new Store(path)
      const tickets = Array.from({ length: 8 }, (_, index) => {
        const open = r.bool(0.4)
        const followThread = `pull-${index}`
        const followed = !open && r.bool(0.5)
        const ticket = {
          id: `t${index}`, title: `Ticket ${index}`, decisionId: `d${index}`,
          mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'chat', id: 'alice' }, scope: 'small' },
          channels: [], assignments: [], inputs: [], undelivered: [],
          createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', origin: { source: 'chat', thread: 't1' },
          ...(open ? {} : { ended: { at: '2026-11-02T00:00:00Z', outcome: r.pick(['completed', 'merged', 'closed'] as const), by: 'person' } }),
          ...(followed ? { follows: [{ source: 'github', id: followThread, thread: `github:${followThread}` }] } : {}),
        }
        seeded.tickets.save(ticket as never)
        // A pull request Thread is recognised by its recorded Trigger's isPr metadata.
        seeded.triggers.save({ id: `tr-${index}`, source: 'github', threads: [{ source: 'github', id: followThread }],
          meta: { isPr: 1 }, actor: { source: 'github', id: 'person' }, human: true,
          at: '2026-11-01T00:00:00Z', text: '', channel: { source: 'github', thread: `github:${followThread}`, address: {} } } as never)
        return { ...ticket, expected: open ? 'change' : followed ? 'change' : 'answer' }
      })
      seeded.db.prepare("UPDATE kv SET value=? WHERE key='schema'").run(String(21))
      seeded.close()
      const store = new Store(path)
      try {
        const migrated = Object.fromEntries(store.tickets.list().map(ticket => [ticket.id, ticket as unknown as Record<string, unknown>]))
        expect(Number(store.get('schema'))).toBe(SCHEMA_VERSION)
        for (const ticket of tickets) {
          const record = migrated[ticket.id]!
          expect(record.deliverable, `seed ${seed} ${ticket.id}`).toBe(ticket.expected)
          // Every other field survives unchanged; only deliverable is written.
          const { deliverable: _deliverable, ...rest } = record
          const { expected: _expected, ...seedTicket } = ticket
          expect(rest, `seed ${seed} ${ticket.id}`).toMatchObject(seedTicket as never)
        }
        const before = JSON.stringify(store.tickets.list())
        migrateTo22(store)
        expect(JSON.stringify(store.tickets.list())).toBe(before)
      } finally { store.close() }
    }
  })
})

describe('Reconcile', () => {
  it('is a fixed point: a second reconcile changes no record', async () => {
    for (const seed of SEEDS) {
      const r = rng(seed)
      const store = new Store(':memory:')
      const task = { id: 'schedule-1', title: 'Nightly review', prompt: '[AUTOMATION auto-1 · installation] review', status: 'active' as const,
        scheduledAt: `2026-11-${String(r.int(1, 9)).padStart(2, '0')}T00:00:00Z`, updatedAt: '2026-11-01T00:00:00Z' }
      // The Host task the catalog reports, fixed before the loop so both reconciles see the same external state.
      const hostTask = { ...task, scheduledAt: `2026-11-${String(r.int(10, 20)).padStart(2, '0')}T00:00:00Z` }
      const schedule = {
        create: vi.fn(async () => task), list: vi.fn(async () => ({ items: [task], shown: 1, total: 1, limit: 50, offset: 0 })),
        catalog: vi.fn(async () => [hostTask]),
        view: vi.fn(async () => task), history: vi.fn(async () => ({ records: [] })), edit: vi.fn(async () => task), run: vi.fn(async () => task),
        deleteInactive: vi.fn(async () => ({ deleted: 0 })),
      }
      const automations = new Automations({ schedule, store: store.automations, masterId: 'main',
        now: () => new Date('2026-11-01T00:00:00Z'), projects: () => [], project: () => undefined, lead: async () => 'lead-x' })
      await automations.create({ title: 'Nightly review', instruction: 'review', rrule: 'RRULE:FREQ=DAILY' }, 'person')
      try {
        await automations.reconcile()
        const settled = JSON.stringify(store.automations.records())
        await automations.reconcile()
        expect(JSON.stringify(store.automations.records()), `seed ${seed}`).toBe(settled)
      } finally { store.close() }
    }
  })
})
