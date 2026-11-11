/** The Incidents page: deterministic incidents the host recorded on its own, with their scope, occurrences and evidence. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { INCIDENT_SEVERITY_FILTERS, type IncidentSeverityFilter, type IncidentStatusFilter } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, SegmentedControl, Tag, type TagTone } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { when } from './text.ts'
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

/** One incident's detail: what fired, its scope and counts, and the evidence the host bundled. */
function IncidentDetail({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET incidents/:id', { id }), [id])
  const back = <Button variant="outline" size="sm" onClick={() => navigate({ page: 'incidents' })}>{t('incidentBack')}</Button>
  if (!data) return <Section title={t('incidentDetailTitle')} hint={t('incidentDetailHint')}>{back}
    <LoadState error={error} loading /></Section>
  const { incident, evidence } = data
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
      {incident.diagnosis !== undefined && <LabelValue label={t('incidentDiagnosis')} value={incident.diagnosis} />}
      {incident.resolution !== undefined && <LabelValue label={t('incidentResolution')} value={incident.resolution} />}
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
