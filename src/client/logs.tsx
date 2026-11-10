/** The Logs page: the Host's recent operational log, filterable by level and scope. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Input, SegmentedControl, Tag, type TagTone } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { when } from './text.ts'
import { Hint, LoadState, Section } from './widgets.tsx'

type LogsView = ApiResponse<'GET logs'>
type Entry = LogsView['entries'][number]
type LevelFilter = LogsView['level']

const FILTERS = ['all', 'warn', 'error'] as const

/** The tag tone of one log level; debug entries read as quiet metadata. */
const tone = (level: Entry['level']): TagTone => level === 'error' ? 'danger' : level === 'warn' ? 'warning'
  : level === 'info' ? 'info' : 'quiet'
/** The localized label of one stored log level. */
const levelText = (level: Entry['level'], t: ReturnType<typeof usePanel>['t']): string =>
  level === 'error' ? t('logLevel.error') : level === 'warn' ? t('logLevel.warn') : level === 'info' ? t('logLevel.info') : t('logLevel.debug')

export function LogsPage() {
  const { t, call } = usePanel()
  const [level, setLevel] = useState<LevelFilter>('all')
  const [scope, setScope] = useState('')
  const trimmed = scope.trim()
  const { data, error } = usePoll(() => call('GET logs', { query: { level, scope: trimmed || undefined, limit: 200 } }),
    [level, trimmed])
  return <Section title={t('logsTitle')} hint={t('logsHint')}>
    <div className="dt-logs-toolbar">
      <SegmentedControl label={t('logsLevelLabel')} value={level} onChange={setLevel}
        options={FILTERS.map(filter => ({ value: filter, label: filter === 'all' ? t('logsLevel.all')
          : filter === 'warn' ? t('logsLevel.warn') : t('logsLevel.error') }))} />
      <Input type="search" value={scope} placeholder={t('logsScopePlaceholder')} aria-label={t('logsScopeLabel')}
        onChange={event => setScope(event.target.value)} />
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.entries.length ? <table className="dt-table dt-logs" data-logs>
      <thead><tr><th>{t('logsWhen')}</th><th>{t('logsLevel')}</th><th>{t('logsScope')}</th><th>{t('logsMessage')}</th></tr></thead>
      <tbody>{data.entries.map((entry, index) => <tr key={`${entry.at}:${index}`}>
        <td className="dt-nowrap">{when(entry.at, t('lang'))}</td>
        <td><Tag tone={tone(entry.level)}>{levelText(entry.level, t)}</Tag></td>
        <td className="dt-mono">{entry.scope}</td>
        <td className="dt-mono dt-log-message">{entry.message}</td>
      </tr>)}</tbody>
    </table> : <Hint>{trimmed || level !== 'all' ? t('logsNoMatch') : t('logsEmpty')}</Hint>)}
  </Section>
}
