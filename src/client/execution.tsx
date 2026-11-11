/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import type { Project } from '../projects.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill, Switch, Tag, type TagTone } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized, valueLabel } from './text.ts'
import { ClampText, ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, SetupMessage, StatusHead, When } from './widgets.tsx'

export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
    <WorkerJobs />
  </>
}

const jobTone = (status: string): TagTone => status === 'running' ? 'info' : status === 'stopping' ? 'warning'
  : status === 'completed' ? 'success' : 'danger'
/** Each open Ticket's worker Session and its shell jobs: a job settled earlier, or one still writing output right now. */
function WorkerJobs() {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET workers'), [])
  return <Section title={t('workersTitle')} hint={t('workersHint')} count={data?.items.length}>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(worker => <li className="dt-row" key={worker.ticket}>
      <div className="dt-row-main">
        <div className="dt-att-what"><span className="dt-mono">{worker.session}</span>
          <span className="dt-hint"> · {worker.title}</span></div>
        <div className="dt-row-meta"><Tag tone="neutral">{worker.assignment ? valueLabel(t, 'assignment', worker.assignment)
          : t('workersNoAssignment')}</Tag></div>
      </div>
      {worker.jobs.length ? <ul className="dt-list">{worker.jobs.map(job => <li className="dt-row" key={job.id}>
        <div className="dt-row-main">
          <div className="dt-att-what"><Tag tone={jobTone(job.status)}>{valueLabel(t, 'workerJobStatus', job.status)}</Tag>
            <span className="dt-mono">{job.label}</span>
            <span className="dt-hint"> · {job.kind} {job.id}</span></div>
          <div className="dt-row-meta">{job.endedAt ? <span className="dt-hint"><When at={job.endedAt} /></span>
            : job.startedAt ? <span className="dt-hint"><When at={job.startedAt} /></span> : null}
            {job.detail && <span className="dt-hint">{job.detail}</span>}</div>
        </div>
        {job.preview ? <ClampText text={job.preview} /> : null}
      </li>)}</ul> : <Hint>{t('workersNoJobs')}</Hint>}
    </li>)}</ul> : <Hint>{t('workersEmpty')}</Hint>)}
  </Section>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
/** One boolean settings switch with its label and explanation, matching the Memory page's rows. */
function ToggleField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean
  onChange: (next: boolean) => void }) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</div>
    <Switch checked={checked} onChange={onChange} label={label} />
  </div>
}
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
function Projects({ projects, onChange }: { projects: Project[]; onChange: (next: Project[]) => void }) {
  const { t } = usePanel()
  const set = (index: number, next: Partial<Project>) => onChange(projects.map((item, at) => at === index ? { ...item, ...next } : item))
  const remove = (index: number) => onChange(projects.filter((_, at) => at !== index))
  return <Section title={t('projects')} hint={t('projectsHint')} action={<Button variant="ghost" size="sm" icon={<Icon name="plus" />}
    onClick={() => onChange([...projects, { id: '', name: '', workspace: '', repository: '', branch: '' }])}>{t('projectAdd')}</Button>}>
    {projects.length ? <ul className="dt-rules">{projects.map((project, index) => <li key={index} className="dt-rule">
      <div className="dt-rule-body">
        <div className="dt-grid3">
          <Field label={t('projectId')} hint={t('projectIdHint')}><Input className="dt-mono" required maxLength={40}
            pattern="[a-z0-9][a-z0-9\-]*" spellCheck={false} placeholder="app" value={project.id}
            onChange={event => set(index, { id: event.target.value })} /></Field>
          <Field label={t('projectName')}><Input required maxLength={LIMITS.projectName} value={project.name}
            onChange={event => set(index, { name: event.target.value })} /></Field>
          <Field label={t('projectRepository')} hint={t('projectRepositoryHint')}><Input className="dt-mono" required
            spellCheck={false} placeholder="owner/name" maxLength={LIMITS.projectRepository} value={project.repository}
            onChange={event => set(index, { repository: event.target.value })} /></Field>
        </div>
        <Field label={t('projectWorkspace')} hint={t('projectWorkspaceHint')}><Input className="dt-mono" required spellCheck={false}
          maxLength={LIMITS.projectPath} value={project.workspace}
          onChange={event => set(index, { workspace: event.target.value })} /></Field>
        <Field label={t('projectBranch')} hint={t('projectBranchHint')} note={project.branch ? undefined : t('projectBranchEmpty')}>
          <Input className="dt-mono" maxLength={LIMITS.projectBranch} spellCheck={false} value={project.branch}
            onChange={event => set(index, { branch: event.target.value })} />
        </Field>
        <div className="dt-actions">
          <Button variant="ghost" size="sm" icon={<Icon name="trash" />} onClick={() => remove(index)}>{t('projectRemove')}</Button>
        </div>
      </div>
    </li>)}</ul> : <Hint>{t('projectsEmpty')}</Hint>}
  </Section>
}
/** The name of a workspace directory, as the DSH title ends with it. */
const workspaceName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
/**
 * The mandatory Orchestrator workspace: the explicitly titled DSH workspace the main Session runs in, and the settings block
 * that selects it. The title comes from the running host; before the first save the path's last segment stands in for it.
 */
function WorkspaceSettings() {
  const { t } = usePanel()
  const { setup } = usePanelData()
  const { settings } = useSettings()
  const block = settings.blocks.workspace
  const draft = useBlockDraft('workspace', block.value, block.revision)
  const title = setup?.workspace?.title ?? (block.value.path ? `dsh-superagent-further · ${workspaceName(block.value.path)}` : '')
  return <div className="dt-form dt-block">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <Section title={t('workspaceSettingsTitle')} hint={t('workspaceSettingsIntro')}>
          {title !== '' && <LabelValue label={t('workspaceTitleLabel')} value={title} />}
          <Field label={t('workspacePathLabel')} hint={t('workspacePathHint')}
            note={block.value.path ? undefined : t('workspacePathEmpty')}>
            <Input className="dt-mono" required spellCheck={false} value={draft.value.path}
              placeholder={t('workspacePathPlaceholder')} onChange={event => draft.edit({ path: event.target.value })} />
          </Field>
          {setup?.problem?.place === 'execution' && <SetupMessage problem={setup.problem} />}
        </Section>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  </div>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), projectWorkers: String(executor.projectWorkers), worktreeKeepDays: String(executor.worktreeKeepDays), logRetentionDays: String(executor.logRetentionDays), blockedCommands: executor.blockedCommands.join(' ') }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), projectWorkers: numberOf(value.projectWorkers), worktreeKeepDays: numberOf(value.worktreeKeepDays), logRetentionDays: numberOf(value.logRetentionDays), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <WorkspaceSettings />
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
          <Field label={t('projectWorkers')} hint={t('projectWorkersHint')}>
            <Input type="number" min={LIMITS.projectWorkers.min} max={LIMITS.projectWorkers.max} required value={value.projectWorkers}
              onChange={event => edit({ projectWorkers: event.target.value })} />
          </Field>
          <Field label={t('worktreeKeepDays')} hint={t('worktreeKeepDaysHint')}>
            <Input type="number" min={LIMITS.worktreeKeepDays.min} max={LIMITS.worktreeKeepDays.max} required value={value.worktreeKeepDays}
              onChange={event => edit({ worktreeKeepDays: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <Projects projects={value.projects} onChange={projects => edit({ projects })} />
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('logSettings')}<InfoTip text={t('logSettingsIntro')} /></h2>
          <Field label={t('logLevelSetting')} hint={t('logLevelSettingHint')}>
            <select className="dt-select" value={value.logLevel} onChange={event => edit({ logLevel: event.target.value as 'info' | 'debug' })}>
              <option value="info">{t('logLevel.info')}</option>
              <option value="debug">{t('logLevel.debug')}</option>
            </select>
          </Field>
          <Field label={t('logRetentionDays')} hint={t('logRetentionDaysHint')}>
            <Input type="number" min={1} max={30} required value={value.logRetentionDays}
              onChange={event => edit({ logRetentionDays: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('incidentSettings')}<InfoTip text={t('incidentSettingsIntro')} /></h2>
          <ToggleField label={t('incidentEnabled')} hint={t('incidentEnabledHint')} checked={value.incidents.enabled}
            onChange={enabled => edit({ incidents: { ...value.incidents, enabled } })} />
          <ToggleField label={t('incidentAutoDiagnose')} hint={t('incidentAutoDiagnoseHint')} checked={value.incidents.autoDiagnose}
            onChange={autoDiagnose => edit({ incidents: { ...value.incidents, autoDiagnose } })} />
          <Field label={t('incidentDailyBudget')} hint={t('incidentDailyBudgetHint')}>
            <Input type="number" min={0} max={24} required value={String(value.incidents.dailyBudget)}
              onChange={event => edit({ incidents: { ...value.incidents, dailyBudget: numberOf(event.target.value) ?? 0 } })} />
          </Field>
          <Field label={t('incidentDiagnoseDailyBudget')} hint={t('incidentDiagnoseDailyBudgetHint')}>
            <Input type="number" min={0} max={24} required value={String(value.incidents.diagnoseDailyBudget)}
              onChange={event => edit({ incidents: { ...value.incidents, diagnoseDailyBudget: numberOf(event.target.value) ?? 0 } })} />
          </Field>
          <Field label={t('incidentMinimumSeverity')} hint={t('incidentMinimumSeverityHint')}>
            <select className="dt-select" value={value.incidents.minimumSeverity}
              onChange={event => edit({ incidents: { ...value.incidents,
                minimumSeverity: event.target.value as 'low' | 'medium' | 'high' | 'critical' } })}>
              {(['low', 'medium', 'high', 'critical'] as const).map(severity => <option key={severity}
                value={severity}>{t(`incidentSeverity.${severity}` as never)}</option>)}
            </select>
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['workspace', 'executor', 'pause']} />
  </div>
}
