/** Memory application tools: what the main Session and a project Lead can remember and recall across Sessions. */
import { z } from 'zod'
import { LIMITS } from '../../limits.ts'
import { MemoryKindSchema } from '../../memory.ts'
import type { Memories } from '../memories.ts'
import { tool, type Tool } from './tool.ts'

/**
 * The scope a project Lead's memory tools act in. A Lead remembers its own project only: writes are stamped with that
 * project, ticket references must belong to it, searches cannot reach another project's or installation-wide memories,
 * and only memories of the project can be forgotten. The Orchestrator passes no scope and keeps the whole instrument.
 */
export interface MemoryToolScope {
  project: string
  /** Resolves a Ticket, so a memory cannot be filed against another project's work. */
  ticketOf: (id: string) => { project?: string } | undefined
}

/**
 * The memory tools: `memory_write` stores a fact, decision, preference or lesson that a later Session should know,
 * `memory_search` finds memories by keyword, and `memory_forget` removes one. Content is deduplicated, so writing the
 * same memory again returns the stored one instead of adding a duplicate.
 */
export function memoryTools(memories: Memories, scope?: MemoryToolScope): Tool[] {
  const projectFor = (requested: string | undefined): string | undefined => {
    if (scope === undefined) return requested
    if (requested !== undefined && requested !== scope.project) {
      throw new Error(`A project Lead can only remember project ${scope.project}, not ${requested}.`)
    }
    return scope.project
  }
  const scopeHint = scope === undefined ? ''
    : ` This Session belongs to project ${scope.project}, so the memory is kept for that project only.`
  return [
    tool({
      name: 'memory_write',
      description: 'Remember a fact, decision, preference or lesson that a later Session should know without rediscovering it. '
        + 'Store the durable content, not the conversation around it; write the same content twice and one memory is kept.'
        + scopeHint,
      schema: z.object({
        text: z.string().trim().min(1).max(LIMITS.memoryText),
        kind: MemoryKindSchema.default('fact'),
        project: z.string().trim().min(1).max(40).optional(),
        ticket: z.string().trim().min(1).max(64).optional(),
        tags: z.array(z.string().trim().min(1).max(LIMITS.memoryTag)).max(LIMITS.memoryTags).optional(),
        pinned: z.boolean().optional(),
        expires_in_days: z.number().int().min(1).max(LIMITS.memoryKeepDays.max).optional(),
      }).strict(),
      execute: async args => {
        const project = projectFor(args.project)
        if (scope !== undefined && args.ticket !== undefined) {
          const ticket = scope.ticketOf(args.ticket)
          if (ticket === undefined || ticket.project !== scope.project) {
            throw new Error(`Ticket ${args.ticket} is not in project ${scope.project}.`)
          }
        }
        const expiresAt = args.expires_in_days === undefined
          ? undefined : new Date(Date.now() + args.expires_in_days * 86_400_000).toISOString()
        const memory = memories.save({ text: args.text, kind: args.kind, ...project === undefined ? {} : { project },
          ...args.ticket === undefined ? {} : { ticket: args.ticket }, ...args.tags === undefined ? {} : { tags: args.tags },
          ...args.pinned === undefined ? {} : { pinned: args.pinned }, ...expiresAt === undefined ? {} : { expiresAt } })
        return { id: memory.id, scope: memory.scope, project: memory.project, ticket: memory.ticket, kind: memory.kind,
          pinned: memory.pinned, at: memory.at }
      },
    }),
    tool({
      name: 'memory_search',
      description: 'Find remembered facts, decisions, preferences and lessons by keyword in their text or tags, optionally '
        + 'within one project or ticket. Pinned memories come first, then the newest.'
        + (scope === undefined ? '' : ` Only memories of project ${scope.project} are visible here.`),
      schema: z.object({
        query: z.string().trim().min(1),
        project: z.string().trim().min(1).max(40).optional(),
        ticket: z.string().trim().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }).strict(),
      execute: async args => {
        projectFor(args.project)
        const found = scope === undefined
          ? memories.search(args.query, { ...args.project === undefined ? {} : { project: args.project },
            ...args.ticket === undefined ? {} : { ticket: args.ticket }, limit: args.limit })
          : memories.searchFor(scope.project, args.query, { ...args.ticket === undefined ? {} : { ticket: args.ticket },
            limit: args.limit })
        return { memories: found.map(memory => ({ id: memory.id, kind: memory.kind, text: memory.text, scope: memory.scope,
          ...memory.project === '' ? {} : { project: memory.project }, ...memory.ticket === '' ? {} : { ticket: memory.ticket },
          tags: memory.tags, pinned: memory.pinned, at: memory.at })) }
      },
    }),
    tool({
      name: 'memory_forget',
      description: 'Remove one remembered item by its id, when it is wrong, obsolete, or must not be carried into later Sessions.'
        + (scope === undefined ? '' : ` Only a memory of project ${scope.project} can be removed here.`),
      schema: z.object({ id: z.string().trim().min(1) }).strict(),
      execute: async args => {
        if (scope !== undefined) {
          const memory = memories.get(args.id)
          if (memory === undefined || memory.project !== scope.project) {
            throw new Error(`No memory ${args.id} is stored for project ${scope.project}.`)
          }
        }
        if (!memories.forget(args.id)) throw new Error('No memory ' + args.id + ' is stored.')
        return { forgotten: args.id }
      },
    }),
  ]
}
