/**
 * Explicit same-need marks between Requests (issue #32, decision 8 of ADR-0009): a Request carries its group on
 * `Request.correlation`, and schema 26's `request_link` keeps one auditable row per Request of a group. The mark is an
 * operator decision — nothing here compares titles or text.
 */
import type { Request } from './model.ts'

/** One auditable link row: the group it belongs to, the Request it links, and who marked it. */
export interface RequestLink {
  id: string
  group: string
  request: string
  at: string
  by: 'orchestrator' | 'human'
  note?: string
}

/** The durable links of a schema 26 Store. */
export interface RequestLinksRepository {
  save(link: RequestLink): void
  /** The Request ids of one group, oldest link first. */
  byGroup(group: string): string[]
  /** The group a Request belongs to, if any. */
  groupOf(request: string): string | undefined
}

/** The stored Requests of one group, in the order they were linked. */
export function correlationMembers(requests: readonly Request[], group: string): Request[] {
  return requests.filter(request => request.correlation?.group === group)
}
