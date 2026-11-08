/** Memory page: the master switch, injection and automatic-write switches, the snapshot limits, and the searchable stored memories. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import type { MemorySort } from '../memory.ts'
import { usePoll } from './api.ts'
import { Button, DisclosureRow, InfoTip, Input, SegmentedControl, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, numberOf, SettingsProvider, useBlockDraft, useSettings } from './settings-kit.tsx'
import { errorText, when } from './text.ts'
import { Hint, LabelValue, LoadState, Section } from './widgets.tsx'

type MemoryView = ApiResponse<'GET memories'>['items'][number]
type SwitchKey = 'enabled' | 'inject' | 'autoWrite'

/** One labelled switch in the page's behavior block. */
function Toggle({ label, hint, checked, disabled, onChange }: {
  label: string, hint: string, checked: boolean, disabled?: boolean, onChange: (next: boolean) => void
}) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}<InfoTip text={hint} /></div>
    <Switch checked={checked} onChange={disabled ? () => {} : onChange} label={label} />
  </div>
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

/** The stored memories: a keyword box and an order, then one expandable card each; the totals come from the same response. */
function StoredMemories({ data, error, reload, query, sort, onQuery, onSort }: {
  data: ApiResponse<'GET memories'> | undefined, error: Error | undefined, reload: () => Promise<void>,
  query: string, sort: MemorySort, onQuery: (next: string) => void, onSort: (next: MemorySort) => void,
}) {
  const { t, call, notify } = usePanel()
  const [open, setOpen] = useState<string[]>([])
  const pin = useAction(async (row: MemoryView) => {
    await call('POST memory/pin', { body: { id: row.id, pinned: !row.pinned } })
    await reload()
  })
  const forget = useAction(async (id: string) => { await call('POST memory/forget', { body: { id } }); await reload() })
  const hint = data ? (query.trim()
    ? t('memorySearchHint', { matched: String(data.matched), total: String(data.total) })
    : t('memoryStoredHint', { total: String(data.total), pinned: String(data.pinned) }))
    : t('memoryStoredLoading')
  return <Section title={t('memoryStored')}>
    <div className="dt-memory-toolbar">
      <Input type="search" value={query} placeholder={t('memorySearchPlaceholder')} aria-label={t('memorySearchLabel')}
        onChange={event => onQuery(event.target.value)} />
      <SegmentedControl label={t('memorySortLabel')} value={sort} onChange={onSort} options={[
        { value: 'newest', label: t('memorySortNewest') },
        { value: 'oldest', label: t('memorySortOldest') },
        { value: 'kind', label: t('memorySortKind') },
        { value: 'project', label: t('memorySortProject') },
      ]} />
    </div>
    <p className='dt-hint'>{hint}</p>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">
      {data.items.map(row => <li key={row.id} className="dt-row" data-memory={row.id}>
        <MemoryCard row={row} open={open.includes(row.id)} busy={pin.busy || forget.busy}
          onToggle={() => setOpen(rows => rows.includes(row.id) ? rows.filter(id => id !== row.id) : [...rows, row.id])}
          onPin={() => { void pin.run(row).then(ok => { if (ok) notify(row.pinned ? t('memoryUnpinned') : t('memoryPinned')) }) }}
          onForget={() => { void forget.run(row.id).then(ok => { if (ok) notify(t('memoryForgot')) }) }} />
      </li>)}
    </ul> : <Hint>{query.trim() ? t('memoryNoMatch') : t('memoryEmpty')}</Hint>)}
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
  const list = usePoll(() => call('GET memories', { query: { q: query, sort, limit: 100 } }), [query, sort])
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
    <StoredMemories data={list.data} error={list.error} reload={list.reload} query={query} sort={sort}
      onQuery={setQuery} onSort={setSort} />
    <ConfigHistory blocks={['memory']} />
    <div className="dt-row-meta"><LabelValue label={t('memoryScopeLabel')} value={t('memoryScopeHint')} /></div>
  </div>
}

/** The panel's Memory tab; the settings provider supplies the memory block and refreshes it after every save. */
export function MemoryPage() {
  return <SettingsProvider><MemorySettings /></SettingsProvider>
}
