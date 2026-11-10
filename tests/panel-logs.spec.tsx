// @vitest-environment jsdom
// The Logs page: the Host log table, level and scope filters, empty state, and the missing-service error.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, field, find, mount, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const entries = [
  { at: '2026-11-10T01:00:00.000Z', level: 'info' as const, scope: 'github', message: 'polled louifinn/dsh-superagent-further' },
  { at: '2026-11-10T01:00:05.000Z', level: 'warn' as const, scope: 'feishu', message: 'slow round' },
  { at: '2026-11-10T01:00:09.000Z', level: 'error' as const, scope: 'feishu', message: 'lark-cli failed' },
]

it('shows the Host log and filters it by level and scope', async () => {
  server.logs = entries
  await mount()
  await click(tab(zh['tab.logs']))
  expect(all('[data-logs] tbody tr')).toHaveLength(3)
  expect(text()).toContain('polled louifinn/dsh-superagent-further')
  expect(text()).toContain(zh['logLevel.warn'])
  expect(text()).toContain(zh['logLevel.error'])
  // The level filter sends the route query and renders only the kept rows.
  await click(find(zh['logsLevel.error']))
  expect(all('[data-logs] tbody tr')).toHaveLength(1)
  expect(text()).toContain('lark-cli failed')
  expect(server.requests.at(-1)?.path).toContain('logs?level=error')
  // A scope narrows the query and is sent with the level filter.
  await type(field<HTMLInputElement>(zh['logsScopeLabel']), ' github ')
  expect(server.requests.at(-1)?.path).toContain('scope=github')
})

it('renders the empty log and an unmatched filter state', async () => {
  server.logs = []
  await mount()
  await click(tab(zh['tab.logs']))
  expect(text()).toContain(zh.logsEmpty)
  server.logs = entries
  await click(tab(zh['tab.logs']))
  await click(find(zh['logsLevel.error']))
  await type(field<HTMLInputElement>(zh['logsScopeLabel']), 'nothing')
  expect(text()).toContain(zh.logsNoMatch)
})
