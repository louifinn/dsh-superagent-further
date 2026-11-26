import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
import { informationViolations } from '../src/core/information.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-information-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
const storeAt = () => new Store(join(directory, 'orchestrator.sqlite'), () => {})

it('records one authoritative fact per durable role message, with its origin chain', () => {
  const store = storeAt()
  const assignment = store.leads.send({ project: 'default', kind: 'assignment', from: 'orchestrator', to: 'lead',
    requestId: 'lead-assignment:a1', ticketId: 't1', body: 'Start Assignment a1 for Ticket t1.' })
  const fact = store.leads.send({ project: 'default', kind: 'fact', from: 'orchestrator', to: 'lead',
    requestId: 'lead-fact:a1:status:t1:2026-11-26T00:00:00Z', ticketId: 't1', body: 'Release the status request.' })
  const report = store.leads.send({ project: 'default', kind: 'report', from: 'executor', to: 'lead',
    requestId: 'executor-report:r1', ticketId: 't1', body: 'The report is ready.' })
  const records = store.information.all()
  expect(records).toHaveLength(3)
  expect(informationViolations(records)).toEqual([])
  const byId = (id: string) => records.find(record => record.id === id)!
  expect(byId(assignment.id)).toMatchObject({ kind: 'assignment', direction: 'down', hops: 0, oneShot: true,
    source: { role: 'orchestrator', project: 'default' }, target: { role: 'lead', project: 'default' }, audience: ['lead'] })
  expect(byId(assignment.id).root).toBe(assignment.id)
  // The fact answers its Assignment: same root, the Assignment as parent, one hop down.
  expect(byId(fact.id)).toMatchObject({ kind: 'fact', direction: 'down', hops: 1, parent: assignment.id, root: assignment.id, oneShot: true })
  // A report travels up; it is a durable fact rather than a consumable command.
  expect(byId(report.id)).toMatchObject({ kind: 'report', direction: 'up', hops: 0, oneShot: false,
    source: { role: 'worker' }, target: { role: 'lead' } })
  // Redelivering the same request is one record and one message.
  expect(store.leads.send({ project: 'default', kind: 'assignment', from: 'orchestrator', to: 'lead',
    requestId: 'lead-assignment:a1', body: 'again' })).toEqual(assignment)
  expect(store.information.count()).toBe(3)
  expect(store.information.byDedupe(`lead:lead-assignment:a1`)?.id).toBe(assignment.id)
  expect(store.information.byId(fact.id)?.payload).toMatchObject({ ticketId: 't1' })
  store.close()
})

it('mirrors delivery and acknowledgement onto the record, without rewriting an earlier timestamp', () => {
  const store = storeAt()
  const message = store.leads.send({ project: 'default', kind: 'notice', from: 'lead', to: 'orchestrator', requestId: 'ticket-end:t1', body: 'Ended.' })
  store.leads.deliver(message.id, '2026-11-26T01:00:00Z')
  store.leads.deliver(message.id, '2026-11-26T02:00:00Z')
  store.leads.ack(message.id, '2026-11-26T03:00:00Z')
  expect(store.information.byId(message.id)).toMatchObject({ direction: 'up', deliveredAt: '2026-11-26T01:00:00Z', ackAt: '2026-11-26T03:00:00Z' })
  store.close()
})

it('refuses a record on a forbidden edge or with an inconsistent direction', () => {
  const store = storeAt()
  expect(() => store.information.send({ id: 'x', kind: 'assignment', direction: 'down', source: { role: 'orchestrator' },
    target: { role: 'worker' }, audience: ['worker'], hops: 0, oneShot: true, dedupe: 'worker:forbidden', payload: {}, root: 'x' }))
    .toThrow('may not send information to worker')
  // A worker → Lead message must be "up", not "down".
  expect(() => store.information.send({ id: 'y', kind: 'report', direction: 'down', source: { role: 'worker' },
    target: { role: 'lead' }, audience: ['lead'], hops: 0, oneShot: false, dedupe: 'lead:wrong-direction', payload: {}, root: 'y' }))
    .toThrow('is "up", not "down"')
  store.close()
})

it('backfills one record per durable message when a schema 26 database opens', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const before = new Store(path, () => {})
  const assignment = before.leads.send({ project: 'default', kind: 'assignment', from: 'orchestrator', to: 'lead',
    requestId: 'lead-assignment:a9', body: 'Start a9.' })
  before.leads.send({ project: 'default', kind: 'fact', from: 'orchestrator', to: 'lead',
    requestId: 'lead-fact:a9:status:t9:2026-11-26T00:00:00Z', ticketId: 't9', body: 'Release it.' })
  // Rewind to schema 26 with no information rows, as an installation upgraded from the previous release has.
  before.db.exec('DELETE FROM information')
  before.set('schema', 26)
  expect(before.get('schema')).toBe(26)
  before.close()
  const after = new Store(path, () => {})
  expect(after.get('schema')).toBe(SCHEMA_VERSION)
  expect(SCHEMA_VERSION).toBe(28)
  const records = after.information.all()
  expect(records).toHaveLength(2)
  expect(informationViolations(records)).toEqual([])
  const fact = records.find(record => record.kind === 'fact')!
  expect(fact).toMatchObject({ parent: assignment.id, root: assignment.id, hops: 1, direction: 'down' })
  after.close()
})
