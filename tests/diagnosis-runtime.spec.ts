/**
 * Incident diagnosis through the running Runtime (ADR-0005): the automatic dispatch after a bundle is asynchronous and
 * uses the read-only diagnostician preset under a read-only permission; the operator actions are the same-origin HTTP
 * routes and the `orchestrator_incident` tool, audited with metadata only and refused with 400/404/409.
 */
import { join } from 'node:path'
import { expect, it, vi, type Mock } from 'vitest'
import type { Incident, IncidentDiagnosis } from '../src/core/incidents.ts'
import { DIAGNOSTICIAN_PRESET } from '../src/app/sessions.ts'
import type { Store } from '../src/app/store.ts'
import type { ActivationSpec } from '../src/executor/lead-dispatch.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

/** Settings the incident tests need before the Runtime starts; the default project is added by the fixture afterwards. */
const incidents = (overrides: Record<string, unknown> = {}) => (store: Store) => {
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor,
    incidents: { ...settings.executor.incidents, autoDiagnose: true, minimumSeverity: 'high', diagnoseDailyBudget: 2, ...overrides } } })
}

const candidate = (detail = '3 reply delivery failures in 30 minutes') => ({ rule: 'outbox-failures' as const, severity: 'high' as const,
  title: 'Reply deliveries are failing', detail })

/** The strict diagnosis document an operator action returns, targeting the fixture's registered project. */
const document = (overrides: Record<string, unknown> = {}) => ({
  rootCause: 'Reply delivery times out because the outbox retries without a bound.',
  evidence: ['3 reply delivery failures in 30 minutes'],
  hypotheses: ['The Feishu client hangs on a stale socket'],
  fixPlan: 'Bound each outbox send and report a failed one to health.',
  confidence: 'high',
  target: { kind: 'project', project: 'acme/widgets' },
  ...overrides,
})

const answer = (h: Host, childId: string, value: unknown): void => {
  h.subagents.settle(childId, true, { output: [{ type: 'text', text: JSON.stringify(value) }], stopReason: 'endTurn' })
}

/** The single child the diagnosis dispatch started, once it exists. */
async function childOf(h: Host): Promise<string> {
  let id = ''
  await vi.waitFor(async () => {
    const children = await h.subagents.service.listChildren(h.runtime.masterId)
    expect(children).toHaveLength(1)
    id = (children[0] as { id: string }).id
  })
  return id
}

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 50) })

it('dispatches the read-only diagnostician after an incident is bundled, never inside the detection pass', async () => {
  const h = await startRuntime(incidents())
  try {
    const start = h.subagents.service.startActivation as unknown as Mock
    const before = start.mock.calls.length
    for (const n of [1, 2, 3]) h.runtime.logs.record('warn', 'outbox', `reply delivery failed reply=r${n}: timeout`)
    const incident = h.runtime.incidents.list()[0]!
    expect(incident.status).toBe('bundled')
    // The detection pass recorded the incident and returned; the child is started on a later turn.
    expect(start).toHaveBeenCalledTimes(before)
    const childId = await childOf(h)
    const spec = start.mock.calls.at(-1)![0] as ActivationSpec
    const text = spec.request.prompt[0]!.text
    expect(spec.provider).toBe('spawn')
    expect(spec.delivery).toBe('caller')
    expect(spec.childId).toBe(childId)
    expect(spec.request.agentPreset).toBe(DIAGNOSTICIAN_PRESET)
    expect(spec.request.maxDepth).toBe(1)
    expect(spec.request.cwd).toBe(h.workspaceRoot)
    expect(spec.request.parent.id).toBe(h.runtime.masterId)
    for (const fragment of [incident.id, 'STRICT JSON', 'rootCause', 'fixPlan', join(h.workspaceRoot, 'artifacts', 'incidents'),
      h.workspaceRoot, 'Do not write']) expect(text).toContain(fragment)
    expect(h.subagents.started(childId)).toEqual({ parent: h.runtime.masterId, delivery: 'caller', preset: DIAGNOSTICIAN_PRESET })
    // Defense in depth: the child Session is put under the read-only permission preset.
    expect(h.permissionPresets.set).toHaveBeenCalledWith(expect.objectContaining({ id: childId }), 'read-only')
    answer(h, childId, document({ target: { kind: 'operational' } }))
    await vi.waitFor(() => expect(h.runtime.incidents.list()[0]!.status).toBe('diagnosed'))
    expect(h.runtime.incidents.list()[0]!.resolution).toBe('operational')
    expect(h.runtime.store.requests.list()).toHaveLength(0)
  } finally { await h.stop() }
})

it('does not dispatch when autoDiagnose is off', async () => {
  const h = await startRuntime(incidents({ autoDiagnose: false }))
  try {
    const start = h.subagents.service.startActivation as unknown as Mock
    for (const n of [1, 2, 3]) h.runtime.logs.record('warn', 'outbox', `reply delivery failed reply=r${n}: timeout`)
    expect(h.runtime.incidents.list()[0]!.status).toBe('bundled')
    await flush()
    expect(start).not.toHaveBeenCalled()
  } finally { await h.stop() }
})

it('diagnoses, routes and audits through the same-origin HTTP routes', async () => {
  const h = await startRuntime(incidents())
  try {
    const incident = h.runtime.incidents.record(candidate())!
    const pending = h.api('POST', `incidents/${incident.id}/diagnose`, {})
    const childId = await childOf(h)
    answer(h, childId, document())
    const { status, body } = await pending
    expect(status).toBe(200)
    const diagnosed = body.incident as Incident
    expect(diagnosed.status).toBe('diagnosed')
    expect(diagnosed.resolution).toMatch(/^request:/)
    // The diagnose response and its audit both carry the work id the automatic route created.
    expect(body.resolution).toMatch(/^request:/)
    expect(h.runtime.store.requests.list()).toHaveLength(1)
    expect(h.runtime.store.requests.list()[0]!.title).toContain(incident.id)
    // The audit trail carries the action and ids, never the diagnosis text.
    const audit = h.runtime.logs.list({ scope: 'audit' })
    const entry = audit.find(item => item.data?.action === 'incident.diagnose')!
    expect(entry.data).toMatchObject({ incident: incident.id, status: 'diagnosed', confidence: 'high', target: 'project',
      resolution: body.resolution })
    expect(JSON.stringify(entry.data)).not.toContain('outbox retries without a bound')
    // The detail view carries the parsed diagnosis.
    const detail = await h.api('GET', `incidents/${incident.id}`)
    expect(detail.status).toBe(200)
    expect((detail.body.diagnosis as IncidentDiagnosis).rootCause).toBe(document().rootCause)
    expect((detail.body.diagnosis as IncidentDiagnosis).confidence).toBe('high')
    // One incident never routes twice.
    const again = await h.api('POST', `incidents/${incident.id}/route`, { confirm: true })
    expect(again.status).toBe(409)
    // Dismissal requires a reason and is refused for a record already dismissed.
    expect((await h.api('POST', `incidents/${incident.id}/dismiss`, {})).status).toBe(400)
    const dismissed = await h.api('POST', `incidents/${incident.id}/dismiss`, { reason: 'handled by an operator' })
    expect(dismissed.status).toBe(200)
    expect((dismissed.body.incident as Incident).status).toBe('dismissed')
    expect((await h.api('POST', `incidents/${incident.id}/dismiss`, { reason: 'again' })).status).toBe(409)
    expect((await h.api('POST', 'incidents/nope/diagnose', {})).status).toBe(404)
    expect((await h.api('GET', 'incidents/nope')).body).toMatchObject({ code: 'incidentUnknown' })
  } finally { await h.stop() }
})

it('retries a failed automatic route from the confirmation route, audited with the request id', async () => {
  const h = await startRuntime(incidents())
  try {
    const create = h.runtime.engine.raiseDiscoveryRequest.bind(h.runtime.engine)
    let calls = 0
    vi.spyOn(h.runtime.engine, 'raiseDiscoveryRequest').mockImplementation(input => {
      if (++calls === 1) throw new Error('the Engine was briefly unavailable')
      return create(input)
    })
    const incident = h.runtime.incidents.record(candidate())!
    const pending = h.api('POST', `incidents/${incident.id}/diagnose`, {})
    const childId = await childOf(h)
    answer(h, childId, document())
    const diagnosed = await pending
    expect(diagnosed.status).toBe(200)
    expect((diagnosed.body.incident as Incident).resolution).toBeUndefined()
    // A route without confirmation is a malformed body, not an action.
    expect((await h.api('POST', `incidents/${incident.id}/route`, {})).status).toBe(400)
    const routed = await h.api('POST', `incidents/${incident.id}/route`, { confirm: true })
    expect(routed.status).toBe(200)
    const resolution = (routed.body.incident as Incident).resolution!
    expect(resolution).toMatch(/^request:/)
    const audit = h.runtime.logs.list({ scope: 'audit' })
    const entry = audit.find(item => item.data?.action === 'incident.route')!
    expect(entry.data).toMatchObject({ incident: incident.id, resolution })
    expect(h.runtime.store.requests.list()).toHaveLength(1)
    expect((await h.api('POST', `incidents/${incident.id}/route`, { confirm: true })).status).toBe(409)
  } finally { await h.stop() }
})

it('exposes list, get, diagnose, dismiss and route as orchestrator_incident with typed refusals', async () => {
  const h = await startRuntime(incidents())
  try {
    const incident = h.runtime.incidents.record(candidate())!
    const listed = await h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'list', status: 'open' })
    expect(listed.total).toBe(1)
    const got = await h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'get', id: incident.id })
    expect((got.incident as Incident).id).toBe(incident.id)
    expect(await h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'route', id: incident.id, confirm: false }))
      .toMatchObject({ status: 'refused', reason: 'unconfirmed' })
    const pending = h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'diagnose', id: incident.id })
    const childId = await childOf(h)
    answer(h, childId, document({ target: { kind: 'operational' } }))
    const diagnosed = await pending
    expect(diagnosed.status).toBe('diagnosed')
    expect((diagnosed.incident as Incident).status).toBe('diagnosed')
    expect(await h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'route', id: incident.id, confirm: true }))
      .toMatchObject({ status: 'refused', reason: 'alreadyRouted' })
    // A reopened record keeps its old diagnosis but is bundled again, so neither path may route that stale text.
    const stale = h.runtime.incidents.record(candidate('a different reply delivery failure'))!
    h.runtime.store.incidents.save({ ...stale, diagnosis: JSON.stringify(document()) })
    expect((await h.api('POST', `incidents/${stale.id}/route`, { confirm: true })).status).toBe(409)
    expect(await h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'route', id: stale.id, confirm: true }))
      .toMatchObject({ status: 'refused', reason: 'notDiagnosed' })
    // A list's total is the filtered row count, not the page length.
    const page = await h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'list', status: 'open', limit: 1 })
    expect((page.incidents as Incident[]).length).toBe(1)
    expect(page.total).toBe(2)
    const dismissed = await h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'dismiss', id: incident.id, reason: 'duplicate' })
    expect((dismissed.incident as Incident).status).toBe('dismissed')
    await expect(h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'get', id: 'nope' }))
      .rejects.toMatchObject({ code: 'incidentUnknown' })
    // A refusal is a value, not a thrown error: the model can tell the operator why.
    expect(await h.runTool(h.runtime.masterId, 'orchestrator_incident', { action: 'diagnose', id: incident.id }))
      .toMatchObject({ status: 'refused', reason: 'status' })
  } finally { await h.stop() }
})
