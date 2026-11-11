/** The Incidents page: deterministic incidents the host recorded on its own, with their scope, occurrences and evidence. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { INCIDENT_SEVERITY_FILTERS, type IncidentSeverityFilter, type IncidentStatusFilter } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Input, SegmentedControl, Tag, type TagTone } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { when } from './text.ts'
import type { T } from './text.ts'
import { Hint, LabelValue, LoadState, Section } from './widgets.tsx'

export type IncidentsPageRoute = { page: 'incidents'; id?: string; query?: { status?: IncidentStatusFilter; severity?: IncidentSeverityFilter } }
type IncidentsView = ApiResponse<'GET incidents'>
type Incident = IncidentsView['incidents'][number]
type DetailView = ApiResponse<'GET incidents/:id'>
const STATUS_CHOICES: IncidentStatusFilter[] = ['open', 'all', 'detected', 'bundled', 'diagnosed', 'resolved', 'dismissed']

/** The tag tone of one severity: critical and high read as attention, low is quiet metadata. */
function severityTone(severity: Incident['severity']): TagTone {
  return severity === 'critical' ? 'danger' : severity === 'high' ? 'warning' : severity === 'medium' ? 'info' : 'quiet'
}
/** The scope ids, rendered as `project=p1 · ticket=t1`; an empty scope is global. */
function scopeText(scope: Incident['scope']): string {
  const parts = (['project', 'ticket', 'request', 'session'] as const).flatMap(name => scope[name] === undefined ? [] : `${name}=${scope[name]}`)
  return parts.length === 0 ? 'global' : parts.join(' · ')
}

/** One evidence manifest, with the directory a person can open and the hashed files. */
function Evidence({ view }: { view: NonNullable<DetailView['evidence']> }) {
  const { t } = usePanel()
  const manifest = view.manifest
  return <div className="dt-incident-evidence" data-incident-evidence>
    <LabelValue label={t('incidentEvidencePath')} value={<span className="dt-mono">{view.dir}</span>} />
    {manifest === null ? <Hint>{t('incidentEvidenceNone')}</Hint> : <>
      <div className="dt-row-meta">
        <LabelValue label={t('incidentEvidenceContent')} value={<span className="dt-mono dt-clamp">{manifest.content_sha256}</span>} />
        <LabelValue label={t('incidentEvidenceVersion')} value={manifest.version} />
      </div>
      <table className="dt-table dt-incident-files">
        <thead><tr><th>{t('incidentEvidenceFile')}</th><th>{t('incidentEvidenceBytes')}</th><th>{t('incidentEvidenceSha')}</th></tr></thead>
        <tbody>{manifest.files.map(file => <tr key={file.name}>
          <td className="dt-mono">{file.name}</td>
          <td>{file.bytes}</td>
          <td className="dt-mono dt-clamp">{file.sha256}</td>
        </tr>)}</tbody>
      </table>
    </>}
  </div>
}

/** The one destination a diagnosis names, in the operator's language. */
function targetText(t: T, target: NonNullable<DetailView['diagnosis']>['target']): string {
  if (target.kind === 'project') return t('incidentTargetProject', { project: target.project })
  if (target.kind === 'self') return t('incidentTargetSelf')
  if (target.kind === 'operational') return t('incidentTargetOperational')
  return t('incidentTargetNone')
}

/** The parsed diagnosis: root cause, evidence, hypotheses, fix plan, confidence and destination. */
function Diagnosis({ view }: { view: NonNullable<DetailView['diagnosis']> }) {
  const { t } = usePanel()
  if (!view.parsed) return <div className="dt-incident-diagnosis" data-incident-diagnosis>
    <h3 className="dt-block-title">{t('incidentDiagnosisSection')}</h3>
    <Hint>{t('incidentDiagnosisRaw')}</Hint>
    <p className="dt-hint dt-mono dt-clamp">{view.rootCause}</p>
  </div>
  const bulletList = (items: string[]) => items.length === 0 ? undefined : <ul className="dt-list">
    {items.map((item, index) => <li key={index} className="dt-clamp">{item}</li>)}</ul>
  return <div className="dt-incident-diagnosis" data-incident-diagnosis>
    <h3 className="dt-block-title">{t('incidentDiagnosisSection')}</h3>
    <LabelValue label={t('incidentRootCause')} value={view.rootCause} />
    {bulletList(view.evidence) !== undefined && <LabelValue label={t('incidentEvidenceLabel')} value={bulletList(view.evidence)} />}
    {bulletList(view.hypotheses) !== undefined && <LabelValue label={t('incidentHypotheses')} value={bulletList(view.hypotheses)} />}
    {view.fixPlan !== '' && <LabelValue label={t('incidentFixPlan')} value={view.fixPlan} />}
    <div className="dt-row-meta">
      <LabelValue label={t('incidentConfidence')} value={t(`incidentConfidence.${view.confidence}` as never)} />
      <LabelValue label={t('incidentTarget')} value={targetText(t, view.target)} />
    </div>
  </div>
}

/** One routing outcome: a link to the work it created, or the plain statement that it created none. */
function Resolution({ resolution }: { resolution: string }) {
  const { t, navigate } = usePanel()
  if (resolution.startsWith('request:')) {
    const id = resolution.slice('request:'.length)
    return <button type="button" className="dt-open" onClick={() => navigate({ page: 'logs', query: { q: `request=${id}` } })}>
      {t('incidentResolutionRequest', { id })}</button>
  }
  if (resolution.startsWith('self-report:')) {
    const id = resolution.slice('self-report:'.length)
    return <button type="button" className="dt-open" onClick={() => navigate({ page: 'overview' })}>
      {t('incidentResolutionSelfReport', { id })}</button>
  }
  if (resolution === 'operational') return <span>{t('incidentResolutionOperational')}</span>
  return <span className="dt-mono">{resolution}</span>
}

/** One incident's detail: what fired, its scope and counts, the evidence, the diagnosis and the operator's actions. */
function IncidentDetail({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET incidents/:id', { id }), [id])
  const [busy, setBusy] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [reason, setReason] = useState('')
  const [dismissing, setDismissing] = useState(false)
  const [routing, setRouting] = useState(false)
  const back = <Button variant="outline" size="sm" onClick={() => navigate({ page: 'incidents' })}>{t('incidentBack')}</Button>
  if (!data) return <Section title={t('incidentDetailTitle')} hint={t('incidentDetailHint')}>{back}
    <LoadState error={error} loading /></Section>
  const { incident, evidence, diagnosis } = data
  const actionable = incident.status === 'detected' || incident.status === 'bundled' || incident.status === 'diagnosed'
  const canDiagnose = incident.status === 'detected' || incident.status === 'bundled'
  const canDismiss = incident.status !== 'resolved' && incident.status !== 'dismissed'
  const canRoute = incident.status === 'diagnosed' && (incident.resolution === undefined || incident.resolution === '')
    && diagnosis !== null && diagnosis.target.kind !== 'none'
  const act = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    setFailure(undefined)
    setBusy(name)
    try {
      await run()
      setDismissing(false)
      setRouting(false)
      setReason('')
      await reload()
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy(undefined)
    }
  }
  return <Section title={incident.title} hint={t('incidentDetailHint')} action={back}>
    <div className="dt-incident-detail" data-incident-detail={incident.id}>
      <div className="dt-row-meta">
        <Tag tone={severityTone(incident.severity)}>{t(`incidentSeverity.${incident.severity}` as never)}</Tag>
        <LabelValue label={t('incidentRule')} value={t(`incidentRule.${incident.rule}` as never)} />
        <LabelValue label={t('incidentStatus')} value={t(`incidentStatus.${incident.status}` as never)} />
        <LabelValue label={t('incidentOccurrences')} value={String(incident.occurrences)} />
        <LabelValue label={t('incidentFirst')} value={when(incident.first_at, t('lang'))} />
        <LabelValue label={t('incidentLast')} value={when(incident.last_at, t('lang'))} />
      </div>
      <p className="dt-hint">{incident.detail}</p>
      <LabelValue label={t('incidentScope')} value={<span className="dt-mono">{scopeText(incident.scope)}</span>} />
      <LabelValue label={t('incidentFingerprintLabel')} value={<span className="dt-mono">{incident.fingerprint}</span>} />
      {actionable && <div className="dt-actions" data-incident-actions>
        {canDiagnose && <Button variant="outline" size="sm" disabled={busy !== undefined}
          onClick={() => void act('diagnose', () => call('POST incidents/:id/diagnose', { id }))}>
          {busy === 'diagnose' ? t('incidentDiagnosing') : t('incidentDiagnoseAction')}</Button>}
        {canRoute && !routing && <Button variant="outline" size="sm" disabled={busy !== undefined}
          onClick={() => setRouting(true)}>{t('incidentRouteAction')}</Button>}
        {canDismiss && !dismissing && <Button variant="outline" size="sm" disabled={busy !== undefined}
          onClick={() => setDismissing(true)}>{t('incidentDismissAction')}</Button>}
        {routing && <div className="dt-row-meta" data-incident-route-confirm>
          <span className="dt-hint">{t('incidentRouteConfirm')}</span>
          <Button size="sm" disabled={busy !== undefined}
            onClick={() => void act('route', () => call('POST incidents/:id/route', { id, body: { confirm: true } }))}>{t('incidentRouteAction')}</Button>
          <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => setRouting(false)}>{t('incidentRouteCancel')}</Button>
        </div>}
        {dismissing && <div className="dt-row-meta" data-incident-dismiss>
          <Input className="dt-mono" value={reason} maxLength={280} placeholder={t('incidentDismissReasonPlaceholder')}
            aria-label={t('incidentDismissReason')} onChange={event => setReason(event.target.value)} />
          <Button size="sm" disabled={busy !== undefined || reason.trim() === ''}
            onClick={() => void act('dismiss', () => call('POST incidents/:id/dismiss', { id, body: { reason: reason.trim() } }))}>{t('incidentDismissConfirm')}</Button>
          <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { setDismissing(false); setReason('') }}>{t('incidentDismissCancel')}</Button>
        </div>}
      </div>}
      {failure !== undefined && <p className="dt-error" role="alert">{t('incidentActionFailed', { message: failure })}</p>}
      {diagnosis !== null && <Diagnosis view={diagnosis} />}
      {incident.resolution !== undefined && <LabelValue label={t('incidentResolution')} value={<Resolution resolution={incident.resolution} />} />}
      {evidence === null ? <Hint>{t('incidentEvidenceNone')}</Hint> : <Evidence view={evidence} />}
    </div>
  </Section>
}

export function IncidentsPage({ route }: { route: IncidentsPageRoute }) {
  if (route.id !== undefined) return <IncidentDetail id={route.id} />
  return <IncidentList query={route.query} />
}

function IncidentList({ query }: { query?: IncidentsPageRoute['query'] }) {
  const { t, call, navigate } = usePanel()
  const [status, setStatus] = useState<IncidentStatusFilter>(query?.status ?? 'open')
  const [severity, setSeverity] = useState<IncidentSeverityFilter | undefined>(query?.severity)
  const { data, error } = usePoll(() => call('GET incidents', { query: { status,
    ...(severity === undefined ? {} : { severity }), limit: 100 } }), [status, severity])
  const incidents = data?.incidents ?? []
  const filtering = status !== 'open' || severity !== undefined
  const severityOptions: { value: IncidentSeverityFilter | ''; label: string }[] = [{ value: '', label: t('incidentSeverityAll') },
    ...INCIDENT_SEVERITY_FILTERS.map(value => ({ value, label: t(`incidentSeverity.${value}` as never) }))]
  return <Section title={t('incidentsTitle')} hint={t('incidentsHint')}>
    <div className="dt-logs-toolbar">
      <SegmentedControl label={t('incidentStatusLabel')} value={status}
        onChange={next => setStatus(next)}
        options={STATUS_CHOICES.map(value => ({ value, label: t(`incidentStatus.${value}` as never) }))} />
      <SegmentedControl label={t('incidentSeverityLabel')} value={severity ?? ''}
        onChange={next => setSeverity(next === '' ? undefined : next)} options={severityOptions} />
      {data && <span className="dt-hint">{t('incidentCount', { count: data.total })}</span>}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (incidents.length ? <table className="dt-table dt-incidents" data-incidents>
      <thead><tr>
        <th>{t('incidentSeverityLabel')}</th><th>{t('incidentRule')}</th><th>{t('incidentScope')}</th>
        <th>{t('incidentStatus')}</th><th>{t('incidentOccurrences')}</th><th>{t('incidentLast')}</th>
      </tr></thead>
      <tbody>{incidents.map(incident => <tr key={incident.id} data-incident={incident.id}>
        <td><Tag tone={severityTone(incident.severity)}>{t(`incidentSeverity.${incident.severity}` as never)}</Tag></td>
        <td>
          <button type="button" className="dt-open dt-open-wrap" onClick={() => navigate({ page: 'incidents', id: incident.id })}>
            {incident.title}
          </button>
          <div className="dt-hint">{t(`incidentRule.${incident.rule}` as never)}</div>
        </td>
        <td className="dt-mono">{scopeText(incident.scope)}</td>
        <td>{t(`incidentStatus.${incident.status}` as never)}</td>
        <td>{incident.occurrences}</td>
        <td className="dt-nowrap">{when(incident.last_at, t('lang'))}</td>
      </tr>)}</tbody>
    </table> : <Hint>{filtering ? t('incidentsNoMatch') : t('incidentsEmpty')}</Hint>)}
  </Section>
}
