/** The Logs page: the Host's bounded operational log, filterable by level and scope, searchable, and exportable. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Input, SegmentedControl, Tag, type TagTone } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { when } from './text.ts'
import { Hint, LoadMore, LoadState, Section } from './widgets.tsx'

type LogsView = ApiResponse<'GET logs'>
type Entry = LogsView['entries'][number]
type LevelFilter = LogsView['level']

const FILTERS = ['all', 'warn', 'error'] as const
/** The page size, matching the Host ring's default, and the ring's upper bound the load-more button stops at. */
const PAGE = 200
const RING = 2000

/** The tag tone of one log level; debug entries read as quiet metadata. */
const tone = (level: Entry['level']): TagTone => level === 'error' ? 'danger' : level === 'warn' ? 'warning'
  : level === 'info' ? 'info' : 'quiet'
/** The localized label of one stored log level. */
const levelText = (level: Entry['level'], t: ReturnType<typeof usePanel>['t']): string =>
  level === 'error' ? t('logLevel.error') : level === 'warn' ? t('logLevel.warn') : level === 'info' ? t('logLevel.info') : t('logLevel.debug')
/** One JSONL line per entry, with the same fields as the durable file, so an exported view can be replayed as a file. */
function jsonl(entries: readonly Entry[]): string {
  return entries.map(entry => JSON.stringify({ at: entry.at, level: entry.level, scope: entry.scope, message: entry.message,
    ...entry.data === undefined ? {} : { data: entry.data } })).join('\n') + (entries.length ? '\n' : '')
}
/** Download the current view as a JSONL file; the export is generated in the page, so no Host route serves files. */
function download(entries: readonly Entry[]): void {
  const url = URL.createObjectURL(new Blob([jsonl(entries)], { type: 'application/x-ndjson' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `logs-${new Date().toISOString().replaceAll(':', '-')}.jsonl`
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function LogsPage({ query }: { query?: { q?: string } }) {
  const { t, call } = usePanel()
  const [level, setLevel] = useState<LevelFilter>('all')
  const [scope, setScope] = useState('')
  // A deep link from a Ticket, Request or Assignment prefills the keyword, e.g. `ticket=t1`.
  const [search, setSearch] = useState(query?.q ?? '')
  const [limit, setLimit] = useState(PAGE)
  const [copied, setCopied] = useState(false)
  const trimmed = scope.trim()
  const needle = search.trim()
  const { data, error } = usePoll(() => call('GET logs',
    { query: { level, scope: trimmed || undefined, q: needle || undefined, limit } }), [level, trimmed, needle, limit])
  const entries = data?.entries ?? []
  const more = data !== undefined && entries.length >= limit && limit < RING
  const filtering = level !== 'all' || !!trimmed || !!needle
  const copy = (): void => {
    navigator.clipboard.writeText(jsonl(entries)).then(() => setCopied(true), () => setCopied(false))
  }
  return <Section title={t('logsTitle')} hint={t('logsHint')}>
    <div className="dt-logs-toolbar">
      <SegmentedControl label={t('logsLevelLabel')} value={level}
        onChange={next => { setLevel(next); setLimit(PAGE) }}
        options={FILTERS.map(filter => ({ value: filter, label: filter === 'all' ? t('logsLevel.all')
          : filter === 'warn' ? t('logsLevel.warn') : t('logsLevel.error') }))} />
      <Input type="search" value={scope} placeholder={t('logsScopePlaceholder')} aria-label={t('logsScopeLabel')}
        onChange={event => { setScope(event.target.value); setLimit(PAGE) }} />
      <Input type="search" value={search} placeholder={t('logsSearchPlaceholder')} aria-label={t('logsSearchLabel')}
        onChange={event => { setSearch(event.target.value); setCopied(false); setLimit(PAGE) }} />
      <Button variant="outline" size="sm" icon={<Icon name="copy" size={14} />} disabled={!entries.length}
        onClick={copy}>{copied ? t('logsCopied') : t('logsCopy')}</Button>
      <Button variant="outline" size="sm" icon={<Icon name="chevron-down" size={14} />} disabled={!entries.length}
        onClick={() => download(entries)}>{t('logsDownload')}</Button>
      {data && <span className="dt-hint">{t('logsCount', { shown: entries.length, limit })}</span>}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (entries.length ? <>
      <table className="dt-table dt-logs" data-logs>
        <thead><tr><th>{t('logsWhen')}</th><th>{t('logsLevel')}</th><th>{t('logsScope')}</th><th>{t('logsMessage')}</th></tr></thead>
        <tbody>{entries.map((entry, index) => <tr key={`${entry.at}:${index}`}>
          <td className="dt-nowrap">{when(entry.at, t('lang'))}</td>
          <td><Tag tone={tone(entry.level)}>{levelText(entry.level, t)}</Tag></td>
          <td className="dt-mono">{entry.scope}</td>
          <td className="dt-mono dt-log-message">{entry.message}</td>
        </tr>)}</tbody>
      </table>
      {more && <LoadMore onMore={() => setLimit(Math.min(limit + PAGE, RING))} />}
    </> : <Hint>{filtering ? t('logsNoMatch') : t('logsEmpty')}</Hint>)}
  </Section>
}
