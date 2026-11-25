/** Managed agent errors (issue #25): the public record names the error, the evidence file carries its text. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentErrors, agentRole, errorIdentity, type AgentErrorRecord } from '../src/app/agent-errors.ts'

const directories: string[] = []

const collector = (options: { limit?: number } = {}) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-agent-errors-'))
  directories.push(stateDir)
  return { stateDir, errors: new AgentErrors({ stateDir: () => stateDir, now: () => new Date('2026-11-25T10:00:00.000Z'), ...options }) }
}

const input = (overrides: Partial<Parameters<AgentErrors['record']>[0]> = {}) => ({
  role: 'lead' as const, sessionId: 'lead-default', project: 'default', error: Object.assign(new Error('the provider refused'), { code: 'ETIMEDOUT' }),
  ...overrides,
})

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('agent error collection', () => {
  it('attributes Session ids to their managed role, and nothing else', () => {
    expect(agentRole('orchestrator-1', 'orchestrator-1')).toBe('orchestrator')
    expect(agentRole('lead-default', 'orchestrator-1')).toBe('lead')
    expect(agentRole('worker-ticket-1', 'orchestrator-1')).toBe('worker')
    expect(agentRole('review-ticket-1', 'orchestrator-1')).toBe('reviewer')
    expect(agentRole('diagnosis-1', 'orchestrator-1')).toBe('diagnosis')
    expect(agentRole('someone-else', 'orchestrator-1')).toBeUndefined()
  })

  it('keeps the public record free of error text and writes the text into the evidence file', () => {
    const { errors } = collector()
    const record = errors.record(input())
    expect(record).toMatchObject({ role: 'lead', sessionId: 'lead-default', project: 'default', name: 'Error', code: 'ETIMEDOUT' })
    expect(JSON.stringify(record)).not.toContain('provider refused')
    const evidence = JSON.parse(readFileSync(record.evidence, 'utf8')) as Record<string, unknown>
    expect(evidence).toMatchObject({ role: 'lead', session: 'lead-default', name: 'Error', code: 'ETIMEDOUT', message: 'the provider refused' })
    expect(String(evidence.stack)).toContain('Error: the provider refused')
  })

  it('filters the public ring by role and Session, and keeps only the requested page', () => {
    const { errors } = collector()
    const lead = errors.record(input({ role: 'lead', sessionId: 'lead-default' }))
    const reviewer = errors.record(input({ role: 'reviewer', sessionId: 'review-ticket-1' }))
    errors.record(input({ role: 'lead', sessionId: 'lead-other' }))
    expect(errors.list()).toHaveLength(3)
    expect(errors.list({ role: 'lead' })).toHaveLength(2)
    expect(errors.list({ sessionId: reviewer.sessionId })).toEqual([reviewer])
    expect(errors.list({ role: 'lead', limit: 1 }).map(record => record.sessionId)).toEqual(['lead-other'])
    expect(errors.list({ role: 'lead' }).map(record => record.id)).toContain(lead.id)
  })

  it('keeps its public ring bounded', () => {
    const { errors } = collector({ limit: 2 })
    const first = errors.record(input({ sessionId: 'lead-a' }))
    errors.record(input({ sessionId: 'lead-b' }))
    errors.record(input({ sessionId: 'lead-c' }))
    expect(errors.list()).toHaveLength(2)
    expect(errors.list().map(record => record.id)).not.toContain(first.id)
  })

  it('identifies a thrown value the same way whether or not it is an Error', () => {
    expect(errorIdentity(new Error('boom'))).toMatchObject({ name: 'Error', message: 'boom' })
    expect(errorIdentity('plain text')).toEqual({ name: 'Error', message: 'plain text' })
    const coded = Object.assign(new Error('slow'), { code: 42 })
    expect(errorIdentity(coded)).toMatchObject({ name: 'Error', code: '42', message: 'slow' })
  })

  it('names the Ticket of a reviewer error and the project of a lead error in its records', () => {
    const { errors } = collector()
    const reviewer = errors.record(input({ role: 'reviewer', sessionId: 'review-ticket-9', ticketId: 'ticket-9', project: undefined }))
    const orphan = errors.record(input({ role: 'diagnosis', sessionId: 'diagnosis-1', project: undefined }))
    expect(reviewer).toMatchObject({ role: 'reviewer', ticketId: 'ticket-9' })
    expect(orphan).not.toHaveProperty('ticketId')
    expect(Array.isArray(errors.list())).toBe(true)
    expect(({} as Partial<AgentErrorRecord>).role).toBeUndefined()
  })
})
