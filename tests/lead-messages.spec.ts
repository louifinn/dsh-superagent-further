import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../src/app/migration.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'

let directory: string | undefined
afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

/** Opens a fresh Store in a temporary state directory. */
function open(): { store: Store; path: string } {
  directory ??= mkdtempSync(join(tmpdir(), 'lead-messages-'))
  const path = join(directory, 'orchestrator.sqlite')
  return { store: new Store(path), path }
}

describe('Lead messages', () => {
  it('records a message once per recipient and request id', () => {
    const { store } = open()
    try {
      const sent = store.leads.send({ project: 'app', kind: 'assignment', from: 'orchestrator', to: 'lead', requestId: 'ticket-1',
        ticketId: 'ticket-1', body: 'Start the Ticket in app.' })
      expect(sent.id).toBeTruthy()
      // The same request to the same recipient is the same record, whatever the caller passes the second time.
      const again = store.leads.send({ project: 'app', kind: 'assignment', from: 'orchestrator', to: 'lead', requestId: 'ticket-1',
        ticketId: 'ticket-1', body: 'A retry with other text.' })
      expect(again.id).toBe(sent.id)
      expect(again.body).toBe('Start the Ticket in app.')
      // A different recipient keeps its own record for the same request, and so does a different request.
      const other = store.leads.send({ project: 'app', kind: 'assignment', from: 'orchestrator', to: 'orchestrator', requestId: 'ticket-1',
        body: 'Not the Lead.' })
      expect(other.id).not.toBe(sent.id)
      const next = store.leads.send({ project: 'app', kind: 'report', from: 'lead', to: 'orchestrator', requestId: 'report-1',
        body: 'The Ticket is settled.' })
      expect(next.id).not.toBe(sent.id)
      expect(store.leads.get(sent.id)).toEqual(sent)
      expect(store.leads.getByRequest('lead', 'ticket-1')).toEqual(sent)
    } finally { store.close() }
  })

  it('lists a project\'s messages newest first and only undelivered messages wait', () => {
    const { store } = open()
    try {
      const first = store.leads.send({ project: 'app', kind: 'assignment', from: 'orchestrator', to: 'lead', requestId: 'a-1', body: 'one' },
        '2026-01-01T00:00:00.000Z')
      const second = store.leads.send({ project: 'app', kind: 'report', from: 'lead', to: 'orchestrator', requestId: 'r-1', body: 'two' },
        '2026-01-01T00:00:01.000Z')
      const other = store.leads.send({ project: 'lib', kind: 'assignment', from: 'orchestrator', to: 'lead', requestId: 'a-2', body: 'elsewhere' },
        '2026-01-01T00:00:02.000Z')
      expect(store.leads.list('app').map(message => message.id)).toEqual([second.id, first.id])
      expect(store.leads.waiting('lead')).toEqual([first, other])
      expect(store.leads.waiting('lead', 'lib')).toEqual([other])
      expect(store.leads.waiting('lead', 'app')).toEqual([first])
      store.leads.deliver(first.id, '2026-01-01T00:00:03.000Z')
      expect(store.leads.waiting('lead')).toEqual([other])
    } finally { store.close() }
  })

  it('marks delivery and acknowledgement once, keeping the first time', () => {
    const { store } = open()
    try {
      const message = store.leads.send({ project: 'app', kind: 'report', from: 'lead', to: 'orchestrator', requestId: 'r-1', body: 'done' })
      store.leads.deliver(message.id, '2026-01-01T00:00:00.000Z')
      store.leads.deliver(message.id, '2026-01-01T00:01:00.000Z')
      expect(store.leads.get(message.id)?.deliveredAt).toBe('2026-01-01T00:00:00.000Z')
      store.leads.ack(message.id, '2026-01-01T00:02:00.000Z')
      store.leads.ack(message.id, '2026-01-01T00:03:00.000Z')
      expect(store.leads.get(message.id)?.ackAt).toBe('2026-01-01T00:02:00.000Z')
    } finally { store.close() }
  })

  it('opens a schema 12 database at the current schema and keeps its messages', () => {
    const { store, path } = open()
    const message = store.leads.send({ project: 'app', kind: 'notice', from: 'orchestrator', to: 'lead', requestId: 'n-1', body: 'A note.' })
    store.set(KV.store.schema, 12)
    store.close()
    const reopened = new Store(path)
    try {
      expect(reopened.get(KV.store.schema)).toBe(SCHEMA_VERSION)
      expect(reopened.leads.get(message.id)?.body).toBe('A note.')
    } finally { reopened.close() }
  })
})
