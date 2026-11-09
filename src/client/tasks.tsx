/** The Automations page: scheduled standing instructions for the Orchestrator and project Leads. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { ApiError, usePoll } from './api.ts'
import { Button, Input, Switch, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { errorText, when, type T } from './text.ts'
import { Hint, ConfirmButton, LoadState, Section } from './widgets.tsx'

type AutomationsView = ApiResponse<'GET automations'>
type Row = AutomationsView['items'][number]
type Scope = Row['scope']

/** The default rule offered in the create form: one daily report at 09:00 UTC. */
const DEFAULT_RULE = 'DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY'

/**
 * Describe an rrule in the operator's language. The Host remains the only scheduler; this is a display-only
 * reading of the common daily, weekly, monthly, and hourly shapes. Anything else is shown verbatim.
 */
export function scheduleText(rrule: string, t: T): string {
  const rule = /RRULE:([^\n\r]+)/.exec(rrule)?.[1]
  if (!rule) return rrule.trim()
  const parts = new Map(rule.split(';').map(part => part.split('=') as [string, string]))
  const start = /DTSTART:\d{8}T(\d{2})(\d{2})/.exec(rrule)
  const hour = (parts.get('BYHOUR') ?? start?.[1] ?? '').padStart(2, '0')
  const minute = (parts.get('BYMINUTE') ?? start?.[2] ?? '00').padStart(2, '0')
  if (hour === '') return rule
  const time = `${hour}:${minute}`
  const interval = Number(parts.get('INTERVAL') ?? 1)
  switch (parts.get('FREQ')) {
    case 'DAILY': return interval === 1 ? t('automationDaily', { time }) : t('automationEveryDays', { count: interval, time })
    case 'WEEKLY': return interval === 1 ? t('automationWeekly', { time }) : t('automationEveryWeeks', { count: interval, time })
    case 'MONTHLY': return interval === 1 ? t('automationMonthly', { time }) : t('automationEveryMonths', { count: interval, time })
    case 'HOURLY': return t('automationHourly', { minute })
    default: return rule
  }
}

/** The panel label of one recorded delivery event. */
function deliveryKind(kind: Row['history'][number]['kind'], t: T): string {
  return kind === 'delivered' ? t('automationDelivered')
    : kind === 'orphaned' ? t('automationOrphaned') : t('automationDeliveryError')
}

export function TasksPage() {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET automations'), [])
  const [scope, setScope] = useState<Scope>('installation')
  const [project, setProject] = useState('')
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')
  const [rule, setRule] = useState(DEFAULT_RULE)
  const [enabled, setEnabled] = useState(true)
  const [editing, setEditing] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const unavailable = error instanceof ApiError && error.status === 503

  const reset = () => {
    setScope('installation')
    setProject('')
    setTitle('')
    setInstruction('')
    setRule(DEFAULT_RULE)
    setEnabled(true)
  }

  const beginEdit = (row: Row) => {
    setEditing(row)
    setScope(row.scope)
    setProject(row.project)
    setTitle(row.title)
    setInstruction(row.instruction)
    setRule(row.rrule)
    setEnabled(row.enabled)
    setFailure(undefined)
  }

  const startCreate = () => {
    setEditing(null)
    setFailure(undefined)
    reset()
  }

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      if (editing) {
        await call('PUT automations/:id', {
          id: editing.id,
          body: { expected_revision: editing.revision, title: title.trim(), instruction: instruction.trim(), rrule: rule, enabled },
        })
        notify(t('automationSavedNotice'))
      } else {
        await call('POST automations', {
          body: {
            title: title.trim(),
            instruction: instruction.trim(),
            rrule: rule,
            enabled,
            ...(scope === 'project' ? { project } : {}),
          },
        })
        notify(t('automationCreatedNotice'))
      }
      setEditing(null)
      reset()
      await reload()
    } catch (problem) {
      setFailure(errorText(problem))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (row: Row) => {
    setFailure(undefined)
    try {
      await call('PUT automations/:id', {
        id: row.id,
        body: { expected_revision: row.revision, enabled: !row.enabled },
      })
      await reload()
    } catch (problem) {
      setFailure(errorText(problem))
      await reload()
    }
  }

  const runNow = async (row: Row) => {
    setFailure(undefined)
    setActing(row.id)
    try {
      await call('POST automations/:id/run', { id: row.id })
      notify(t('automationRanNotice'))
      await reload()
    } catch (problem) {
      setFailure(errorText(problem))
      await reload()
    } finally {
      setActing(null)
    }
  }

  const removeRow = async (row: Row) => {
    setFailure(undefined)
    setActing(row.id)
    try {
      await call('DELETE automations/:id', { id: row.id })
      if (editing?.id === row.id) startCreate()
      notify(t('automationDeletedNotice'))
      await reload()
    } catch (problem) {
      setFailure(errorText(problem))
      await reload()
    } finally {
      setActing(null)
    }
  }

  const missingProject = editing === null && scope === 'project' && project === ''
  const incomplete = title.trim() === '' || instruction.trim() === '' || rule.trim() === '' || missingProject

  return <div className="dt-form">
    <Hint>{t('automationIntro')}</Hint>
    <Hint>{t('automationLimits')}</Hint>
    {unavailable
      ? <Hint>{t('automationUnavailable')}</Hint>
      : <>
        <LoadState error={error} loading={data === undefined} />
        {data && <>
          {data.attention > 0 && <Section title={t('automationNeedsAttention')} count={data.attention}>
            <Hint>{t('automationAttentionHint')}</Hint>
            <ul className="dt-attention" data-attention={data.attention}>
              {data.items.filter(row => row.orphaned || row.last_error !== null).map(row => <li key={row.id}
                data-attention-item={row.id}>
                <strong>{row.title}</strong> <span className="dt-row-meta">{row.id}</span>
                <div className="dt-row-meta">{row.last_error ?? t('automationOrphanedHint')}</div>
              </li>)}
            </ul>
          </Section>}
          <Section title={t('automationScheduled')} count={data.items.length} hint={t('automationScheduledHint')}>
            {data.items.length === 0
              ? <Hint>{t('automationEmpty')}</Hint>
              : <table className="dt-table" data-automations>
                <thead>
                  <tr>
                    <th>{t('automationScopeLabel')}</th>
                    <th>{t('automationTitleLabel')}</th>
                    <th>{t('automationRuleLabel')}</th>
                    <th>{t('automationEnabled')}</th>
                    <th>{t('automationLastDelivery')}</th>
                    <th>{t('automationCreated')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map(row => <tr key={row.id} data-automation={row.id}
                    data-attention={row.orphaned || row.last_error !== null ? 'true' : undefined}>
                    <td>
                      <Tag tone={row.scope === 'project' ? 'info' : 'neutral'}>
                        {row.scope === 'project'
                          ? `${t('automationScope.project')} · ${projectName(data.projects, row.project)}`
                          : t('automationScope.installation')}
                      </Tag>
                      {row.orphaned && <Tag tone="warning">{t('automationOrphaned')}</Tag>}
                      {!row.orphaned && row.last_error !== null && <Tag tone="warning">{t('automationDeliveryError')}</Tag>}
                    </td>
                    <td>
                      {row.title}
                      <div className="dt-row-meta">
                        <span>{row.id}</span>
                        {row.report_only && <span>{t('automationReportOnly')}</span>}
                      </div>
                      {(row.orphaned || row.last_error !== null) && <div className="dt-row-meta" data-automation-reason>
                        {row.last_error ?? t('automationOrphanedHint')}
                      </div>}
                      <details className="dt-row-meta" data-delivery-history={row.id}>
                        <summary>{t('automationHistory')} · {row.history.length}</summary>
                        {row.history.length === 0
                          ? <Hint>{t('automationHistoryEmpty')}</Hint>
                          : <ol className="dt-deliveries">
                            {row.history.map((entry, index) => <li key={`${entry.at}-${index}`} data-delivery={entry.kind}>
                              <span>{deliveryKind(entry.kind, t)}</span>{' '}
                              <span>{when(entry.delivered_at ?? entry.at, t('lang'))}</span>
                              {entry.error !== null && <span> — {entry.error}</span>}
                            </li>)}
                          </ol>}
                      </details>
                    </td>
                    <td>{scheduleText(row.rrule, t)}</td>
                    <td>
                      <Switch checked={row.enabled} label={`${t('automationEnabled')} ${row.title}`}
                        onChange={() => void toggle(row)} />
                    </td>
                    <td>{row.last_delivery_at ? when(row.last_delivery_at, t('lang')) : t('automationNever')}</td>
                    <td>{when(row.created_at, t('lang'))}</td>
                    <td>
                      <div className="dt-actions">
                        <Button size="sm" variant="outline" disabled={acting === row.id} onClick={() => void runNow(row)}>
                          {t('automationRun')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => beginEdit(row)}>{t('automationEdit')}</Button>
                        <ConfirmButton label={t('automationDelete')} title={t('automationDeleteTitle')}
                          message={t('automationDeleteMessage')} variant="outline"
                          onConfirm={() => removeRow(row)} />
                      </div>
                    </td>
                  </tr>)}
                </tbody>
              </table>}
            <Hint>{t('automationHistoryHint')}</Hint>
          </Section>
          <Section title={editing ? t('automationEditTitle') : t('automationCreateTitle')}
            hint={editing ? t('automationEditHint') : t('automationCreateHint')}>
            {editing && <Hint>{t('automationNoRetarget')}</Hint>}
            <form className="dt-form" onSubmit={event => void submit(event)}>
              <Fields disabled={busy}>
                {!editing && <Field label={t('automationScopeLabel')}>
                  <select className="dt-select" value={scope}
                    onChange={event => { setScope(event.target.value as Scope); setProject('') }}>
                    <option value="installation">{t('automationScope.installation')}</option>
                    <option value="project">{t('automationScope.project')}</option>
                  </select>
                </Field>}
                {!editing && scope === 'project' && <Field label={t('automationProjectLabel')}>
                  <select className="dt-select" value={project} onChange={event => setProject(event.target.value)}>
                    <option value="">{t('automationProjectNone')}</option>
                    {data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </Field>}
                {!editing && scope === 'project' && data.projects.length === 0 && <Hint>{t('automationNoProjects')}</Hint>}
                <Field label={t('automationTitleLabel')}>
                  <Input value={title} maxLength={LIMITS.automationTitle}
                    onChange={event => setTitle(event.target.value)} />
                </Field>
                <Field label={t('automationInstructionLabel')}>
                  <textarea className="dt-textarea" rows={4} value={instruction} maxLength={LIMITS.automationInstruction}
                    onChange={event => setInstruction(event.target.value)} />
                </Field>
                <Field label={t('automationRuleLabel')} hint={t('automationRuleHint')}>
                  <textarea className="dt-textarea dt-mono" rows={2} value={rule} maxLength={LIMITS.automationRule}
                    onChange={event => setRule(event.target.value)} />
                </Field>
                <div className="dt-switch-row">
                  <span>{t('automationEnabled')}</span>
                  <Switch checked={enabled} label={t('automationEnabled')} onChange={setEnabled} />
                </div>
              </Fields>
              <div className="dt-actions">
                <Button type="submit" variant="primary" disabled={busy || incomplete}>
                  {editing ? t('automationSave') : t('automationCreate')}
                </Button>
                {editing && <Button variant="ghost" onClick={startCreate}>{t('automationNew')}</Button>}
              </div>
              {failure && <p className="dt-error" role="alert">{failure}</p>}
            </form>
          </Section>
        </>}
      </>}
  </div>
}

function projectName(projects: AutomationsView['projects'], id: string): string {
  return projects.find(item => item.id === id)?.name ?? id
}
