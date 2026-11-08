/** Memory page: the master switch, injection and automatic-write switches, the snapshot limits, and the stored memories. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll } from './api.ts'
import { InfoTip, Input, Switch } from './controls.tsx'
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

/** The stored memories, newest first, each removable; the totals come from the same response. */
function StoredMemories({ data, error, reload }: {
  data: ApiResponse<'GET memories'> | undefined, error: Error | undefined, reload: () => Promise<void>
}) {
  const { t, call, notify } = usePanel()
  const forget = useAction(async (id: string) => { await call('POST memory/forget', { body: { id } }); await reload() })
  const meta = (row: MemoryView) => [t(`memoryScope.${row.scope}`), row.project, row.ticket ? `#${row.ticket.slice(0, 8)}` : '',
    when(row.at, t('lang'))].filter(Boolean).join(' · ')
  return <Section title={t('memoryStored')} hint={data ? t('memoryStoredHint', { total: String(data.total), pinned: String(data.pinned) })
    : t('memoryStoredLoading')}>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(row => <li key={row.id} className="dt-row">
      <div className="dt-row-title">
        <span className="dt-tag">{t(`memoryKind.${row.kind}`)}</span>
        <span>{row.text}</span>
      </div>
      <div className="dt-row-meta">
        <span className="dt-hint">{meta(row)}</span>
        {row.pinned && <span className="dt-tag">{t('memoryPinnedCount')}</span>}
        <button type="button" className="dt-textlink" disabled={forget.busy}
          onClick={() => { void forget.run(row.id).then(ok => { if (ok) notify(t('memoryForgot')) }) }}>{t('memoryForget')}</button>
      </div>
    </li>)}</ul> : <Hint>{t('memoryEmpty')}</Hint>)}
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
  const list = usePoll(() => call('GET memories'), [])
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
    <StoredMemories data={list.data} error={list.error} reload={list.reload} />
    <ConfigHistory blocks={['memory']} />
    <div className="dt-row-meta"><LabelValue label={t('memoryScopeLabel')} value={t('memoryScopeHint')} /></div>
  </div>
}

/** The panel's Memory tab; the settings provider supplies the memory block and refreshes it after every save. */
export function MemoryPage() {
  return <SettingsProvider><MemorySettings /></SettingsProvider>
}
