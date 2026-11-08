// @vitest-environment jsdom
// The Memory page: switches save the block immediately, the list searches and orders, and each card expands to everything stored.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, field, find, mount, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const switches = () => all('[role="switch"]')
const cards = () => all('[data-memory] [data-disclosure-row]')
const titles = () => all('[data-memory] .dt-disclosure-title').map(item => item.textContent)
const memory = (id: string, over: Record<string, unknown> = {}) => ({
  id, scope: 'global' as const, project: '', ticket: '', kind: 'fact' as const, text: `Memory ${id}`, tags: [], source: {},
  pinned: false, at: '2026-01-01T00:00:00.000Z', ...over,
})

it('saves each switch on click, against the current revision', async () => {
  await mount()
  await click(tab(zh['tab.memory']))
  expect(switches().map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true'])
  // A switch writes the whole block straight away: the next model request sees the new behavior without a restart.
  await click(switches()[1]!)
  expect(server.settings.memory.inject).toBe(false)
  expect(switches()[1]!.getAttribute('aria-checked')).toBe('false')
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/memory'])
  await click(switches()[2]!)
  expect(server.settings.memory).toMatchObject({ inject: false, autoWrite: false })
  await click(switches()[0]!)
  expect(server.settings.memory.enabled).toBe(false)
})

it('searches, orders, pins and expands the stored memories', async () => {
  server.memories = [
    memory('m3', { text: 'Oldest note', project: 'lib', at: '2026-01-01T00:00:00.000Z' }),
    memory('m1', { text: 'First line\nSecond line detail', kind: 'decision', tags: ['alpha'], ticket: 'ticket-1234',
      source: { ticket: 'ticket-1234' }, at: '2026-01-02T00:00:00.000Z' }),
    memory('m2', { text: 'A preference about linting', pinned: true, project: 'app', at: '2026-01-03T00:00:00.000Z' }),
  ]
  await mount()
  await click(tab(zh['tab.memory']))
  // The pinned memory leads, then the newest.
  expect(titles()).toEqual(['A preference about linting', 'First line', 'Oldest note'])
  // The keyword field narrows the list and reaches the host with the page's query.
  await type(field<HTMLInputElement>(zh.memorySearchLabel), 'second line')
  expect(server.requests.some(request => request.path.includes('q=second'))).toBe(true)
  expect(titles()).toEqual(['First line'])
  expect(text()).toContain(zh.memorySearchHint.replace('{matched}', '1').replace('{total}', '3'))
  await type(field<HTMLInputElement>(zh.memorySearchLabel), '')
  // The order buttons refetch with the chosen order; the pinned memory stays first.
  await click(tab(zh.memorySortOldest))
  expect(server.requests.some(request => request.path.includes('sort=oldest'))).toBe(true)
  expect(titles()).toEqual(['A preference about linting', 'Oldest note', 'First line'])
  // Expanding shows everything stored, including the full text, tags, source and id.
  await click(cards()[2]!)
  expect(text()).toContain('Second line detail')
  expect(text()).toContain('alpha')
  expect(text()).toContain('ticket-1234')
  expect(text()).toContain('m1')
  // Pinning saves at once; forgetting removes the expanded row.
  await click(find(zh.memoryPin))
  expect(server.memories.find(item => item.id === 'm1')!.pinned).toBe(true)
  await click(find(zh.memoryForget))
  expect(server.memories.map(item => item.id)).toEqual(['m3', 'm2'])
})

it('saves the snapshot limits and forgets a stored memory', async () => {
  server.memories = [memory('m1', { text: 'The panel remembers this.', pinned: true })]
  await mount()
  await click(tab(zh['tab.memory']))
  expect(text()).toContain('The panel remembers this.')
  await type(field<HTMLInputElement>(zh.memoryPinnedLimit), '5')
  await type(field<HTMLInputElement>(zh.memoryRecentLimit), '3')
  await type(field<HTMLInputElement>(zh.memoryPromptChars), '600')
  await type(field<HTMLInputElement>(zh.memoryRetentionDays), '14')
  await click(zh.save)
  expect(server.settings.memory).toMatchObject({ pinnedLimit: 5, recentLimit: 3, promptChars: 600, retentionDays: 14 })
  await click(cards()[0]!)
  await click(find(zh.memoryForget))
  expect(server.memories).toEqual([])
  expect(text()).toContain(zh.memoryEmpty)
})
