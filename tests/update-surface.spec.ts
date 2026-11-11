/**
 * The runtime-side update surface over real on-disk state: the snapshot the panel reads, the Overview attention projection, and
 * the one rollback request the runtime may write. The supervisor's engine and the deployment CLI own the other writers, so this
 * spec only stages what they would leave behind (pointers, journal, history, request files).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logs } from '../src/app/logs.ts'
import { Updates } from '../src/app/updates.ts'
import type { UpdateHistoryEntry } from '../src/supervisor/update-state.ts'
import { appendUpdateHistory, updateProcessingPath, updateRequestPath, writeDescriptorFile, writeUpdateRequest }
  from '../src/supervisor/update-state.ts'
import { currentPointer, previousPointer, runtimeDirectory } from '../src/supervisor/versions.ts'
import type { RuntimeDescriptor } from '../src/runtime-host.ts'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'update-surface-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
/** Stage one version on disk and return its pointer descriptor. */
function staged(version: string): RuntimeDescriptor {
  const folder = join(runtimeDirectory(directory), version)
  mkdirSync(folder, { recursive: true })
  const entry = 'runtime-entry.js'
  const source = `export const version = '${version}'\n`
  writeFileSync(join(folder, entry), source)
  return { version, entry, hostApi: 1, sha256: sha(source), schema: 25 }
}
const entry = (outcome: UpdateHistoryEntry['outcome'], phase: UpdateHistoryEntry['phase'],
  extra: Partial<UpdateHistoryEntry> = {}): UpdateHistoryEntry => ({ api: 1, id: `id-${outcome}`, action: 'apply', outcome, version: '0.4.0',
  from: '0.3.0', phase, reason: null, at: '2026-11-11T10:00:00.000Z', durationMs: 12, ...extra })

describe('the runtime update surface', () => {
  it('reads the pointers, journal and history the supervisor wrote and projects the Overview attention', async () => {
    const current = staged('0.4.0'), previous = staged('0.3.0')
    writeDescriptorFile(currentPointer(runtimeDirectory(directory)), current)
    writeDescriptorFile(previousPointer(runtimeDirectory(directory)), previous)
    appendUpdateHistory(directory, entry('rolledback', 'rollback', { reason: 'the new runtime failed readiness' }))
    const logs = new Logs()
    const updates = new Updates({ stateDir: directory, logs })
    const status = updates.status()
    expect(status).toMatchObject({ api: 1, stateDir: directory, current: { version: '0.4.0' }, previous: { version: '0.3.0' },
      pending: null, busy: false, databaseSchema: null })
    expect(status.rollback).toMatchObject({ eligible: true, version: '0.3.0' })
    expect(status.history.map(item => item.outcome)).toEqual(['rolledback'])
    expect(status.deploy.command).toContain('scripts/deploy-runtime.mjs')
    writeUpdateRequest(directory, { api: 1, id: 'pending-1', action: 'apply', version: '0.5.0', at: '2026-11-11T10:05:00.000Z',
      by: 'operator' })
    expect(updates.status().pending).toMatchObject({ id: 'pending-1', action: 'apply', version: '0.5.0' })
    // A pending request blocks a rollback until it is claimed or expires.
    expect(updates.status().rollback.eligible).toBe(false)
    const attention = updates.attention()
    expect(attention).toMatchObject({ pending: true, failed: false, version: '0.5.0', phase: 'rollback' })
    expect(attention.reason).toContain('pending')
    // The last failure, not a rollback the engine recovered from, is what Overview says needs a person.
    appendUpdateHistory(directory, entry('failed', 'init', { reason: 'the runtime never became ready' }))
    expect(updates.attention()).toMatchObject({ failed: true, phase: 'init', version: '0.5.0',
      reason: 'the runtime never became ready' })
  })

  it('writes one rollback request and refuses while a request, an update or a bad previous version blocks it', () => {
    const current = staged('0.4.0'), previous = staged('0.3.0')
    writeDescriptorFile(currentPointer(runtimeDirectory(directory)), current)
    writeDescriptorFile(previousPointer(runtimeDirectory(directory)), previous)
    const logs = new Logs()
    const updates = new Updates({ stateDir: directory, logs })
    const queued = updates.rollback()
    expect(queued).toMatchObject({ ok: true, request: { api: 1, action: 'rollback', by: 'operator' } })
    const written = JSON.parse(readFileSync(updateRequestPath(directory), 'utf8')) as Record<string, unknown>
    expect(written).toMatchObject({ api: 1, action: 'rollback', by: 'operator' })
    expect(String(written.id)).toMatch(/^[0-9a-f-]{36}$/)
    expect(String(written.at)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // One pending request at a time: the page's second confirm must not replace the first.
    expect(updates.rollback()).toMatchObject({ ok: false, reason: expect.stringContaining('already pending') })
    rmSync(updateRequestPath(directory), { force: true })
    writeFileSync(updateProcessingPath(directory), '{"api":1}')
    expect(updates.rollback()).toMatchObject({ ok: false, reason: expect.stringContaining('already in progress') })
    rmSync(updateProcessingPath(directory), { force: true })
    rmSync(previousPointer(runtimeDirectory(directory)), { force: true })
    expect(updates.rollback()).toMatchObject({ ok: false, reason: 'No previous runtime is recorded' })
    expect(existsSync(updateRequestPath(directory))).toBe(false)
    expect(logs.list({ scope: 'update' }).map(item => item.message)).toEqual([
      `update.requested action=rollback id=${String(written.id)} actor=operator`])
  })

  it('refuses a previous runtime whose bundle no longer matches its pointer', () => {
    const current = staged('0.4.0'), previous = staged('0.3.0')
    writeDescriptorFile(currentPointer(runtimeDirectory(directory)), current)
    writeDescriptorFile(previousPointer(runtimeDirectory(directory)), previous)
    writeFileSync(join(runtimeDirectory(directory), previous.version, previous.entry), 'tampered')
    const updates = new Updates({ stateDir: directory, logs: new Logs() })
    expect(updates.rollback()).toMatchObject({ ok: false, reason: expect.stringContaining('has hash') })
    expect(updates.attention()).toMatchObject({ failed: false })
  })
})
