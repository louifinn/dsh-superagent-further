/**
 * First-run setup wizard: select the mandatory Orchestrator workspace, register a project, check the GitHub agent account,
 * optionally enable Feishu, and choose the default language. Every step after the workspace can be skipped or revisited, and
 * the wizard can be skipped from any of those steps. The server keeps SuperAgent paused until a workspace is selected, but
 * the dialog itself can always be closed: leaving setup unfinished never traps the operator in the wizard.
 */
import { useState } from 'react'
import { LIMITS } from '../limits.ts'
import type { Project } from '../projects.ts'
import { Button, Icon, Input, Modal, Switch } from './controls.tsx'
import type { DshSuperagentFurtherKey } from './locales.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { Field, SettingsProvider, useSettings } from './settings-kit.tsx'
import { errorText } from './text.ts'
import { CheckSetupButton, Hint, LabelValue, SetupMessage } from './widgets.tsx'

const STEPS = ['welcome', 'workspace', 'project', 'account', 'feishu', 'language', 'done'] as const
type WizardStep = typeof STEPS[number]
const PRIMARY: Record<WizardStep, DshSuperagentFurtherKey> = {
  welcome: 'wizardStart', workspace: 'wizardSave', project: 'wizardSave', account: 'wizardNext', feishu: 'wizardSave',
  language: 'wizardSave', done: 'wizardFinish',
}
const BLANK: Project = { id: '', name: '', workspace: '', repository: '', branch: '' }
const stepTitle = (step: WizardStep): DshSuperagentFurtherKey => `wizardStep.${step}` as DshSuperagentFurtherKey

/** Modal shell for the first-run setup wizard; `onClose` also ends the wizard when a step records a skip. */
export function SetupWizard({ onClose }: { onClose: () => void }) {
  return <SettingsProvider><WizardFrame close={onClose} /></SettingsProvider>
}

/**
 * The dialog can always be closed: the workspace gates SuperAgent's work through the paused runtime, not the operator
 * through the modal. Closing records nothing, so the first run stays open and the header entry reopens the wizard.
 */
function WizardFrame({ close }: { close: () => void }) {
  const { t } = usePanel()
  return <Modal className="dt-wizard" open onClose={close} title={t('wizardTitle')} closeLabel={t('close')}
    description={t('wizardIntro')}>
    <p className="dt-hint">{t('wizardClosableHint')}</p>
    <Wizard close={close} />
  </Modal>
}

function Wizard({ close }: { close: () => void }) {
  const { t, call, navigate, notify, restart } = usePanel()
  const { setup, reload } = usePanelData()
  const { settings, reload: reloadSettings } = useSettings()
  const [step, setStep] = useState<WizardStep>('welcome')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [project, setProject] = useState<Project>(BLANK)
  const [languageName, setLanguageName] = useState(settings.blocks.language.value.default)
  const [workspacePath, setWorkspacePath] = useState(settings.blocks.workspace.value.path)
  const feishu = settings.sources.find(source => source.kind === 'feishu')
  const [feishuOn, setFeishuOn] = useState(feishu?.value.enabled ?? false)
  const executor = settings.blocks.executor
  const language = settings.blocks.language
  const workspace = settings.blocks.workspace
  // A selected workspace is what makes the wizard's remaining steps reachable at all.
  const workspaceSet = workspace.value.path.trim() !== ''
  const projectReady = project.id.trim() !== '' && project.name.trim() !== '' && project.workspace.trim() !== ''
    && project.repository.trim() !== ''

  /** Move one step; the ends of the list stay put. Navigation clears the previous step's error or save status. */
  const go = (direction: 1 | -1) => {
    setError(undefined); setStatus(undefined)
    setStep(current => STEPS[Math.min(Math.max(STEPS.indexOf(current) + direction, 0), STEPS.length - 1)] ?? current)
  }
  /** Run one save or skip, surfacing its failure in the dialog and its restart state in a hint instead of only a toast. */
  const perform = async <R,>(task: () => Promise<R>, done: () => Promise<void> | void) => {
    if (busy) return
    setBusy(true); setError(undefined); setStatus(undefined)
    try {
      const result = await task()
      // `restarting` appears on settings saves only; other routes return records that do not carry it.
      if (typeof result === 'object' && result !== null && 'restarting' in result && result.restarting === true) {
        setStatus(t('wizardRestarting')); restart()
      }
      await done()
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  const saveWorkspace = () => {
    const path = workspacePath.trim()
    if (path === '' || path === workspace.value.path) { go(1); return }
    void perform(() => call('PUT settings/:block', { block: 'workspace', body: {
      value: { path }, revision: workspace.revision } }), async () => { setWorkspacePath(path); await reloadSettings(); go(1) })
  }
  const saveProject = () => { void perform(async () => call('PUT settings/:block', { block: 'executor', body: {
    value: { ...executor.value, projects: [...executor.value.projects, { id: project.id.trim(), name: project.name.trim(),
      workspace: project.workspace.trim(), repository: project.repository.trim(), branch: project.branch.trim() }] },
    revision: executor.revision } }), async () => { setProject(BLANK); await reloadSettings(); go(1) }) }
  const saveFeishu = () => {
    // An unchanged switch does not need a save; it would only add a settings revision.
    if (!feishu || feishuOn === feishu.value.enabled) { go(1); return }
    void perform(() => call('PUT settings/:block', { block: `source:${feishu.id}`, body: {
      value: { enabled: feishuOn, config: feishu.value.config }, revision: feishu.revision } }), async () => {
      await reloadSettings(); go(1)
    })
  }
  const saveLanguage = () => {
    const name = languageName.trim()
    if (!name || name === language.value.default) { go(1); return }
    void perform(() => call('PUT settings/:block', { block: 'language', body: {
      value: { default: name }, revision: language.revision } }), async () => { setLanguageName(name); await reloadSettings(); go(1) })
  }
  const finish = (skipped: boolean) => { void perform(() => call('PUT wizard', { body: { skipped } }), async () => {
    await reload()
    notify(t(skipped ? 'wizardSkipped' : 'wizardFinished'))
    close()
  }) }
  const primary = () => {
    switch (step) {
      case 'workspace': return saveWorkspace()
      case 'project': return saveProject()
      case 'feishu': return saveFeishu()
      case 'language': return saveLanguage()
      case 'done': return finish(false)
      default: return go(1)
    }
  }
  // The workspace step gates everything after it: without a selected workspace no later primary action is offered.
  const ready = step === 'welcome' ? true
    : step === 'workspace' ? workspacePath.trim() !== ''
      : !workspaceSet ? false
        : step === 'project' ? projectReady
          : step === 'language' ? languageName.trim() !== '' : true
  const body = (() => {
    switch (step) {
      case 'welcome': return <>
        <p className="dt-hint">{t('wizardWelcome')}</p>
        <ol className="dt-wizard-steps">{[t('wizardStep.workspace'), t('wizardStep.project'), t('wizardStep.account'),
          t('wizardStep.feishu'), t('wizardStep.language')].map((title, index) => <li key={title} className="dt-wizard-step">
          <span className="dt-wizard-number">{index + 1}</span>{title}
        </li>)}</ol>
      </>
      case 'workspace': return <>
        <p className="dt-hint">{t('wizardWorkspaceIntro')}</p>
        {setup?.workspace && <div className="dt-row-meta">
          <LabelValue label={t('wizardWorkspaceCurrent')} value={setup.workspace.title} />
        </div>}
        <Field label={t('wizardWorkspaceLabel')} hint={t('wizardWorkspaceHint')}
          note={workspaceSet ? undefined : t('wizardWorkspaceMandatory')}>
          <Input className="dt-mono" required spellCheck={false} value={workspacePath}
            placeholder={t('wizardWorkspacePlaceholder')} onChange={event => setWorkspacePath(event.target.value)} />
        </Field>
        {setup?.problem?.place === 'execution' && <SetupMessage problem={setup.problem} />}
      </>
      case 'project': return <>
        <p className="dt-hint">{t('wizardProjectIntro')}</p>
        {executor.value.projects.length > 0 && <Hint>{t('wizardProjectExisting', { count: String(executor.value.projects.length) })}</Hint>}
        <div className="dt-grid3">
          <Field label={t('projectId')} hint={t('projectIdHint')}><Input className="dt-mono" required maxLength={40}
            pattern="[a-z0-9][a-z0-9\-]*" spellCheck={false} placeholder="app" value={project.id}
            onChange={event => setProject({ ...project, id: event.target.value })} /></Field>
          <Field label={t('projectName')}><Input required maxLength={LIMITS.projectName} value={project.name}
            onChange={event => setProject({ ...project, name: event.target.value })} /></Field>
          <Field label={t('projectRepository')} hint={t('projectRepositoryHint')}><Input className="dt-mono" required
            spellCheck={false} placeholder="owner/name" maxLength={LIMITS.projectRepository} value={project.repository}
            onChange={event => setProject({ ...project, repository: event.target.value })} /></Field>
        </div>
        <Field label={t('projectWorkspace')} hint={t('projectWorkspaceHint')}><Input className="dt-mono" required spellCheck={false}
          maxLength={LIMITS.projectPath} value={project.workspace}
          onChange={event => setProject({ ...project, workspace: event.target.value })} /></Field>
        <Field label={t('projectBranch')} hint={t('projectBranchHint')}
          note={project.branch ? undefined : t('projectBranchEmpty')}><Input className="dt-mono" maxLength={LIMITS.projectBranch}
          spellCheck={false} value={project.branch} onChange={event => setProject({ ...project, branch: event.target.value })} /></Field>
      </>
      case 'account': return <>
        <p className="dt-hint">{t('wizardAccountIntro')}</p>
        {setup?.problem && <SetupMessage problem={setup.problem} />}
        {setup?.accounts ? <div className="dt-row-meta">
          <LabelValue label={t('wizardAccountRepository')} value={setup.accounts.repository} />
          <LabelValue label={t('wizardAccountAgent')} value={setup.accounts.agent} />
        </div> : !setup?.problem && <Hint>{t('wizardAccountPending')}</Hint>}
        <CheckSetupButton />
      </>
      case 'feishu': return <>
        <p className="dt-hint">{t('wizardFeishuIntro')}</p>
        {setup?.accounts?.feishu ? <div className="dt-row-meta">
          <LabelValue label={t('wizardFeishuApp')} value={setup.accounts.feishu.appId} />
          <LabelValue label={t('wizardFeishuName')} value={setup.accounts.feishu.name} />
        </div> : <Hint>{t('wizardFeishuUnset')}</Hint>}
        {feishu ? <div className="dt-switch-row">
          <div className="dt-field-head">{t('wizardFeishuEnable')}</div>
          <Switch checked={feishuOn} onChange={setFeishuOn} label={t('wizardFeishuEnable')} />
        </div> : <Hint>{t('wizardFeishuUnavailable')}</Hint>}
        {feishu && <div className="dt-actions">
          <Button variant="ghost" size="sm" icon={<Icon name="external" size={14} />} onClick={() => {
            close(); navigate(settingsRoute('source', { source: feishu.id }))
          }}>{t('wizardFeishuSettings')}</Button>
        </div>}
      </>
      case 'language': return <>
        <p className="dt-hint">{t('wizardLanguageIntro')}</p>
        <Field label={t('languageDefaultLabel')} hint={t('languageDefaultHint')}><Input maxLength={LIMITS.languageName}
          placeholder={t('languageDefaultPlaceholder')} value={languageName}
          onChange={event => setLanguageName(event.target.value)} /></Field>
        <Hint>{t('languageExamples')}</Hint>
      </>
      case 'done': return <>
        <p className="dt-hint">{t('wizardDoneIntro')}</p>
        <ul className="dt-wizard-steps">
          <li className="dt-wizard-step"><span className="dt-wizard-number">✓</span>
            {t('wizardDoneWorkspace', { workspace: setup?.workspace?.title ?? workspacePath })}</li>
          <li className="dt-wizard-step"><span className="dt-wizard-number">✓</span>
            {t('wizardDoneProjects', { count: String(executor.value.projects.length) })}</li>
          <li className="dt-wizard-step"><span className="dt-wizard-number">✓</span>{setup?.accounts
            ? t('wizardDoneAccount', { agent: setup.accounts.agent }) : t('wizardDoneAccountPending')}</li>
          <li className="dt-wizard-step"><span className="dt-wizard-number">✓</span>{setup?.accounts?.feishu
            ? t('wizardDoneFeishu', { name: setup.accounts.feishu.name }) : t('wizardDoneFeishuSkipped')}</li>
          <li className="dt-wizard-step"><span className="dt-wizard-number">✓</span>
            {t('wizardDoneLanguage', { language: languageName.trim() || language.value.default })}</li>
        </ul>
      </>
    }
  })()
  return <>
    {step !== 'welcome' && <h3 className="dt-wizard-heading">{t(stepTitle(step))}</h3>}
    {error && <p className="dt-error" role="alert">{error}</p>}
    {status && <p className="dt-hint" role="status">{status}</p>}
    <div className="dt-wizard-body">{body}</div>
    <div className="dt-wizard-actions">
      <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" size={14} />} disabled={step === 'welcome' || busy}
        onClick={() => go(-1)}>{t('wizardBack')}</Button>
      <span className="dt-wizard-spacer" />
      {step !== 'welcome' && step !== 'done' && <Button variant="ghost" size="sm" disabled={busy || !workspaceSet}
        onClick={() => go(1)}>{t('wizardSkipStep')}</Button>}
      <Button variant="ghost" size="sm" disabled={busy || !workspaceSet} onClick={() => finish(true)}>{t('wizardSkipAll')}</Button>
      <Button variant="primary" size="sm" disabled={busy || !ready} onClick={primary}>{t(PRIMARY[step])}</Button>
    </div>
  </>
}
