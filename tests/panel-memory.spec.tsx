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
  // Pre-injection is off by default, so the second switch starts off; enabling it writes the whole block.
  expect(switches().map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true'])
  await click(switches()[1]!)
  expect(server.settings.memory.inject).toBe(true)
  expect(switches()[1]!.getAttribute('aria-checked')).toBe('true')
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/memory'])
  await click(switches()[2]!)
  expect(server.settings.memory).toMatchObject({ inject: true, autoWrite: false })
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
  // The order is a combo box; changing it refetches, and the pinned memory stays first.
  await type(field<HTMLSelectElement>(zh.memorySortLabel), 'oldest')
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

it('filters by project, and pages through the list', async () => {
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  server.memories = Array.from({ length: 25 }, (_, index) => memory(`p${index + 1}`, {
    project: index % 5 === 0 ? 'app' : '',
    text: `Note ${index + 1}`,
    at: new Date(start + index * 86_400_000).toISOString(),
  }))
  // The project filter lists the registered projects, so the fixture needs one before the page mounts.
  server.settings = { ...server.settings, executor: { ...server.settings.executor,
    projects: [{ id: 'app', name: 'App', workspace: '/srv/app', repository: 'acme/app', branch: '' }] } }
  await mount()
  await click(tab(zh['tab.memory']))
  // One page holds 20 rows; the range names the window and the page.
  expect(cards()).toHaveLength(20)
  expect(titles()[0]).toBe('Note 25')
  expect(text()).toContain('第 1–20 条，共 25 条（第 1/2 页）')
  await click(find(zh.memoryPageNext))
  expect(cards()).toHaveLength(5)
  expect(titles()[0]).toBe('Note 5')
  expect(text()).toContain('第 21–25 条，共 25 条（第 2/2 页）')
  expect(server.requests.some(request => request.path.includes('offset=20'))).toBe(true)
  // The project combo box narrows the rows on the host and starts again at the first page.
  await type(field<HTMLSelectElement>(zh.memoryProjectFilterLabel), 'app')
  expect(server.requests.some(request => request.path.includes('project=app') && request.path.includes('offset=0'))).toBe(true)
  expect(cards()).toHaveLength(5)
  expect(titles()[0]).toBe('Note 21')
  await type(field<HTMLSelectElement>(zh.memoryProjectFilterLabel), '-')
  expect(cards()).toHaveLength(20)
  expect(titles()[0]).toBe('Note 25')
  expect(text()).toContain('第 1–20 条，共 20 条（第 1/1 页）')
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
