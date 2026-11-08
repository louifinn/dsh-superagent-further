/** Memory application tools: what the main Session and a project Lead can remember and recall across Sessions. */
import { z } from 'zod'
import { LIMITS } from '../../limits.ts'
import { MemoryKindSchema } from '../../memory.ts'
import type { Memories } from '../memories.ts'
import { tool, type Tool } from './tool.ts'

/**
 * The memory tools: `memory_write` stores a fact, decision, preference or lesson that a later Session should know,
 * `memory_search` finds memories by keyword (optionally in one project or ticket), and `memory_forget` removes one.
 * Content is deduplicated, so writing the same memory again returns the stored one instead of adding a duplicate.
 */
export function memoryTools(memories: Memories): Tool[] {
  return [
    tool({
      name: 'memory_write',
      description: 'Remember a fact, decision, preference or lesson that a later Session should know without rediscovering it. '
        + 'Store the durable content, not the conversation around it; write the same content twice and one memory is kept.',
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
        const expiresAt = args.expires_in_days === undefined
          ? undefined : new Date(Date.now() + args.expires_in_days * 86_400_000).toISOString()
        const memory = memories.save({ text: args.text, kind: args.kind, ...args.project === undefined ? {} : { project: args.project },
          ...args.ticket === undefined ? {} : { ticket: args.ticket }, ...args.tags === undefined ? {} : { tags: args.tags },
          ...args.pinned === undefined ? {} : { pinned: args.pinned }, ...expiresAt === undefined ? {} : { expiresAt } })
        return { id: memory.id, scope: memory.scope, project: memory.project, ticket: memory.ticket, kind: memory.kind,
          pinned: memory.pinned, at: memory.at }
      },
    }),
    tool({
      name: 'memory_search',
      description: 'Find remembered facts, decisions, preferences and lessons by keyword in their text or tags, optionally '
        + 'within one project or ticket. Pinned memories come first, then the newest.',
      schema: z.object({
        query: z.string().trim().min(1),
        project: z.string().trim().min(1).max(40).optional(),
        ticket: z.string().trim().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }).strict(),
      execute: async args => ({ memories: memories.search(args.query, { ...args.project === undefined ? {} : { project: args.project },
        ...args.ticket === undefined ? {} : { ticket: args.ticket }, limit: args.limit })
        .map(memory => ({ id: memory.id, kind: memory.kind, text: memory.text, scope: memory.scope,
          ...memory.project === '' ? {} : { project: memory.project }, ...memory.ticket === '' ? {} : { ticket: memory.ticket },
          tags: memory.tags, pinned: memory.pinned, at: memory.at })) }),
    }),
    tool({
      name: 'memory_forget',
      description: 'Remove one remembered item by its id, when it is wrong, obsolete, or must not be carried into later Sessions.',
      schema: z.object({ id: z.string().trim().min(1) }).strict(),
      execute: async args => {
        if (!memories.forget(args.id)) throw new Error('No memory ' + args.id + ' is stored.')
        return { forgotten: args.id }
      },
    }),
  ]
}
