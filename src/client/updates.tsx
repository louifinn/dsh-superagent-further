/**
 * The Updates page: the supervisor-owned runtime version, the journal of the last update, the deploy command, and the one
 * operator action the panel may take — a confirmed request asking the supervisor to roll back. Everything shown is read from
 * the supervisor's files; the panel never uploads or loads a runtime (docs/adr/0007).
 */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Tag, type TagTone } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { when } from './text.ts'
import { Hint, LabelValue, LoadState, Section } from './widgets.tsx'

type UpdateView = ApiResponse<'GET updates'>
type HistoryEntry = UpdateView['history'][number]
type JournalView = NonNullable<UpdateView['journal']>

const outcomeTone = (outcome: HistoryEntry['outcome']): TagTone =>
  outcome === 'failed' ? 'danger' : outcome === 'rolledback' ? 'warning' : outcome === 'rejected' || outcome === 'interrupted' ? 'info' : 'quiet'

/** One descriptor pointer: version, schema and host API, or the reason nothing is recorded. */
function Descriptor({ label, descriptor }: { label: string; descriptor: UpdateView['current'] }) {
  const { t } = usePanel()
  return <div className="dt-row-meta" data-update-pointer={label}>
    <LabelValue label={label} value={descriptor === null ? t('updateNone') : descriptor.version} />
    {descriptor !== null && <>
      <LabelValue label={t('updateSchema')} value={String(descriptor.schema ?? '-')} />
      <LabelValue label={t('updateHostApi')} value={String(descriptor.hostApi)} />
    </>}
  </div>
}

/** The steps of the last journaled update: phase, state and when; a journal is crash truth, not a request. */
function Journal({ view }: { view: JournalView }) {
  const { t } = usePanel()
  return <div className="dt-update-journal" data-update-journal>
    <div className="dt-row-meta">
      <LabelValue label={t('updateJournalStatus')} value={t(`updateJournalStatus.${view.status}` as never)} />
      <LabelValue label={t('updateJournalOperation')} value={t(`updateJournalOperation.${view.operation}` as never)} />
      <LabelValue label={t('updatePhase')} value={t(`updatePhase.${view.phase}` as never)} />
      <LabelValue label={t('updateUpdatedAt')} value={when(view.updatedAt, t('lang'))} />
    </div>
    <table className="dt-table dt-update-steps">
      <thead><tr><th>{t('updatePhase')}</th><th>{t('updateStepState')}</th><th>{t('updateStepAt')}</th><th>{t('updateStepDetail')}</th></tr></thead>
      <tbody>{view.steps.map((step, index) => <tr key={`${step.phase}-${step.state}-${index}`}>
        <td>{t(`updatePhase.${step.phase}` as never)}</td>
        <td>{t(`updateStepState.${step.state}` as never)}</td>
        <td className="dt-nowrap">{when(step.at, t('lang'))}</td>
        <td className="dt-hint">{step.detail ?? ''}</td>
      </tr>)}</tbody>
    </table>
  </div>
}

/** Recent outcomes, newest last; the engine appends one entry per finished attempt and never rewrites them. */
function History({ entries }: { entries: HistoryEntry[] }) {
  const { t } = usePanel()
  if (entries.length === 0) return <Hint>{t('updateHistoryEmpty')}</Hint>
  return <table className="dt-table dt-update-history" data-update-history>
    <thead><tr><th>{t('updateHistoryAt')}</th><th>{t('updateHistoryAction')}</th><th>{t('updateHistoryOutcome')}</th>
      <th>{t('updateVersion')}</th><th>{t('updateHistoryFrom')}</th><th>{t('updatePhase')}</th><th>{t('updateHistoryReason')}</th></tr></thead>
    <tbody>{entries.map((entry, index) => <tr key={`${entry.id}-${index}`} data-update-history-row={entry.id}>
      <td className="dt-nowrap">{when(entry.at, t('lang'))}</td>
      <td>{t(`updateAction.${entry.action}` as never)}</td>
      <td><Tag tone={outcomeTone(entry.outcome)}>{t(`updateOutcome.${entry.outcome}` as never)}</Tag></td>
      <td>{entry.version ?? '-'}</td>
      <td>{entry.from ?? '-'}</td>
      <td>{entry.phase === null ? '-' : t(`updatePhase.${entry.phase}` as never)}</td>
      <td className="dt-hint">{entry.reason ?? ''}</td>
    </tr>)}</tbody>
  </table>
}

export function UpdatesPage() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET updates'), [])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [queued, setQueued] = useState<string>()
  if (!data) return <Section title={t('updatesTitle')} hint={t('updatesHint')}><LoadState error={error} loading /></Section>
  const rollback = async (): Promise<void> => {
    setFailure(undefined)
    setBusy(true)
    try {
      const result = await call('POST updates/rollback', { body: { confirm: 'ROLLBACK' } })
      setQueued(result.request.id)
      setConfirming(false)
      await reload()
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy(false)
    }
  }
  const pending = data.pending
  return <Section title={t('updatesTitle')} hint={t('updatesHint')}>
    <div className="dt-update" data-updates>
      {(data.busy || pending !== null) && <p className="dt-hint" data-update-pending>
        <Tag tone="warning">{data.busy ? t('updateBusy') : t('updatePending')}</Tag>
        {pending !== null && <span className="dt-mono"> {t('updatePendingDetail', { id: pending.id, action: pending.action,
          version: pending.version ?? '-' })}</span>}
      </p>}
      <Descriptor label={t('updateCurrent')} descriptor={data.current} />
      <Descriptor label={t('updatePrevious')} descriptor={data.previous} />
      <div className="dt-row-meta">
        <LabelValue label={t('updateDatabase')} value={data.databaseSchema === null ? t('updateNone') : String(data.databaseSchema)} />
        <LabelValue label={t('updateDataDir')} value={<span className="dt-mono">{data.stateDir}</span>} />
      </div>
      <div className="dt-update-deploy">
        <h3 className="dt-block-title">{t('updateDeployTitle')}</h3>
        <Hint>{t('updateDeployHint')}</Hint>
        <pre className="dt-mono dt-clamp" data-update-command>{data.deploy.command}</pre>
        <div className="dt-row-meta">
          <LabelValue label={t('updateDeployStatus')} value={<span className="dt-mono">{data.deploy.status}</span>} />
          <LabelValue label={t('updateDeployApply')} value={<span className="dt-mono">{data.deploy.apply}</span>} />
          <LabelValue label={t('updateDeployRollback')} value={<span className="dt-mono">{data.deploy.rollback}</span>} />
          <LabelValue label={t('updateDeployWatch')} value={<span className="dt-mono">{data.deploy.watch}</span>} />
        </div>
      </div>
      <div className="dt-update-rollback" data-update-rollback>
        <h3 className="dt-block-title">{t('updateRollbackTitle')}</h3>
        <LabelValue label={t('updateRollbackEligibility')} value={data.rollback.eligible
          ? t('updateRollbackEligible', { version: data.rollback.version ?? '-' }) : t('updateRollbackBlocked', { reason: data.rollback.reason })} />
        {data.rollback.eligible && !confirming && <Button variant="outline" size="sm" disabled={busy || data.busy || pending !== null}
          onClick={() => setConfirming(true)}>{t('updateRollbackAction')}</Button>}
        {confirming && <div className="dt-row-meta" data-update-rollback-confirm>
          <span className="dt-hint">{t('updateRollbackConfirm')}</span>
          <Button size="sm" disabled={busy || data.busy || pending !== null} onClick={() => void rollback()}>
            {busy ? t('updateRollbackWorking') : t('updateRollbackConfirmAction')}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{t('updateRollbackCancel')}</Button>
        </div>}
        {queued !== undefined && <p className="dt-hint" data-update-queued>{t('updateRollbackQueued', { id: queued })}</p>}
        {failure !== undefined && <p className="dt-error" role="alert">{t('updateRollbackFailed', { message: failure })}</p>}
      </div>
      <div className="dt-update-journal-section">
        <h3 className="dt-block-title">{t('updateJournalTitle')}</h3>
        {data.journal === null ? <Hint>{t('updateJournalNone')}</Hint> : <Journal view={data.journal} />}
      </div>
      <div className="dt-update-history-section">
        <h3 className="dt-block-title">{t('updateHistoryTitle')}</h3>
        <History entries={data.history} />
      </div>
    </div>
  </Section>
}
