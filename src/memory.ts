import { z } from 'zod'
import { key } from './core/ids.ts'
import { LIMITS } from './limits.ts'

/** What a memory is: a fact, a decision, a preference or a lesson. */
export const MemoryKindSchema = z.enum(['fact', 'decision', 'preference', 'lesson'])
export type MemoryKind = z.infer<typeof MemoryKindSchema>

/** Where a memory applies: the whole installation, one project, or one ticket (which implies its project). */
export const MemoryScopeSchema = z.enum(['global', 'project', 'ticket'])
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

/** How the Memory page orders stored rows: the pinned ones always come first, then this order. */
export const MEMORY_SORTS = ['newest', 'oldest', 'kind', 'project'] as const
export type MemorySort = typeof MEMORY_SORTS[number]

/** Where a memory came from: the Trigger, Ticket, Request or Session it was learned in, as far as it is known. */
export const MemorySourceSchema = z.object({
  trigger: z.string().trim().min(1).optional(),
  ticket: z.string().trim().min(1).optional(),
  request: z.string().trim().min(1).optional(),
  session: z.string().trim().min(1).optional(),
}).strict()
export type MemorySource = z.infer<typeof MemorySourceSchema>

/** A stored memory. It is recalled through a tool and, when pinned or recent, through the main Session's prompt section. */
export const MemorySchema = z.object({
  id: z.string(),
  scope: MemoryScopeSchema,
  project: z.string().default(''),
  ticket: z.string().default(''),
  kind: MemoryKindSchema,
  text: z.string().trim().min(1).max(LIMITS.memoryText),
  tags: z.array(z.string().trim().min(1).max(LIMITS.memoryTag)).max(LIMITS.memoryTags).default([]),
  source: MemorySourceSchema.default({}),
  pinned: z.boolean().default(false),
  at: z.string(),
  expiresAt: z.string().optional(),
  hash: z.string(),
}).strict()
export type Memory = z.infer<typeof MemorySchema>

/** What a caller supplies to store a memory; the scope follows from the ticket and project named. */
export const MemoryInputSchema = z.object({
  project: z.string().trim().min(1).max(40).optional(),
  ticket: z.string().trim().min(1).max(64).optional(),
  kind: MemoryKindSchema,
  text: z.string().trim().min(1).max(LIMITS.memoryText),
  tags: z.array(z.string().trim().min(1).max(LIMITS.memoryTag)).max(LIMITS.memoryTags).optional(),
  source: MemorySourceSchema.optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.string().optional(),
}).strict()
export type MemoryInput = z.infer<typeof MemoryInputSchema>

/** The scope a memory with this ticket and project applies to. */
export function memoryScope(input: Pick<MemoryInput, 'project' | 'ticket'>): MemoryScope {
  return input.ticket ? 'ticket' : input.project ? 'project' : 'global'
}

/** The identity of a memory's content: two writes of the same content in the same scope store one row. */
export function memoryHash(input: Pick<MemoryInput, 'project' | 'ticket' | 'kind' | 'text'>): string {
  return key('memory', memoryScope(input), input.project ?? '', input.ticket ?? '', input.kind, input.text.trim())
}

/** The id a memory with this hash is stored under. */
export function memoryId(hash: string): string {
  return key('memory-id', hash)
}
