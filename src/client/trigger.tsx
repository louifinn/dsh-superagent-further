/** Trigger status view listing Threads filtered by subscription, evaluation activity, and project. */
import { useState } from 'react'
import { THREAD_FILTERS, type ThreadFilter } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Pill } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { ThreadLine } from './rows.tsx'
import { Hint, LoadMore, LoadState, StatusHead } from './widgets.tsx'

export function TriggerStatus({ filter }: { filter: ThreadFilter }) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const [project, setProject] = useState('')
  const { data, error } = usePoll(() => call('GET threads', { query: { filter, limit } }), [filter, limit])
  const go = (next: ThreadFilter) => { setLimit(20); navigate({ page: 'trigger', query: next !== 'subscribed' ? { filter: next } : {} },
    true) }
  // A Thread's project comes from its repository, so one project's Threads can be read without the others.
  const items = data ? (project ? data.items.filter(thread => project === '-' ? !thread.project : thread.project === project) : data.items) : []
  const projects = data?.projects ?? []
  return <>
    <StatusHead hint={t('triggerIntro')} />
    <div className="dt-filters">
      {THREAD_FILTERS.map(value => <Pill key={value} active={filter === value}
        onClick={() => go(value)}>{t(`threadFilter.${value}`)}</Pill>)}
    </div>
    {projects.length > 0 && <div className="dt-project-filters" role="group" aria-label={t('projectFilterLabel')}>
      <Button size="sm" variant={project === '' ? 'primary' : 'outline'} aria-pressed={project === ''}
        onClick={() => setProject('')}>{t('projectFilterAll')}</Button>
      {projects.map(item => <Button key={item.id} size="sm" variant={project === item.id ? 'primary' : 'outline'}
        aria-pressed={project === item.id} onClick={() => setProject(item.id)}>{item.name}</Button>)}
      {data?.items.some(thread => !thread.project) && <Button size="sm" variant={project === '-' ? 'primary' : 'outline'}
        aria-pressed={project === '-'} onClick={() => setProject('-')}>{t('projectFilterNone')}</Button>}
    </div>}
    <LoadState error={error} loading={!data} />
    {data && (items.length ? <ul className="dt-list">{items.map(thread => <ThreadLine key={thread.key} thread={thread} />)}</ul>
      : <Hint>{t('threadsNone')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}
