/** The Memory page's view: what is stored, how much of it, and the behavior the panel's controls edit. */
import type { Memory } from '../../memory.ts'
import type { MemoryConfig } from '../../policy.ts'
import type { Store } from '../store.ts'

/** One stored memory as the panel shows it; the hash and internal source links stay on the host. */
export interface MemoryView {
  id: string
  scope: Memory['scope']
  project: string
  ticket: string
  kind: Memory['kind']
  text: string
  tags: string[]
  pinned: boolean
  at: string
  expiresAt?: string
}

export interface MemoriesView {
  items: MemoryView[]
  total: number
  pinned: number
  config: MemoryConfig
}

/** Build the Memory page view: the newest `limit` rows, the totals, and the settings the page's controls edit. */
export function memoriesView(store: Store, limit = 50): MemoriesView {
  const items = store.memories.list(limit).map(({ id, scope, project, ticket, kind, text, tags, pinned, at, expiresAt }) => ({
    id, scope, project, ticket, kind, text, tags, pinned, at, ...expiresAt === undefined ? {} : { expiresAt },
  }))
  return { items, total: store.memories.total(), pinned: store.memories.pinnedTotal(), config: store.settings().memory }
}
