import { ALLOWED_EDGES, directionOf, informationViolations, type InfoRecord, type InformationRole } from '../../src/core/information.ts'

/**
 * The propagation rehearsal (issue #38, docs/016). One fact, one tree: this fixture names the edges the tree must carry,
 * the P1–P12 promises each scenario proves, and the trace checks shared by `tests/propagation.spec.ts` and
 * `scripts/check-propagation.mjs`. The spec runs real Sessions through the runtime; the check script keeps this matrix
 * honest, so a required path cannot disappear without a failing gate.
 */

/** The runtime-recorded edges that must be exercised by the rehearsal, in docs/016 order. */
export interface RequiredEdge {
  readonly id: string
  readonly from: InformationRole
  readonly to: InformationRole
}

/**
 * These are the edges the product writes today: a person may address any handled level, and the levels exchange facts
 * only with an adjacent level. `lead -> person` and the reviewer edges are legal in the model but the runtime sends
 * person replies and review findings outside the information table, so the rehearsal names them in
 * `OUTSIDE_THE_TABLE` instead of pretending a record exists.
 */
export const REQUIRED_EDGES: readonly RequiredEdge[] = [
  { id: 'person-orchestrator', from: 'person', to: 'orchestrator' },
  { id: 'person-lead', from: 'person', to: 'lead' },
  { id: 'person-worker', from: 'person', to: 'worker' },
  { id: 'orchestrator-lead', from: 'orchestrator', to: 'lead' },
  { id: 'lead-orchestrator', from: 'lead', to: 'orchestrator' },
  { id: 'lead-worker', from: 'lead', to: 'worker' },
  { id: 'worker-lead', from: 'worker', to: 'lead' },
]

/** Legal edges the runtime deliberately carries outside the information table; the check script prints them. */
export const OUTSIDE_THE_TABLE: readonly RequiredEdge[] = [
  { id: 'lead-person', from: 'lead', to: 'person' },
  { id: 'lead-reviewer', from: 'lead', to: 'reviewer' },
  { id: 'reviewer-lead', from: 'reviewer', to: 'lead' },
]

export type EdgeId =
  | 'person-orchestrator' | 'person-lead' | 'person-worker' | 'orchestrator-lead' | 'lead-orchestrator'
  | 'lead-worker' | 'worker-lead' | 'lead-person' | 'lead-reviewer' | 'reviewer-lead'

/** One promise from docs/016 and the paths that prove it. */
export interface PropagationScenario {
  /** The docs/016 promise it exercises, P1–P12. */
  readonly id: `P${number}`
  readonly title: string
  /** The information paths this scenario must show at least once. */
  readonly paths: readonly EdgeId[]
  /** Paths that must appear exactly once in the scenario's own records. */
  readonly exactlyOnce?: readonly EdgeId[]
  /** The scenario may not notify the person: progress is not yet knowledge (P11). */
  readonly silentAboutProgress?: boolean
}

export const PROPAGATION_SCENARIOS: readonly PropagationScenario[] = [
  { id: 'P1', title: 'one fact travels only between adjacent levels', paths: ['orchestrator-lead', 'worker-lead'] },
  { id: 'P2', title: 'same-level facts are carried by the common parent', paths: ['lead-worker', 'worker-lead'] },
  { id: 'P3', title: 'no fact skips a level', paths: ['orchestrator-lead', 'worker-lead'] },
  { id: 'P4', title: 'one authoritative source, provenance kept while forwarding', paths: ['worker-lead', 'lead-orchestrator'] },
  { id: 'P5', title: 'one direction per fact, never reversed on the way up', paths: ['worker-lead', 'lead-orchestrator'] },
  { id: 'P6', title: 'two workers reach each other through their Lead only', paths: ['lead-worker'] },
  { id: 'P7', title: 'a must-know fact reaches its parent in the same turn', paths: ['worker-lead', 'lead-orchestrator'] },
  { id: 'P8', title: "a person's direct word is an authoritative one-shot Directive", paths: ['person-orchestrator', 'person-lead', 'person-worker', 'worker-lead', 'lead-orchestrator'] },
  { id: 'P9', title: 'every executor and reviewer reports under the same discipline', paths: ['worker-lead', 'lead-worker'] },
  { id: 'P10', title: 'ordinary requests follow the same tree', paths: ['orchestrator-lead', 'worker-lead'] },
  { id: 'P11', title: 'silence about progress is not knowledge; the person is not notified', paths: [], silentAboutProgress: true },
  { id: 'P12', title: 'every failure has an owner and a path to the top', paths: ['worker-lead'] },
]

/** The edge id of one record, or `undefined` for a pair outside the documented tree. */
export function pathOf(record: Pick<InfoRecord, 'source' | 'target'>): EdgeId | undefined {
  const id = `${record.source.role}-${record.target.role}`
  return [...REQUIRED_EDGES, ...OUTSIDE_THE_TABLE].some(edge => edge.id === id) ? id as EdgeId : undefined
}

/** Counts the documentation paths in one slice of records; records outside the named edges are ignored. */
export function recordPaths(records: readonly InfoRecord[]): Map<EdgeId, number> {
  const counts = new Map<EdgeId, number>()
  for (const record of records) {
    const id = pathOf(record)
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/** Checks the shared invariants over the whole run: legal edges, directions, roots, hops and no duplicate fact. */
export function traceProblems(records: readonly InfoRecord[]): string[] {
  return informationViolations(records)
}

/**
 * Checks one scenario against the records it produced. `all` is the whole run, used for the tree invariants; `records`
 * is the scenario's own slice, used for the path promises.
 */
export function scenarioProblems(all: readonly InfoRecord[], records: readonly InfoRecord[], scenario: PropagationScenario): string[] {
  const problems = traceProblems(all)
  const counts = recordPaths(records)
  for (const path of scenario.paths) {
    if ((counts.get(path) ?? 0) === 0) problems.push(`${scenario.id} missed ${path}`)
  }
  for (const path of scenario.exactlyOnce ?? []) {
    const count = counts.get(path) ?? 0
    if (count !== 1) problems.push(`${scenario.id} expected exactly one ${path}, saw ${count}`)
  }
  if (scenario.silentAboutProgress && records.some(record => record.target.role === 'person')) {
    problems.push(`${scenario.id} notified the person about progress`)
  }
  // A fact that skips a level is illegal by construction; an adjacent-only tree never has one, but a trace check that
  // silently ignored it would be blind to a future `information` write that bypassed the model.
  if (records.some(record => forbiddenPair(record.source.role, record.target.role))) {
    problems.push(`${scenario.id} produced a forbidden edge`)
  }
  return problems
}

/** The pairs docs/016 forbids, independent of the allowed list, so a widened model cannot hide a skip. */
export function forbiddenPair(from: InformationRole, to: InformationRole): boolean {
  return (from === 'orchestrator' && to === 'worker')
    || (from === 'worker' && to === 'orchestrator')
    || (from === 'orchestrator' && to === 'reviewer')
    || (from === 'reviewer' && to === 'orchestrator')
    || (from === 'person' && (to === 'reviewer' || to === 'person'))
    || (from === 'worker' && to === 'worker')
    || (from === 'lead' && to === 'lead')
}

/** A short human-readable trace for the test output and the CI drill. */
export function traceReport(all: readonly InfoRecord[], records: readonly InfoRecord[], scenario: PropagationScenario): string {
  const counts = [...recordPaths(records)].map(([path, count]) => `${path}×${count}`).join(' ') || 'no recorded paths'
  return `${scenario.id} ${scenario.title}: ${counts}; ${all.length} facts, ${traceProblems(all).length} trace problems`
}

/** The direction a pair must carry, re-exported so the fixture and the check script read one source of truth. */
export const requiredDirection = directionOf

/** Whether the rehearsal covers every required edge at least once (the check script's main assertion). */
export function uncoveredEdges(scenarios: readonly PropagationScenario[] = PROPAGATION_SCENARIOS): string[] {
  return REQUIRED_EDGES.filter(edge => !scenarios.some(scenario => scenario.paths.includes(edge.id as EdgeId))).map(edge => edge.id)
}

/** Whether every declared path is legal in the model. */
export function illegalPaths(scenarios: readonly PropagationScenario[] = PROPAGATION_SCENARIOS): string[] {
  const legal = new Set(ALLOWED_EDGES.map(([from, to]) => `${from}-${to}`))
  return scenarios.flatMap(scenario => scenario.paths.filter(path => !legal.has(path)).map(path => `${scenario.id} names ${path}`))
}
