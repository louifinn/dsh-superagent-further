/** The Memory page's view: what is stored, how much of it, and the behavior the panel's controls edit. */
import type { Memory, MemorySort } from '../../memory.ts'
import type { MemoryConfig } from '../../policy.ts'
import type { Store } from '../store.ts'

/** One stored memory as the panel shows it; the hash stays on the host. */
export interface MemoryView {
  id: string
  scope: Memory['scope']
  project: string
  ticket: string
  kind: Memory['kind']
  text: string
  tags: string[]
  source: Memory['source']
  pinned: boolean
  at: string
  expiresAt?: string
}

export interface MemoriesView {
  items: MemoryView[]
  /** How many memories are stored in total. */
  total: number
  /** How many of the stored memories match the page's keyword and project filter. */
  matched: number
  pinned: number
  /** The first row's position and the page size, so the page can draw its pages. */
  offset: number
  limit: number
  config: MemoryConfig
}

/** How the page reads its list: a keyword, a project, an order and a page. */
export interface MemoriesOptions {
  query?: string
  project?: string
  sort?: MemorySort
  limit?: number
  offset?: number
}

/** Build the Memory page view: the page's rows, the totals, and the settings the page's controls edit. */
export function memoriesView(store: Store, options: MemoriesOptions = {}): MemoriesView {
  const limit = options.limit ?? 20
  const offset = Math.max(options.offset ?? 0, 0)
  const items = store.memories.browse({ ...options, limit, offset }).map(({ id, scope, project, ticket, kind, text, tags, source, pinned, at, expiresAt }) => ({
    id, scope, project, ticket, kind, text, tags, source, pinned, at, ...expiresAt === undefined ? {} : { expiresAt },
  }))
  return {
    items,
    total: store.memories.total(),
    matched: store.memories.countMatching(options.query ?? '', options.project ?? ''),
    pinned: store.memories.pinnedTotal(),
    offset,
    limit,
    config: store.settings().memory,
  }
}
