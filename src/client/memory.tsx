/** Memory page: the master switch, injection and automatic-write switches, the snapshot limits, and the searchable stored memories. */
import { useState, type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import type { MemorySort } from '../memory.ts'
import { usePoll } from './api.ts'
import { Button, DisclosureRow, InfoTip, Input, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, numberOf, SettingsProvider, useBlockDraft, useSettings } from './settings-kit.tsx'
import { errorText, when } from './text.ts'
import { Hint, LabelValue, LoadState, Section } from './widgets.tsx'

type MemoryView = ApiResponse<'GET memories'>['items'][number]
type SwitchKey = 'enabled' | 'inject' | 'autoWrite'
type ProjectOption = { id: string; name: string }
const PAGE = 20

/** One labelled switch in the page's behavior block. */
function Toggle({ label, hint, checked, disabled, onChange }: {
  label: string, hint: string, checked: boolean, disabled?: boolean, onChange: (next: boolean) => void
}) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}<InfoTip text={hint} /></div>
    <Switch checked={checked} onChange={disabled ? () => {} : onChange} label={label} />
  </div>
}

/** One labelled combo box: the panel's select styling, used for the list's order and project filter. */
function Combo({ label, value, onChange, children }: {
  label: string, value: string, onChange: (next: string) => void, children: ReactNode
}) {
  return <label className="dt-memory-select">
    <span className="dt-hint">{label}</span>
    <select className="dt-select" aria-label={label} value={value} onChange={event => onChange(event.target.value)}>{children}</select>
  </label>
}

/** The first line of a memory, which the card shows while collapsed; the full text is behind the disclosure. */
const preview = (text: string) => text.split('\n')[0] ?? ''

/** One stored memory as an expandable card: a one-line preview, then everything stored, then pin and forget. */
function MemoryCard({ row, open, onToggle, onPin, onForget, busy }: {
  row: MemoryView, open: boolean, onToggle: () => void, onPin: () => void, onForget: () => void, busy: boolean
}) {
  const { t } = usePanel()
  const scope = t(`memoryScope.${row.scope}`)
  const meta = [scope, row.project, row.ticket ? `#${row.ticket.slice(0, 8)}` : '', when(row.at, t('lang'))].filter(Boolean).join(' · ')
  const sources = Object.entries(row.source).filter(([, value]) => Boolean(value))
  const facts: [string, string][] = [
    [t('memoryKindLabel'), t(`memoryKind.${row.kind}`)],
    [t('memoryScopeLabel'), scope],
    [t('memoryProjectLabel'), row.project || '—'],
    [t('memoryTicketLabel'), row.ticket || '—'],
    [t('memoryTagsLabel'), row.tags.length ? row.tags.join(' · ') : '—'],
    [t('memoryPinnedLabel'), row.pinned ? t('memoryYes') : t('memoryNo')],
    [t('memoryWrittenLabel'), when(row.at, t('lang'))],
    [t('memoryExpiresLabel'), row.expiresAt ? when(row.expiresAt, t('lang')) : '—'],
    [t('memorySourceLabel'), sources.length ? sources.map(([key, value]) => `${key} ${value}`).join(' · ') : '—'],
    [t('memoryIdLabel'), row.id],
  ]
  return <DisclosureRow open={open} onToggle={onToggle}
    icon={<Tag>{t(`memoryKind.${row.kind}`)}</Tag>}
    title={<span className="dt-memory-preview">{preview(row.text)}</span>}
    collapsedContent={<span className="dt-row-meta">{meta}{row.pinned ? ` · ${t('memoryPinnedCount')}` : ''}</span>}>
    <div className="dt-memory-card">
      <p className="dt-memory-text">{row.text}</p>
      <dl className="dt-memory-facts">
        {facts.map(([label, value]) => <div key={label} className="dt-memory-fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>)}
      </dl>
      <div className="dt-row-buttons">
        <Button size="sm" variant={row.pinned ? 'primary' : 'outline'} onClick={onPin} disabled={busy}>
          {row.pinned ? t('memoryUnpin') : t('memoryPin')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onForget} disabled={busy}>{t('memoryForget')}</Button>
      </div>
    </div>
  </DisclosureRow>
}

/** The stored memories: a keyword box and two combo boxes, one page of expandable cards, and the page's controls. */
function StoredMemories({ data, error, reload, query, sort, project, offset, projects, onQuery, onSort, onProject, onOffset }: {
  data: ApiResponse<'GET memories'> | undefined, error: Error | undefined, reload: () => Promise<void>,
  query: string, sort: MemorySort, project: string, offset: number, projects: ProjectOption[],
  onQuery: (next: string) => void, onSort: (next: MemorySort) => void, onProject: (next: string) => void, onOffset: (next: number) => void,
}) {
  const { t, call, notify } = usePanel()
  const [open, setOpen] = useState<string[]>([])
  const pin = useAction(async (row: MemoryView) => {
    await call('POST memory/pin', { body: { id: row.id, pinned: !row.pinned } })
    await reload()
  })
  const forget = useAction(async (id: string) => { await call('POST memory/forget', { body: { id } }); await reload() })
  const hint = data ? (query.trim() || project
    ? t('memorySearchHint', { matched: String(data.matched), total: String(data.total) })
    : t('memoryStoredHint', { total: String(data.total), pinned: String(data.pinned) }))
    : t('memoryStoredLoading')
  const pageSize = data?.limit ?? PAGE
  const page = Math.floor((data?.offset ?? 0) / pageSize) + 1
  const pages = Math.max(Math.ceil((data?.matched ?? 0) / pageSize), 1)
  const from = data?.items.length ? (data?.offset ?? 0) + 1 : 0
  const to = (data?.offset ?? 0) + (data?.items.length ?? 0)
  return <Section title={t('memoryStored')}>
    <div className="dt-memory-toolbar">
      <Input type="search" value={query} placeholder={t('memorySearchPlaceholder')} aria-label={t('memorySearchLabel')}
        onChange={event => onQuery(event.target.value)} />
    </div>
    <div className="dt-memory-filters">
      <Combo label={t('memorySortLabel')} value={sort} onChange={value => onSort(value as MemorySort)}>
        <option value="newest">{t('memorySortNewest')}</option>
        <option value="oldest">{t('memorySortOldest')}</option>
        <option value="kind">{t('memorySortKind')}</option>
        <option value="project">{t('memorySortProject')}</option>
      </Combo>
      <Combo label={t('memoryProjectFilterLabel')} value={project} onChange={onProject}>
        <option value="">{t('memoryProjectFilterAll')}</option>
        {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        <option value="-">{t('memoryProjectFilterNone')}</option>
      </Combo>
    </div>
    <p className="dt-hint">{hint}</p>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">
      {data.items.map(row => <li key={row.id} className="dt-row" data-memory={row.id}>
        <MemoryCard row={row} open={open.includes(row.id)} busy={pin.busy || forget.busy}
          onToggle={() => setOpen(rows => rows.includes(row.id) ? rows.filter(id => id !== row.id) : [...rows, row.id])}
          onPin={() => { void pin.run(row).then(ok => { if (ok) notify(row.pinned ? t('memoryUnpinned') : t('memoryPinned')) }) }}
          onForget={() => { void forget.run(row.id).then(ok => { if (ok) notify(t('memoryForgot')) }) }} />
      </li>)}
    </ul> : <Hint>{query.trim() || project ? t('memoryNoMatch') : t('memoryEmpty')}</Hint>)}
    {data && data.matched > 0 && <div className="dt-memory-pages">
      <Button size="sm" variant="outline" disabled={(data.offset) <= 0}
        onClick={() => onOffset(Math.max(data.offset - pageSize, 0))}>{t('memoryPagePrev')}</Button>
      <span className="dt-hint">{t('memoryPageRange', { from: String(from), to: String(to), matched: String(data.matched),
        page: String(page), pages: String(pages) })}</span>
      <Button size="sm" variant="outline" disabled={to >= data.matched}
        onClick={() => onOffset(data.offset + pageSize)}>{t('memoryPageNext')}</Button>
    </div>}
  </Section>
}
/** Behavior switches save on the spot; the numeric limits save through the draft's Save button. Both apply immediately. */
function MemorySettings() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const block = settings.blocks.memory
  const memory = block.value
  const saved = { ...memory, pinnedLimit: String(memory.pinnedLimit), recentLimit: String(memory.recentLimit),
    promptChars: String(memory.promptChars), retentionDays: String(memory.retentionDays) }
  const draft = useBlockDraft('memory', saved, block.revision, value => ({ ...value, pinnedLimit: numberOf(value.pinnedLimit),
    recentLimit: numberOf(value.recentLimit), promptChars: numberOf(value.promptChars), retentionDays: numberOf(value.retentionDays) }))
  const value = draft.value
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MemorySort>('newest')
  const [project, setProject] = useState('')
  const [offset, setOffset] = useState(0)
  const list = usePoll(() => call('GET memories', { query: { q: query, project, sort, limit: PAGE, offset } }), [query, project, sort, offset])
  // A new keyword, order or project filter starts at the first page; only the page buttons move the offset.
  const narrow = (apply: () => void) => { apply(); setOffset(0) }
  const flip = async (key: SwitchKey, next: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      // Read the latest revision first: a switch stays a one-click action even after another save moved the block on.
      const latest = await call('GET settings')
      const current = latest.blocks.memory
      await call('PUT settings/:block', { block: 'memory', body: { value: { ...current.value, [key]: next }, revision: current.revision } })
      await Promise.all([reload(), list.reload()])
      notify(t('saved'))
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const toggle = (key: SwitchKey, label: string, hint: string) => <Toggle label={label} hint={hint} checked={memory[key]}
    disabled={busy} onChange={next => { void flip(key, next) }} />
  return <div className="dt-form">
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('term.memory')}<InfoTip text={t('memoryIntro')} /></h2>
      {toggle('enabled', t('memoryEnabled'), t('memoryEnabledHint'))}
      {toggle('inject', t('memoryInjection'), t('memoryInjectionHint'))}
      {toggle('autoWrite', t('memoryAutoWrite'), t('memoryAutoWriteHint'))}
    </div>
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy || busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('memoryLimits')}<InfoTip text={t('memoryLimitsHint')} /></h2>
          <Field label={t('memoryPinnedLimit')} hint={t('memoryPinnedLimitHint')}>
            <Input type="number" min={0} max={LIMITS.memoryPinned} required value={value.pinnedLimit}
              onChange={event => draft.edit({ ...value, pinnedLimit: event.target.value })} />
          </Field>
          <Field label={t('memoryRecentLimit')} hint={t('memoryRecentLimitHint')}>
            <Input type="number" min={0} max={LIMITS.memoryPromptRows} required value={value.recentLimit}
              onChange={event => draft.edit({ ...value, recentLimit: event.target.value })} />
          </Field>
          <Field label={t('memoryPromptChars')} hint={t('memoryPromptCharsHint')}>
            <Input type="number" min={0} max={LIMITS.memoryPromptCharsMax} required value={value.promptChars}
              onChange={event => draft.edit({ ...value, promptChars: event.target.value })} />
          </Field>
          <Field label={t('memoryRetentionDays')} hint={t('memoryRetentionDaysHint')}>
            <Input type="number" min={LIMITS.memoryKeepDays.min} max={LIMITS.memoryKeepDays.max} required value={value.retentionDays}
              onChange={event => draft.edit({ ...value, retentionDays: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <StoredMemories data={list.data} error={list.error} reload={list.reload} query={query} sort={sort} project={project} offset={offset}
      projects={settings.blocks.executor.value.projects.map(({ id, name }) => ({ id, name }))}
      onQuery={next => narrow(() => setQuery(next))} onSort={next => narrow(() => setSort(next))}
      onProject={next => narrow(() => setProject(next))} onOffset={setOffset} />
    <ConfigHistory blocks={['memory']} />
    <div className="dt-row-meta"><LabelValue label={t('memoryScopeLabel')} value={t('memoryScopeHint')} /></div>
  </div>
}

/** The panel's Memory tab; the settings provider supplies the memory block and refreshes it after every save. */
export function MemoryPage() {
  return <SettingsProvider><MemorySettings /></SettingsProvider>
}
