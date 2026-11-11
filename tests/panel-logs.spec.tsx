// @vitest-environment jsdom
// The Logs page: the Host log table, filters, keyword search, copy and JSONL download, load-more, and deep links.
import { afterEach, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, at, click, field, find, mount, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const entries = [
  { at: '2026-11-10T01:00:00.000Z', level: 'info' as const, scope: 'github', message: 'polled louifinn/dsh-superagent-further' },
  { at: '2026-11-10T01:00:05.000Z', level: 'warn' as const, scope: 'feishu', message: 'slow round' },
  { at: '2026-11-10T01:00:09.000Z', level: 'error' as const, scope: 'feishu', message: 'lark-cli failed' },
]
const logsPath = () => server.requests.filter(request => request.path.startsWith('logs')).at(-1)?.path
const query = (path: string | undefined) => new URL(path ?? '', 'http://panel.test').searchParams.get('q')
const json = (text: string) => text.trimEnd().split('\n').map(line => JSON.parse(line) as unknown)

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
  vi.restoreAllMocks()
})

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

it('searches every log field with q and separates no matches from an empty log', async () => {
  server.logs = entries
  await mount()
  await click(tab(zh['tab.logs']))
  await type(field<HTMLInputElement>(zh['logsSearchLabel']), 'LARK')
  expect(query(logsPath())).toBe('LARK')
  expect(all('[data-logs] tbody tr')).toHaveLength(1)
  expect(text()).toContain('lark-cli failed')
  await type(field<HTMLInputElement>(zh['logsSearchLabel']), 'nothing matches')
  expect(all('[data-logs] tbody tr')).toHaveLength(0)
  expect(text()).toContain(zh.logsNoMatch)
})

it('copies the filtered view as JSONL', async () => {
  const written: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: { writeText: async (value: string) => { written.push(value) } } })
  server.logs = entries
  await mount()
  await click(tab(zh['tab.logs']))
  await click(find(zh['logsCopy']))
  await vi.waitFor(() => expect(written).toHaveLength(1))
  expect(json(written[0]!)).toEqual(entries)
  expect(text()).toContain(zh.logsCopied)
})

it('downloads the filtered view as a JSONL Blob without a server route', async () => {
  const blobs: Blob[] = []
  Object.defineProperty(URL, 'createObjectURL', { configurable: true,
    value: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:logs' }) })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  server.logs = entries
  await mount()
  await click(tab(zh['tab.logs']))
  await click(find(zh['logsDownload']))
  await vi.waitFor(() => expect(blobs).toHaveLength(1))
  expect(json(await blobs[0]!.text())).toEqual(entries)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:logs')
  expect(download).toHaveBeenCalledOnce()
  const anchor = download.mock.instances[0] as unknown as HTMLAnchorElement
  expect(anchor.download).toMatch(/^logs-.*\.jsonl$/)
})

it('loads older rows in pages of 200 up to the 2000-entry ring', async () => {
  server.logs = Array.from({ length: 250 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 10, 10, 0, 0, index)).toISOString(), level: 'info' as const, scope: 'github', message: `entry ${index}`,
  }))
  await mount()
  await click(tab(zh['tab.logs']))
  expect(all('[data-logs] tbody tr')).toHaveLength(200)
  expect(logsPath()).toContain('limit=200')
  expect(text()).toContain(zh.logsMore)
  await click(find(zh['logsMore']))
  expect(logsPath()).toContain('limit=400')
  expect(all('[data-logs] tbody tr')).toHaveLength(250)
  expect(text()).not.toContain(zh.logsMore)
})

it('prefills the search from a Logs deep link', async () => {
  server.logs = entries
  at({ page: 'logs', query: { q: 'ticket=t1' } })
  await mount()
  expect(field<HTMLInputElement>(zh['logsSearchLabel']).value).toBe('ticket=t1')
  expect(query(logsPath())).toBe('ticket=t1')
})

it('links a Ticket to the Logs page filtered by that Ticket', async () => {
  server.logs = entries
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(find(zh['logsForTicket']))
  expect(query(logsPath())).toBe('ticket=t1')
  expect(field<HTMLInputElement>(zh['logsSearchLabel']).value).toBe('ticket=t1')
})

it('links a Request card to the Logs page filtered by that Request', async () => {
  server.logs = entries
  server.asks = [{ id: 'req-1', title: '跨项目请求', createdAt: '2026-11-10T00:00:00.000Z', tickets: [] }]
  at({ page: 'overview' })
  await mount()
  await click(find(zh['logsForRequest']))
  expect(query(logsPath())).toBe('request=req-1')
})

it('links an Assignment to the Logs page filtered by that Assignment', async () => {
  server.logs = entries
  const detail = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...detail, assignments: [
    { id: 'a2', state: 'ended', createdAt: '2026-09-22T00:00:00Z', startedAt: '2026-09-22T00:01:00Z',
      report: { state: 'ready', summary: 'finished', at: '2026-09-22T00:02:00Z' } },
    ...detail.assignments,
  ] }
  at({ page: 'execution', id: 't1' })
  await mount()
  const link = document.querySelector<HTMLElement>('[data-assignment-logs="a2"]')
  expect(link).not.toBeNull()
  await click(link!)
  expect(query(logsPath())).toBe('assignment=a2')
})
