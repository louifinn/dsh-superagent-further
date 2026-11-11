// @vitest-environment jsdom
// The Incidents page: open records with rule, severity, scope and occurrences, status and severity filters, the detail's
// evidence manifest, and the Overview "needs you" row that links to it.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, find, tab, click, text, type } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'inc-1',
  fingerprint: 'fp-outbox-1',
  rule: 'outbox-failures' as const,
  severity: 'high' as const,
  status: 'bundled' as const,
  scope: { project: 'p1', ticket: 't1' },
  first_at: '2026-11-11T09:00:00.000Z',
  last_at: '2026-11-11T10:00:00.000Z',
  occurrences: 3,
  title: '回复发送失败 3 次',
  detail: '3 reply delivery failures in 30 minutes',
  evidence_dir: '/tmp/workspace/artifacts/incidents/inc-1',
  updated_at: '2026-11-11T10:00:00.000Z',
  ...overrides,
})
const segment = (label: string) => find(label, '.dt-segmented [role="tab"]')

it('lists open incidents with their rule, severity, scope, status and occurrences', async () => {
  server.incidentRecords = [record() as never]
  await mount()
  await click(tab(zh['tab.incidents']))
  expect(all('[data-incidents] tbody tr')).toHaveLength(1)
  const row = document.querySelector('[data-incident="inc-1"]')!
  expect(row.textContent).toContain('回复发送失败 3 次')
  expect(row.textContent).toContain(zh['incidentSeverity.high'])
  expect(row.textContent).toContain(zh['incidentRule.outbox-failures'])
  expect(row.textContent).toContain('project=p1 · ticket=t1')
  expect(row.textContent).toContain(zh['incidentStatus.bundled'])
  expect(row.textContent).toContain('3')
})

it('filters the list by status and severity and distinguishes no records from no match', async () => {
  server.incidentRecords = [record() as never]
  await mount()
  await click(tab(zh['tab.incidents']))
  // The default view is open incidents only.
  expect(server.requests.at(-1)?.path).toContain('incidents?status=open')
  await click(segment(zh['incidentStatus.resolved']))
  expect(server.requests.at(-1)?.path).toContain('status=resolved')
  expect(text()).toContain(zh.incidentsNoMatch)
  // An empty status view without filters reads as "no incidents yet".
  await click(segment(zh['incidentStatus.open']))
  expect(server.requests.at(-1)?.path).toContain('status=open')
  await click(segment(zh['incidentSeverity.critical']))
  expect(server.requests.at(-1)?.path).toContain('severity=critical')
  expect(text()).toContain(zh.incidentsNoMatch)
  server.incidentRecords = []
  await click(segment(zh.incidentSeverityAll))
  await click(tab(zh['tab.incidents']))
  expect(text()).toContain(zh.incidentsEmpty)
})

it('opens one incident with its evidence directory and content-addressed files', async () => {
  server.incidentRecords = [record() as never]
  server.incidentEvidence = { 'inc-1': {
    dir: '/tmp/workspace/artifacts/incidents/inc-1',
    manifest: {
      generated_at: '2026-11-11T10:00:00.000Z', version: '0.4.0-test', rule: 'outbox-failures', fingerprint: 'fp-outbox-1',
      content_sha256: 'a'.repeat(64),
      files: [
        { name: 'config.json', bytes: 42, sha256: 'b'.repeat(64) },
        { name: 'log-window.jsonl', bytes: 128, sha256: 'c'.repeat(64) },
      ],
    },
  } as never }
  await mount()
  await click(tab(zh['tab.incidents']))
  await click(document.querySelector<HTMLElement>('[data-incident="inc-1"] .dt-open')!)
  expect(server.requests.at(-1)?.path).toContain('incidents/inc-1')
  const detail = document.querySelector('[data-incident-detail="inc-1"]')!
  expect(detail.textContent).toContain(zh['incidentRule.outbox-failures'])
  expect(detail.textContent).toContain(zh['incidentStatus.bundled'])
  expect(detail.textContent).toContain(zh.incidentFingerprintLabel)
  expect(detail.textContent).toContain('fp-outbox-1')
  const evidence = detail.querySelector('[data-incident-evidence]')!
  expect(evidence.textContent).toContain('/tmp/workspace/artifacts/incidents/inc-1')
  expect(evidence.textContent).toContain('a'.repeat(64))
  expect(evidence.textContent).toContain('config.json')
  expect(evidence.textContent).toContain('log-window.jsonl')
})

it('shows open incidents on the Overview and links them to their detail', async () => {
  const last_at = '2026-11-11T10:00:00.000Z'
  server.incidentRecords = [record() as never]
  server.incidents = { count: 1, items: [{ id: 'inc-1', rule: 'outbox-failures', severity: 'high', title: '回复发送失败 3 次',
    occurrences: 3, last_at, scope: { project: 'p1', ticket: 't1' } }] } as never
  await mount()
  expect(text()).toContain(zh.incidentsNeedsYou)
  await click(document.querySelector<HTMLElement>('[data-overview-incident="inc-1"] .dt-open')!)
  expect(server.requests.at(-1)?.path).toContain('incidents/inc-1')
})

const diagnosis = (target: Record<string, string>) => JSON.stringify({
  rootCause: 'The outbox retries without a bound.', evidence: ['reply delivery failed 3 times'],
  hypotheses: ['The provider timeout is shorter than the retry window.'], fixPlan: 'Bound the retries and surface the failure.',
  confidence: 'high', target, parsed: true,
})
const diagnosed = (target: Record<string, string>) => record({ status: 'diagnosed', diagnosis: diagnosis(target),
  resolution: undefined })

it('diagnoses a bundled record, shows the answer and its routing, and marks the run pending', async () => {
  server.incidentRecords = [record() as never]
  await mount()
  await click(tab(zh['tab.incidents']))
  await click(document.querySelector<HTMLElement>('[data-incident="inc-1"] .dt-open')!)
  await click(find(zh.incidentDiagnoseAction, '[data-incident-actions] button'))
  expect(server.requests.some(item => item.method === 'POST' && item.path === 'incidents/inc-1/diagnose')).toBe(true)
  const detail = document.querySelector('[data-incident-detail="inc-1"]')!
  expect(detail.textContent).toContain(zh.incidentRootCause)
  expect(detail.textContent).toContain('The outbox retries without a bound.')
  expect(detail.textContent).toContain(zh.incidentFixPlan)
  expect(detail.textContent).toContain(zh.incidentConfidence)
  expect(detail.textContent).toContain(zh['incidentConfidence.high'])
  expect(detail.textContent).toContain(zh.incidentResolutionOperational)
  expect(detail.querySelector('[data-incident-actions]')!.textContent).not.toContain(zh.incidentDiagnoseAction)
})

it('creates fix work only after the confirmation and links the routed Request', async () => {
  server.incidentRecords = [diagnosed({ kind: 'project', project: 'p1' }) as never]
  await mount()
  await click(tab(zh['tab.incidents']))
  await click(document.querySelector<HTMLElement>('[data-incident="inc-1"] .dt-open')!)
  await click(find(zh.incidentRouteAction, '[data-incident-actions] button'))
  expect(server.requests.some(item => item.method === 'POST' && item.path === 'incidents/inc-1/route')).toBe(false)
  expect(text()).toContain(zh.incidentRouteConfirm)
  await click(find(zh.incidentRouteAction, '[data-incident-actions] button'))
  expect(server.requests.some(item => item.method === 'POST' && item.path === 'incidents/inc-1/route'
    && (item.body as { confirm?: boolean }).confirm === true)).toBe(true)
  const detail = document.querySelector('[data-incident-detail="inc-1"]')!
  const link = [...detail.querySelectorAll<HTMLElement>('button')].find(item => item.textContent?.includes('req-1'))
  expect(link).toBeDefined()
  await click(link!)
  expect(server.requests.at(-1)?.path).toContain('logs')
  expect(server.requests.at(-1)?.path).toContain('request=req-1')
})

it('dismisses a record only with a reason and leaves the status on the page', async () => {
  server.incidentRecords = [record() as never]
  await mount()
  await click(tab(zh['tab.incidents']))
  await click(document.querySelector<HTMLElement>('[data-incident="inc-1"] .dt-open')!)
  await click(find(zh.incidentDismissAction, '[data-incident-actions] button'))
  const confirm = document.querySelector<HTMLButtonElement>('[data-incident-dismiss] button')!
  expect(confirm.disabled).toBe(true)
  await type(find(zh.incidentDismissReason, '[data-incident-actions] input') as HTMLInputElement, 'duplicate of a known outage')
  expect(confirm.disabled).toBe(false)
  await click(confirm)
  expect(server.requests.some(item => item.method === 'POST' && item.path === 'incidents/inc-1/dismiss'
    && (item.body as { reason?: string }).reason === 'duplicate of a known outage')).toBe(true)
  expect(document.querySelector('[data-incident-detail="inc-1"]')!.textContent).toContain(zh['incidentStatus.dismissed'])
  expect(document.querySelector('[data-incident-detail="inc-1"]')!.textContent).toContain('Dismissed: duplicate of a known outage')
})
