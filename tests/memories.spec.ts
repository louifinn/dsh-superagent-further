import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../src/app/migration.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { LIMITS } from '../src/limits.ts'

let directory: string | undefined
afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

/** Opens a fresh Store in a temporary state directory. */
function open(): { store: Store; path: string } {
  directory ??= mkdtempSync(join(tmpdir(), 'memories-'))
  const path = join(directory, 'orchestrator.sqlite')
  return { store: new Store(path), path }
}

describe('Memories', () => {
  it('scopes a memory by its ticket or project, and stores the same content once', () => {
    const { store } = open()
    try {
      const global = store.memories.save({ kind: 'preference', text: 'A person prefers Chinese replies.' })
      expect(global).toMatchObject({ scope: 'global', project: '', ticket: '', pinned: false })
      const project = store.memories.save({ kind: 'fact', project: 'app', text: 'The app clone is C:/src/app.' })
      expect(project).toMatchObject({ scope: 'project', project: 'app', ticket: '' })
      // A Ticket implies its project, and the same content written twice is the stored row, not a second one.
      const ticket = store.memories.save({ kind: 'lesson', project: 'app', ticket: 'ticket-1', text: 'The migration needs a backup first.' })
      expect(ticket).toMatchObject({ scope: 'ticket', project: 'app', ticket: 'ticket-1' })
      const again = store.memories.save({ kind: 'lesson', project: 'app', ticket: 'ticket-1', text: '  The migration needs a backup first.  ' })
      expect(again.id).toBe(ticket.id)
      expect(store.memories.list()).toHaveLength(3)
    } finally { store.db.close() }
  })

  it('lists newest first and searches text or tags, pinned first and narrowed by project or ticket', () => {
    const { store } = open()
    try {
      store.memories.save({ kind: 'fact', project: 'app', text: 'Build with pnpm.' }, '2026-01-01T00:00:00.000Z')
      const tag = store.memories.save({ kind: 'lesson', project: 'app', text: 'Do not touch the vendor directory.', tags: ['migration'] }, '2026-01-02T00:00:00.000Z')
      store.memories.save({ kind: 'decision', project: 'lib', text: 'The lib project keeps its own release cadence.' }, '2026-01-03T00:00:00.000Z')
      store.memories.save({ kind: 'preference', text: 'Keep replies short.', pinned: true }, '2025-12-31T00:00:00.000Z')
      expect(store.memories.list().map(memory => memory.kind)).toEqual(['decision', 'lesson', 'fact', 'preference'])
      expect(store.memories.search('vendor').map(memory => memory.id)).toEqual([tag.id])
      expect(store.memories.search('migration').map(memory => memory.id)).toEqual([tag.id])
      expect(store.memories.search('vendor', { project: 'app' }).map(memory => memory.project)).toEqual(['app'])
      expect(store.memories.search('release', { project: 'lib' }).map(memory => memory.project)).toEqual(['lib'])
      expect(store.memories.search('release', { project: 'app' })).toEqual([])
      // The pinned preference comes first whatever its date, so a person's standing preference is not buried.
      expect(store.memories.search('replies')[0]).toMatchObject({ kind: 'preference', pinned: true })
    } finally { store.db.close() }
  })

  it('browses by keyword and order, keeps pinned rows first, and counts matches', () => {
    const { store } = open()
    try {
      const lib = store.memories.save({ kind: 'fact', project: 'lib', text: 'Vendor builds are slow.' }, '2026-01-01T00:00:00.000Z')
      const app = store.memories.save({ kind: 'lesson', project: 'app', text: 'The vendor migration needs a backup.', tags: ['migration'] }, '2026-01-02T00:00:00.000Z')
      const global = store.memories.save({ kind: 'decision', text: 'Keep releases weekly.' }, '2026-01-03T00:00:00.000Z')
      expect(store.memories.browse().map(memory => memory.id)).toEqual([global.id, app.id, lib.id])
      expect(store.memories.browse({ sort: 'oldest' }).map(memory => memory.id)).toEqual([lib.id, app.id, global.id])
      expect(store.memories.browse({ sort: 'kind' }).map(memory => memory.kind)).toEqual(['decision', 'fact', 'lesson'])
      expect(store.memories.browse({ sort: 'project' }).map(memory => memory.project)).toEqual(['', 'app', 'lib'])
      // A pinned row leads every order, because pinning is how a person keeps a fact in view.
      expect(store.memories.setPinned(lib.id, true)).toMatchObject({ id: lib.id, pinned: true })
      expect(store.memories.browse({ sort: 'oldest' }).map(memory => memory.id)).toEqual([lib.id, app.id, global.id])
      expect(store.memories.browse({ sort: 'newest' }).map(memory => memory.id)).toEqual([lib.id, global.id, app.id])
      expect(store.memories.browse({ query: 'vendor' }).map(memory => memory.id)).toEqual([lib.id, app.id])
      expect(store.memories.browse({ query: 'migration' }).map(memory => memory.id)).toEqual([app.id])
      expect(store.memories.countMatching('vendor')).toBe(2)
      expect(store.memories.countMatching('')).toBe(3)
      expect(store.memories.setPinned(app.id, false)).toMatchObject({ id: app.id, pinned: false })
      expect(store.memories.setPinned('missing', true)).toBeUndefined()
    } finally { store.db.close() }
  })

  it('forgets one memory, removes expired ones, and keeps the schema current', () => {
    const { store, path } = open()
    try {
      const expired = store.memories.save({ kind: 'fact', text: 'This expires.', expiresAt: '2027-01-01T00:00:00.000Z' })
      const kept = store.memories.save({ kind: 'fact', text: 'This stays.' })
      expect(store.memories.prune(new Date('2028-01-01T00:00:00.000Z'))).toBe(1)
      expect(store.memories.get(expired.id)).toBeUndefined()
      expect(store.memories.forget(kept.id)).toBe(true)
      expect(store.memories.forget(kept.id)).toBe(false)
      expect(store.memories.list()).toEqual([])
      expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
    } finally { store.db.close() }
    // A reopened database keeps its memories and reads the current schema.
    const again = new Store(path)
    try {
      again.memories.save({ kind: 'fact', text: 'Survives a restart.' })
      expect(again.memories.list()).toHaveLength(1)
    } finally { again.db.close() }
  })

  it('renders the runtime-context snapshot of pinned and recent memories within its character budget', () => {
    const { store } = open()
    try {
      expect(store.memories.promptText()).toBe('')
      store.memories.save({ kind: 'preference', text: 'Answer in Chinese unless the request is English.', pinned: true }, '2025-01-01T00:00:00.000Z')
      store.memories.save({ kind: 'decision', ticket: 'ticket-1', text: 'The app Tickets run under the lead-app Session.' }, '2026-01-01T00:00:00.000Z')
      const text = store.memories.promptText()
      expect(text).toContain('## Memory')
      expect(text).toContain('Answer in Chinese')
      expect(text).toContain('ticket ticket-1')
      expect(text).toContain('the lead-app Session')
      // The snapshot never exceeds its budget: a long memory is left out rather than blowing the prompt up.
      store.memories.save({ kind: 'fact', text: 'x'.repeat(LIMITS.memoryText) })
      expect(store.memories.promptText().length).toBeLessThanOrEqual(LIMITS.memoryPromptChars)
    } finally { store.db.close() }
  })

  it('shows a project only its own memories, never the installation-wide or another project\'s ones', () => {
    const { store } = open()
    try {
      const app = store.memories.save({ kind: 'fact', project: 'app', text: 'The app builds with pnpm.' }, '2026-01-02T00:00:00.000Z')
      store.memories.save({ kind: 'fact', project: 'lib', text: 'The lib builds with cargo.' }, '2026-01-03T00:00:00.000Z')
      store.memories.save({ kind: 'preference', text: 'Keep replies short.', pinned: true }, '2026-01-01T00:00:00.000Z')
      // A project Lead's snapshot carries only its own project's memories; the installation-wide preference and the
      // other project's fact stay out, while the Orchestrator's own snapshot still spans everything.
      expect(store.memories.promptText('app')).toContain('The app builds with pnpm.')
      expect(store.memories.promptText('app')).not.toContain('Keep replies short.')
      expect(store.memories.promptText('app')).not.toContain('The lib builds with cargo.')
      expect(store.memories.promptText('lib')).toContain('The lib builds with cargo.')
      const all = store.memories.promptText()
      expect(all).toContain('The app builds with pnpm.')
      expect(all).toContain('The lib builds with cargo.')
      expect(all).toContain('Keep replies short.')
      // The Lead's strict search stays inside its project; the Orchestrator's still spans the installation (newest first).
      expect(store.memories.searchFor('app', 'builds').map(memory => memory.id)).toEqual([app.id])
      expect(store.memories.searchFor('app', 'short')).toEqual([])
      expect(store.memories.search('builds').map(memory => memory.project)).toEqual(['lib', 'app'])
    } finally { store.db.close() }
  })

  it('honors the panel switches for injection, searching and writing', () => {
    const { store } = open()
    try {
      store.memories.save({ kind: 'fact', text: 'A stored fact.' }, '2026-01-01T00:00:00.000Z')
      const configure = (patch: { enabled?: boolean; inject?: boolean }) => {
        const settings = store.settings()
        store.saveSettings({ ...settings, memory: { ...settings.memory, ...patch } })
      }
      // Injection off silences only the snapshot: a model can still ask with memory_search.
      configure({ inject: false })
      expect(store.memories.promptText()).toBe('')
      expect(store.memories.search('stored')).toHaveLength(1)
      // The master switch also refuses writes and searches, and keeps the stored rows.
      configure({ enabled: false })
      expect(store.memories.promptText()).toBe('')
      expect(() => store.memories.save({ kind: 'fact', text: 'Another fact.' })).toThrow(/turned off/)
      expect(() => store.memories.search('stored')).toThrow(/turned off/)
      expect(store.memories.list()).toHaveLength(1)
      // Turning it back on restores injection without a restart.
      configure({ enabled: true, inject: true })
      expect(store.memories.promptText()).toContain('A stored fact.')
    } finally { store.db.close() }
  })

  it('applies the configured snapshot limits and ages out only automatic records', () => {
    const { store } = open()
    try {
      const manual = store.memories.save({ kind: 'fact', text: 'A hand-written fact.' }, '2020-01-01T00:00:00.000Z')
      const pinned = store.memories.save({ kind: 'preference', text: 'Stay short.', pinned: true }, '2020-01-02T00:00:00.000Z')
      const automatic = store.memories.save({ kind: 'decision', ticket: 't1', text: 'Automatic record.',
        source: { ticket: 't1' } }, new Date().toISOString())
      const settings = store.settings()
      store.saveSettings({ ...settings, memory: { ...settings.memory, pinnedLimit: 1, recentLimit: 0, promptChars: 1200 } })
      const limited = store.memories.promptText()
      expect(limited).toContain('Stay short.')
      expect(limited).not.toContain('A hand-written fact.')
      // Retention removes the automatic record, but a memory a person wrote on purpose stays until it expires.
      store.saveSettings({ ...store.settings(), memory: { ...store.settings().memory, retentionDays: 7 } })
      const later = new Date(Date.now() + 40 * 86_400_000)
      expect(store.memories.prune(later)).toBe(1)
      expect(store.memories.get(automatic.id)).toBeUndefined()
      expect(store.memories.get(manual.id)).toBeDefined()
      expect(store.memories.get(pinned.id)).toBeDefined()
    } finally { store.db.close() }
  })
})
