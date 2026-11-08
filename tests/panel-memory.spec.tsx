// @vitest-environment jsdom
// The Memory page: switches save the block immediately, limits save through the form, and stored rows can be forgotten.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, field, mount, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const switches = () => all('[role="switch"]')

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

it('saves the snapshot limits and forgets a stored memory', async () => {
  server.memories = [{ id: 'm1', scope: 'global', project: '', ticket: '', kind: 'fact', text: 'The panel remembers this.',
    tags: [], pinned: true, at: '2026-01-01T00:00:00.000Z' }]
  await mount()
  await click(tab(zh['tab.memory']))
  expect(text()).toContain('The panel remembers this.')
  await type(field<HTMLInputElement>(zh.memoryPinnedLimit), '5')
  await type(field<HTMLInputElement>(zh.memoryRecentLimit), '3')
  await type(field<HTMLInputElement>(zh.memoryPromptChars), '600')
  await type(field<HTMLInputElement>(zh.memoryRetentionDays), '14')
  await click(zh.save)
  expect(server.settings.memory).toMatchObject({ pinnedLimit: 5, recentLimit: 3, promptChars: 600, retentionDays: 14 })
  await click(zh.memoryForget)
  expect(server.memories).toEqual([])
  expect(text()).toContain(zh.memoryEmpty)
})
