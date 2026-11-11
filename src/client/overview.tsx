/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and Executor load. */
import { useState, type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll, type Problem } from './api.ts'
import { Button, Icon, Input } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { errorText, healthText, localized, reasonLabel, valueLabel, readableMarkers, when } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LabelValue, LoadState, Section, SetupMessage } from './widgets.tsx'

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate, openSession, notify } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      setupPage(problem.place), t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'delivery-failure': return row(t('problemDeliveryFile', { path: problem.path }), raw(problem.reason), undefined,
      t('problemDeliveryChat', { chat: problem.chat, at: when(problem.at, t('lang')) }))
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

/** One open Request: its accepted ask, with the Tickets delivering it behind a toggle. */
function RequestEntry({ request }: { request: ApiResponse<'GET overview'>['requests'][number] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  return <li className="dt-row dt-link dt-request">
    <div className="dt-row-main">
      <div className="dt-att-what"><button type="button" className="dt-open dt-open-wrap" aria-expanded={open}
        onClick={() => setOpen(!open)}>{request.title}</button></div>
      <div className="dt-row-meta">
        <LabelValue label={t('requestTicketsLabel')} value={String(request.tickets.length)} />
        <Button variant="ghost" size="sm" icon={<Icon name="history" size={14} />} data-request-logs={request.id}
          onClick={() => navigate({ page: 'logs', query: { q: `request=${request.id}` } })}>{t('logsForRequest')}</Button>
      </div>
      {open && <div className="dt-request-tickets">
        {request.tickets.map(ticket => <Button key={ticket.id} size="sm" variant="outline"
          onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title}</Button>)}
      </div>}
    </div>
  </li>
}

/**
 * One open escalation with its reply and the three decisions the Orchestrator can make from here. Accept starts
 * one Ticket in the escalating project; work that belongs to other units is accepted with orchestrator_escalation_decide.
 */
function EscalationEntry({ item, onChanged }: { item: ApiResponse<'GET overview'>['escalations'][number]; onChanged: () => Promise<void> }) {
  const { t, call } = usePanel()
  const [reply, setReply] = useState('')
  const action = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const decide = (decision: 'accept' | 'reject' | 'needs-info') => action.run(async () => {
    await call('POST escalations/:id/decide', { id: item.id, body: { decision, reply,
      ...decision === 'accept' ? { units: [{ project: item.project, title: item.title }] } : {} } })
    setReply('')
  })
  return <li className="dt-row" data-escalation={item.id}>
    <div className="dt-row-main">
      <div className="dt-att-what">{item.title}</div>
      <div className="dt-row-meta">
        <LabelValue label={t('escalationProjectLabel')} value={item.project} />
        <LabelValue label={t('escalationRaisedLabel')} value={when(item.createdAt, t('lang'))} />
      </div>
      <p className="dt-hint">{item.instruction}</p>
      <div className="dt-row-meta dt-row-buttons">
        <Input value={reply} placeholder={t('escalationReplyPlaceholder')} aria-label={t('escalationReplyPlaceholder')}
          onChange={event => setReply(event.target.value)} />
        <Button size="sm" disabled={!reply.trim()} onClick={() => decide('accept')}>{t('escalationAccept')}</Button>
        <Button size="sm" variant="outline" disabled={!reply.trim()} onClick={() => decide('reject')}>{t('escalationReject')}</Button>
        <Button size="sm" variant="outline" disabled={!reply.trim()} onClick={() => decide('needs-info')}>{t('escalationNeedsInfo')}</Button>
      </div>
    </div>
  </li>
}
/**
 * One observe-mode self report draft (docs/014 D5): a person approves filing it — within the outlet's deduplication and
 * daily cap — or dismisses it. Filed history stays in the target repository, so no other surface is added here.
 */
function SelfReportEntry({ item, blocked, onChanged }: {
  item: ApiResponse<'GET overview'>['selfReports'][number]; blocked: boolean; onChanged: () => Promise<void>
}) {
  const { t, call } = usePanel()
  const action = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  return <li className="dt-row" data-self-report={item.id}>
    <div className="dt-row-main">
      <div className="dt-att-what">{item.title}</div>
      <div className="dt-row-meta">
        <LabelValue label={t('selfReportTarget')} value={<span className="dt-mono">{item.target_repo}</span>} />
        <LabelValue label={t('selfReportAge')} value={when(item.createdAt, t('lang'))} />
      </div>
      <p className="dt-hint">{item.evidence}</p>
      <div className="dt-row-meta dt-row-buttons">
        <Button size="sm" disabled={action.busy} onClick={() => { void action.run(() =>
          call('POST self-reports/:id/approve', { id: item.id })) }}>{t('selfReportApprove')}</Button>
        <Button size="sm" variant="outline" disabled={action.busy} onClick={() => { void action.run(() =>
          call('POST self-reports/:id/dismiss', { id: item.id })) }}>{t('selfReportDismiss')}</Button>
      </div>
      {blocked && <Hint>{t('selfReportBlocked')}</Hint>}
    </div>
  </li>
}
export function OverviewPage() {
  const { t, call, navigate, openSession, notify } = usePanel()
  const { setup } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  // Filtering happens here because the overview already carries the waiting list and the registered project names.
  const [project, setProject] = useState('')
  if (!data) return <LoadState error={error} loading />
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  const waiting = project ? data.person.filter(ticket => project === '-' ? !ticket.project : ticket.project === project) : data.person
  // The API always sends both fields; test doubles written before the outlet may not.
  const selfReports = data.selfReports ?? []
  const choices = [{ id: '', label: t('projectFilterAll') }, ...data.projects.map(item => ({ id: item.id, label: item.name })),
    ...data.person.some(ticket => !ticket.project) ? [{ id: '-', label: t('projectFilterNone') }] : []]
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('pendingTickets')} count={waiting.length}>
      {/* One project per local workspace: the filter names the project each waiting Ticket works in. */}
      {data.projects.length > 0 && <div className="dt-project-filters" role="group" aria-label={t('projectFilterLabel')}>
        {choices.map(choice => <Button key={choice.id} size="sm" variant={choice.id === project ? 'primary' : 'outline'}
          onClick={() => setProject(choice.id)}>{choice.label}</Button>)}
      </div>}
      {waiting.length ? <ul className="dt-list dt-cards">{waiting.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
        : <Hint>{t('needsYouNone')}</Hint>}
    </Section>
    {/* One row per registered project: its Lead Session, and the executors and messages the project holds. */}
    {data.leads.length > 0 && <Section title={t('leadsTitle')} count={data.leads.length}>
      <ul className="dt-list">
        {data.leads.map(lead => <li key={lead.project} className="dt-row">
          <div className="dt-row-main">
            <div className="dt-att-what">{lead.session ? <button type="button" className="dt-open"
              onClick={() => { openSession(lead.session).catch(failure => notify(errorText(failure))) }}>{lead.name}</button>
              : lead.name}</div>
            <div className="dt-row-meta">
              <LabelValue label={t('leadStateLabel')} value={lead.status === 'running' ? t('leadRunning')
                : lead.status === 'absent' ? t('leadAbsent') : t('leadIdle')} />
              <LabelValue label={t('leadExecutorsLabel')} value={String(lead.running)} />
              <LabelValue label={t('leadWaitingLabel')} value={String(lead.waiting)} />
              <LabelValue label={t('leadRequestsLabel')} value={String(lead.projectRequests.pending)} />
              {lead.projectRequests.automated > 0 && <LabelValue label={t('leadRequestsAutomatedLabel')} value={String(lead.projectRequests.automated)} />}
            </div>
          </div>
        </li>)}
      </ul>
    </Section>}
    {/* One row per open Request; open it to see the Tickets that deliver it. */}
    {data.requests.length > 0 && <Section title={t('requestsTitle')} count={data.requests.length}>
      <ul className="dt-list">{data.requests.map(request => <RequestEntry key={request.id} request={request} />)}</ul>
    </Section>}
    {/* Open escalations wait for the Orchestrator. It can answer them here, or accept the work into the escalating project's own Ticket from the main Session when the units differ. */}
    {data.escalations.length > 0 && <Section title={t('escalationsTitle')} count={data.escalations.length}>
      <ul className="dt-list">{data.escalations.map(item => <EscalationEntry key={item.id} item={item} onChanged={reload} />)}</ul>
    </Section>}
    {/* Observe-mode self report drafts wait for a person; auto mode files directly and accumulates none here. */}
    {selfReports.length > 0 && <Section title={t('selfReportsTitle')} count={selfReports.length}>
      <ul className="dt-list">{selfReports.map(item => <SelfReportEntry key={item.id} item={item}
        blocked={data.selfReportsBlocked ?? false} onChanged={reload} />)}</ul>
    </Section>}
    {/* Automation records that lost their Host task or failed delivery; the Automations page has their history. */}
    {data.automationAttention.count > 0 && <Section title={t('automationAttentionTitle')} count={data.automationAttention.count}
      action={more({ page: 'tasks' })}>
      <ul className="dt-list">{data.automationAttention.items.map(item => <li key={item.id} className="dt-row"
        data-automation-attention={item.id}>
        <div className="dt-row-main">
          <div className="dt-att-what">{item.title}</div>
          <p className="dt-hint">{item.error}</p>
        </div>
      </li>)}</ul>
    </Section>}
    {data.problems.length > 0 && <Section title={t('problems')} count={data.problems.length}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={reload} />)}</ul>
    </Section>}
    <Section title={t('lastDay')} action={more({ page: 'trigger', query: { filter: 'recent' } })}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      <div className="dt-stats">
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
      </div>
    </Section>
    {data.outbox.pending > 0 && <Section title={t('outboxTitle')} count={data.outbox.pending}>
      <p className="dt-hint">{t('outboxSummary', { pending: String(data.outbox.pending), failing: String(data.outbox.failing),
        oldest: when(data.outbox.oldestAt, t('lang')), next: when(data.outbox.nextAt, t('lang')) })}</p>
    </Section>}
    <Section title={t('term.executor')} action={more({ page: 'execution' })}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
    </Section>
  </>
}
