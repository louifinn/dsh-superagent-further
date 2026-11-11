/**
 * The operator drill runs the whole update pipeline against a throwaway state directory: the built bundle is staged, then the
 * supervisor's state machine is exercised through apply, rollback, crash recovery at every journal phase, a corrupt staged
 * entry, a request storm, a schema downgrade and a failed init. The assertion here is the report shape and that no scenario
 * fails, since the drill itself is the operator-facing evidence.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error - the drill harness is a plain .mjs script without a TypeScript declaration on purpose.
import { runDrill } from '../scripts/drill.mjs'
import { HOST_API } from '../src/runtime-host.ts'

/** The report shape the drill writes; mirrored here because the script itself carries no declaration. */
interface DrillStep { name: string; ok: boolean; detail?: string }
interface DrillScenario { name: string; ok: boolean; durationMs: number; steps: DrillStep[] }
interface DrillReport {
  api: 1
  ok: boolean
  from: string
  stateDir: string
  counts: { passed: number; failed: number; total: number }
  scenarios: DrillScenario[]
}
interface DrillResult { report: DrillReport; path: string }

let work: string
let source: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'drill-'))
  source = join(work, 'repo')
  mkdirSync(join(source, 'lib'), { recursive: true })
  const entry = `export const HOST_API = ${HOST_API}\nexport const SCHEMA_VERSION = 25\nexport function createRuntime() { throw new Error('the drill must not load the packaged bundle') }\n`
  writeFileSync(join(source, 'lib', 'runtime-entry.js'), entry)
  writeFileSync(join(source, 'lib', 'runtime-manifest.json'), JSON.stringify({ version: '0.5.0-test',
    entry: 'runtime-entry.js', hostApi: HOST_API, schema: 25, sha256: createHash('sha256').update(entry).digest('hex') }, null, 2))
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('runtime drill', () => {
  it('runs every scenario against a throwaway state directory and writes one JSON report', async () => {
    const out = join(work, 'drills', 'report.json')
    const stateDir = join(work, 'state')
    const { report, path } = await runDrill({ from: source, stateDir, out }) as DrillResult
    expect(path).toBe(out)
    expect(existsSync(out)).toBe(true)
    const written = JSON.parse(readFileSync(out, 'utf8')) as DrillReport
    expect(written).toMatchObject({ api: 1, ok: true, from: source, stateDir })
    expect(written.counts).toEqual({ passed: written.scenarios.length, failed: 0, total: written.scenarios.length })
    const names = written.scenarios.map(scenario => scenario.name)
    expect(names).toEqual(expect.arrayContaining(['stage-built-runtime', 'apply-and-observe', 'rollback-round-trip',
      'crash-recovery-prepare', 'crash-recovery-stage', 'crash-recovery-backup', 'crash-recovery-drain',
      'crash-recovery-swap', 'crash-recovery-load', 'crash-recovery-init', 'crash-recovery-commit',
      'corrupt-staged-entry', 'pending-request-storm', 'schema-downgrade', 'failed-init-rollback']))
    expect(names).toHaveLength(15)
    for (const scenario of written.scenarios) {
      expect(scenario.ok, `${scenario.name}: ${scenario.steps.map(step => `${step.name} ${step.ok ? 'ok' : step.detail}`).join('; ')}`).toBe(true)
      expect(scenario.durationMs).toBeGreaterThanOrEqual(0)
      expect(scenario.steps.length).toBeGreaterThan(0)
      expect(scenario.steps.every(step => step.ok)).toBe(true)
    }
    // The report names the real built version it staged, so an operator can match it to the build.
    expect(written.scenarios[0]!.steps.some(step => step.detail?.includes('0.5.0-test'))).toBe(true)
  }, 120_000)
})
