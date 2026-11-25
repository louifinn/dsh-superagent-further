/**
 * Every managed Session's agent errors (issue #25). The collector keeps the public record free of error text — the log
 * names the role, Session, Ticket or project and the error's name and code — and writes the message and stack into a
 * controlled evidence file under `<stateDir>/evidence/agent-errors/`, which only the operator or the panel reads.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type AgentRole = 'orchestrator' | 'lead' | 'worker' | 'reviewer' | 'diagnosis'

export const AGENT_ROLES: readonly AgentRole[] = ['orchestrator', 'lead', 'worker', 'reviewer', 'diagnosis']

/** The public face of one collected error; the evidence path holds the message and stack. */
export interface AgentErrorRecord {
  id: string
  at: string
  role: AgentRole
  sessionId: string
  ticketId?: string
  project?: string
  name: string
  code?: string
  turn?: number
  step?: number
  evidence: string
}

export interface AgentErrorInput extends Omit<AgentErrorRecord, 'id' | 'at' | 'name' | 'evidence'> {
  error: unknown
}

export interface AgentErrorQuery { role?: AgentRole; sessionId?: string; limit?: number }

const ERROR_LIMIT = 100
const EVIDENCE_KEEP = 100

/** The role a Session id belongs to; `undefined` means the plugin does not manage it. */
export function agentRole(sessionId: string, masterId: string): AgentRole | undefined {
  if (sessionId === masterId) return 'orchestrator'
  if (sessionId.startsWith('lead-')) return 'lead'
  if (sessionId.startsWith('worker-')) return 'worker'
  if (sessionId.startsWith('review-')) return 'reviewer'
  if (sessionId.startsWith('diagnosis-')) return 'diagnosis'
  return undefined
}

/** The name and code of an unknown thrown value, without its message. */
export function errorIdentity(error: unknown): { name: string; code?: string; message: string; stack?: string } {
  const value = error instanceof Error ? error as Error & { code?: unknown } : undefined
  const code = value?.code
  return {
    name: typeof value?.name === 'string' && value.name !== '' ? value.name : 'Error',
    ...(code === undefined || code === null || code === '' ? {} : { code: String(code) }),
    message: typeof value?.message === 'string' ? value.message : String(error),
    ...(typeof value?.stack === 'string' ? { stack: value.stack } : {}),
  }
}

/** Collect managed Sessions' errors: a bounded public ring and one evidence file per error. */
export class AgentErrors {
  private readonly records: AgentErrorRecord[] = []
  private counter = 0
  constructor(private readonly options: { stateDir: () => string; limit?: number; keep?: number; now?: () => Date }) {}

  /** Record one error; the returned record is what the log and the up-level notice name. */
  record(input: AgentErrorInput): AgentErrorRecord {
    const at = (this.options.now ?? (() => new Date()))().toISOString()
    const identity = errorIdentity(input.error)
    this.counter += 1
    const id = `error-${this.counter}`
    const directory = join(this.options.stateDir(), 'evidence', 'agent-errors')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, `${at.replaceAll(':', '-')}-${input.role}-${id}.json`)
    writeFileSync(file, JSON.stringify({ at, role: input.role, session: input.sessionId, ticket: input.ticketId,
      project: input.project, turn: input.turn, step: input.step, name: identity.name, code: identity.code,
      message: identity.message, stack: identity.stack }, null, 2))
    const record: AgentErrorRecord = { id, at, role: input.role, sessionId: input.sessionId,
      ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      ...(input.project === undefined ? {} : { project: input.project }),
      name: identity.name, ...(identity.code === undefined ? {} : { code: identity.code }),
      ...(input.turn === undefined ? {} : { turn: input.turn }), ...(input.step === undefined ? {} : { step: input.step }),
      evidence: file }
    this.records.push(record)
    if (this.records.length > (this.options.limit ?? ERROR_LIMIT)) this.records.splice(0, this.records.length - (this.options.limit ?? ERROR_LIMIT))
    return record
  }

  list(query: AgentErrorQuery = {}): AgentErrorRecord[] {
    const limit = Math.max(1, Math.min(query.limit ?? 100, this.options.keep ?? EVIDENCE_KEEP))
    return this.records.filter(record => (query.role === undefined || record.role === query.role)
      && (query.sessionId === undefined || record.sessionId === query.sessionId)).slice(-limit)
  }
}
