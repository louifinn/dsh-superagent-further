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
  /** How many of the stored memories match the page's keyword. */
  matched: number
  pinned: number
  config: MemoryConfig
}

/** How the page reads its list: a keyword, an order and a page size. */
export interface MemoriesOptions {
  query?: string
  sort?: MemorySort
  limit?: number
}

/** Build the Memory page view: the page's rows, the totals, and the settings the page's controls edit. */
export function memoriesView(store: Store, options: MemoriesOptions = {}): MemoriesView {
  const items = store.memories.browse(options).map(({ id, scope, project, ticket, kind, text, tags, source, pinned, at, expiresAt }) => ({
    id, scope, project, ticket, kind, text, tags, source, pinned, at, ...expiresAt === undefined ? {} : { expiresAt },
  }))
  return {
    items,
    total: store.memories.total(),
    matched: store.memories.countMatching(options.query ?? ''),
    pinned: store.memories.pinnedTotal(),
    config: store.settings().memory,
  }
}
