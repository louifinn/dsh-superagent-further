#!/usr/bin/env node
/**
 * The propagation gate (issue #38, docs/016): proves the rehearsal matrix still covers every required path and edge.
 *
 * `pnpm test` runs `tests/propagation.spec.ts` against real Sessions; this script guards the matrix itself, so deleting a
 * scenario, a required edge or a forbidden pair from the rehearsal cannot pass CI silently. It also prints the edge
 * inventory the test traces, which makes the gate useful as a drill outside CI.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ALLOWED_EDGES, directionOf, forbiddenEdge, informationProblem } from '../src/core/information.ts'
import {
  OUTSIDE_THE_TABLE, PROPAGATION_SCENARIOS, REQUIRED_EDGES, forbiddenPair, illegalPaths, uncoveredEdges,
} from '../tests/fixtures/propagation.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (message) => failures.push(message)

const PROMISES = Array.from({ length: 12 }, (_, index) => `P${index + 1}`)
const ids = PROPAGATION_SCENARIOS.map(scenario => scenario.id)
for (const promise of PROMISES) {
  const count = ids.filter(id => id === promise).length
  if (count !== 1) fail(`${promise} is declared ${count} times; every docs/016 promise must be rehearsed exactly once`)
}
for (const id of ids) if (!PROMISES.includes(id)) fail(`${id} is not a docs/016 promise`)

for (const scenario of PROPAGATION_SCENARIOS) {
  if (scenario.title.trim() === '') fail(`${scenario.id} has no title`)
  // P11 proves a fact that legitimately stays internal, so it is the one scenario with no required path.
  if (scenario.id !== 'P11' && scenario.paths.length === 0) fail(`${scenario.id} declares no path`)
}

const uncovered = uncoveredEdges()
for (const edge of uncovered) fail(`required edge ${edge} is not exercised by any scenario`)
for (const illegal of illegalPaths()) fail(`scenario names an edge the model forbids or does not know: ${illegal}`)

const legal = new Set(ALLOWED_EDGES.map(([from, to]) => `${from}-${to}`))
for (const edge of REQUIRED_EDGES) {
  if (!legal.has(edge.id)) fail(`required edge ${edge.id} is not allowed by the information model`)
  const direction = directionOf(edge.from, edge.to)
  const problem = informationProblem({ source: { role: edge.from }, target: { role: edge.to }, direction, hops: 0, root: 'rehearsal' })
  if (problem !== undefined) fail(`required edge ${edge.id} does not form a valid record: ${problem}`)
}

// The required plus off-table edges must partition the model exactly: a new legal edge without a decision fails the gate.
const named = new Set([...REQUIRED_EDGES, ...OUTSIDE_THE_TABLE].map(edge => edge.id))
for (const [from, to] of ALLOWED_EDGES) {
  const id = `${from}-${to}`
  if (!named.has(id)) fail(`the model allows ${id} but the rehearsal neither requires nor explains it`)
}
for (const edge of [...REQUIRED_EDGES, ...OUTSIDE_THE_TABLE]) {
  if (!legal.has(edge.id)) fail(`${edge.id} is named by the rehearsal but the model forbids it`)
  if (OUTSIDE_THE_TABLE.some(entry => entry.id === edge.id) && REQUIRED_EDGES.some(entry => entry.id === edge.id)) {
    fail(`${edge.id} is both required and off-table`)
  }
}

// The pairs docs/016 forbids must be refused by the model, and the rehearsal's independent list must agree.
const FORBIDDEN = [
  ['orchestrator', 'worker'], ['worker', 'orchestrator'], ['orchestrator', 'reviewer'], ['reviewer', 'orchestrator'],
  ['person', 'reviewer'], ['worker', 'worker'], ['lead', 'lead'],
]
for (const [from, to] of FORBIDDEN) {
  if (!forbiddenEdge(from, to)) fail(`the model allows ${from} → ${to}, which docs/016 forbids`)
  if (!forbiddenPair(from, to)) fail(`the rehearsal does not list ${from} → ${to} as forbidden`)
  const problem = informationProblem({ source: { role: from }, target: { role: to }, direction: directionOf(from, to), hops: 0, root: 'rehearsal' })
  if (problem === undefined) fail(`a ${from} → ${to} record was accepted`)
}

// Every promise the matrix declares must be named by the spec, so a scenario cannot rot into documentation only.
const spec = await readFile(join(root, 'tests/propagation.spec.ts'), 'utf8')
for (const promise of PROMISES) {
  if (!spec.includes(`scenario('${promise}')`)) fail(`tests/propagation.spec.ts never asserts ${promise}`)
}

const pathCount = PROPAGATION_SCENARIOS.reduce((total, scenario) => total + scenario.paths.length, 0)
if (failures.length > 0) {
  console.error(`propagation check failed (${failures.length}):`)
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}

console.info(`propagation check: ${REQUIRED_EDGES.length} required edges, ${OUTSIDE_THE_TABLE.length} off-table edges, `
  + `${PROPAGATION_SCENARIOS.length} promises (P1–P12), ${pathCount} required paths, 0 forbidden pairs accepted.`)
for (const scenario of PROPAGATION_SCENARIOS) {
  console.info(`  ${scenario.id} ${scenario.title}${scenario.paths.length === 0 ? ' (internal only)' : `: ${scenario.paths.join(', ')}`}`)
}
