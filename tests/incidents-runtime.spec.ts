/**
 * Incidents end to end: a seeded operational fault burst becomes one durable incident with one evidence bundle, a
 * repeat inside the cooldown only increments occurrences, a cleared condition lets a later burst reopen it, a failed
 * bundle degrades to health instead of breaking a pass, and the stalled-Assignment watchdog records one incident
 * without raising a second request. Detection makes no model call.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { runningAssignment } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
afterEach(async () => { if (h) await h.stop() })

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const burst = (from: number): void => {
  for (let index = from; index < from + 3; index++) h.runtime.logs.record('warn', 'outbox', `reply delivery failed reply=r${index}: timeout`)
}

it('turns a seeded fault burst into one incident, counts a repeat, and reopens after the cooldown', async () => {
  h = await startRuntime()
  const deliveries = h.deliveries.mock.calls.length
  burst(0)
  const incidents = h.runtime.incidents.list({ status: 'open' })
  expect(incidents).toHaveLength(1)
  const incident = incidents[0]!
  expect(incident.rule).toBe('outbox-failures')
  expect(incident.severity).toBe('high')
  expect(incident.occurrences).toBe(1)

  // The bundle lives under the Orchestrator workspace, with a manifest that hashes every file it lists.
  const directory = join(h.workspaceRoot, 'artifacts', 'incidents', incident.id)
  expect(existsSync(join(directory, 'manifest.json'))).toBe(true)
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { content_sha256: string
    files: { name: string; bytes: number; sha256: string }[] }
  expect(manifest.content_sha256).toMatch(/^[0-9a-f]{64}$/)
  for (const file of manifest.files) {
    expect(sha256(join(directory, file.name))).toBe(file.sha256)
    expect(readFileSync(join(directory, file.name)).length).toBe(file.bytes)
  }
  expect(readFileSync(join(directory, 'log-window.jsonl'), 'utf8')).toContain('reply delivery failed reply=r2: timeout')

  // A second burst inside the cooldown is the same incident, counted again — never a duplicate record or bundle.
  burst(3)
  const counted = h.runtime.incidents.list({ status: 'open' })
  expect(counted).toHaveLength(1)
  expect(counted[0]!.id).toBe(incident.id)
  expect(counted[0]!.occurrences).toBe(2)
  expect(counted[0]!.evidence_dir).toBe(incident.evidence_dir)

  // A person (or M34's diagnoser) resolves it; a burst after the cooldown reopens the same record.
  h.runtime.incidents.recover(incident.fingerprint)
  const old = h.runtime.store.incidents.get(incident.id)!
  h.runtime.store.incidents.save({ ...old, last_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() })
  burst(6)
  const reopened = h.runtime.store.incidents.get(incident.id)!
  expect(reopened.status).toBe('bundled')
  expect(reopened.occurrences).toBe(3)

  // Detection is deterministic: no prompt or model call reached a Session.
  expect(h.deliveries.mock.calls.length).toBe(deliveries)
})

it('degrades a failed evidence bundle to the incidents health entry without breaking the pass', async () => {
  h = await startRuntime()
  // A file where the artifacts directory must be makes the bundle impossible; recording must still succeed.
  writeFileSync(join(h.workspaceRoot, 'artifacts'), 'not a directory')
  expect(() => burst(0)).not.toThrow()
  const incident = h.runtime.incidents.list({ status: 'open' })[0]!
  expect(incident.evidence_dir).toBe('')
  expect(incident.status).toBe('detected')
  expect(h.runtime.health['incidents']?.state).toBe('error')
  expect(h.runtime.logs.list({ scope: 'incidents' }).some(entry => entry.message.includes('evidence'))).toBe(true)
  // The record is durable and a later log entry still works: no exception escaped the pass.
  expect(h.runtime.store.incidents.get(incident.id)!.id).toBe(incident.id)
})

it('records one stalled-Assignment incident from the watchdog and never a second request', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
  await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const assignment = runningAssignment(stored)!
  // The watchdog only reports an Assignment whose worker Session is idle; the fake agent starts out running.
  ;(h.agents.get(`worker-${ticket.id}`) as { status: string }).status = 'idle'
  const idleAt = new Date(Date.now() - 11 * 60_000).toISOString()
  h.runtime.store.tickets.save({ ...stored, assignments: stored.assignments.map(item =>
    item.id === assignment.id ? { ...item, idleAt } : item) })
  await h.runtime.watchdogScan(new Date())
  await h.runtime.watchdogScan(new Date())
  const incidents = h.runtime.incidents.list({ status: 'open' }).filter(item => item.rule === 'stalled-assignment')
  expect(incidents).toHaveLength(1)
  expect(incidents[0]!.scope.ticket).toBe(ticket.id)
  expect(incidents[0]!.occurrences).toBe(1)
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after.attention?.question).toContain('stuck')
})

it('serves the incident list and detail with the manifest summary over the management API', async () => {
  h = await startRuntime()
  burst(0)
  const listed = await h.api('GET', 'incidents?status=open')
  expect(listed.status).toBe(200)
  const body = listed.body as { incidents: { id: string }[]; total: number }
  expect(body.total).toBe(1)
  expect(body.incidents).toHaveLength(1)
  const detail = await h.api('GET', `incidents/${body.incidents[0]!.id}`)
  expect(detail.status).toBe(200)
  const view = detail.body as { incident: { id: string }; evidence: { dir: string; manifest: { files: unknown[] } } | null }
  expect(view.incident.id).toBe(body.incidents[0]!.id)
  expect(view.evidence!.manifest.files.length).toBeGreaterThan(0)
  const missing = await h.api('GET', 'incidents/not-a-record')
  expect(missing.status).toBe(404)
  expect(missing.body.code).toBe('incidentUnknown')
})
