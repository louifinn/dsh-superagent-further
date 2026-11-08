/** First-run setup wizard entry: the auto-open hook and the header button that reopens the wizard after a skip. */
import { useEffect, useState } from 'react'
import { Button, Icon } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'

/** Marks that this browser session already opened the wizard by itself; the server's record decides across sessions. */
const OPENED_KEY = 'dsh-superagent/wizard-opened'
export interface SetupWizardState {
  open: boolean
  /** Open the wizard from the header entry. */
  show: () => void
  /** Close the wizard after a skip or a finish. */
  close: () => void
}
/**
 * Auto-open the setup wizard once per browser session while the host reports a first run, without blocking other pages.
 * The server's `PUT wizard` record stays authoritative across sessions, so finishing or skipping it anywhere stops the
 * auto-open; the sessionStorage marker only stops a reload from showing the same wizard twice.
 */
export function useSetupWizard(): SetupWizardState {
  const { state } = usePanelData()
  const [open, setOpen] = useState(false)
  const firstRun = state?.wizard?.firstRun ?? false
  useEffect(() => {
    if (!firstRun || sessionStorage.getItem(OPENED_KEY)) return
    try { sessionStorage.setItem(OPENED_KEY, '1') } catch (error) { void error /* Auto-open must not break the page. */ }
    setOpen(true)
  }, [firstRun])
  return { open, show: () => setOpen(true), close: () => setOpen(false) }
}
/** The permanent panel header entry that opens the setup wizard, including after it was skipped. */
export function SetupWizardButton({ onClick }: { onClick: () => void }) {
  const { t } = usePanel()
  return <Button variant="ghost" size="sm" icon={<Icon name="review" size={14} />} aria-haspopup="dialog" onClick={onClick}>
    {t('wizardOpen')}
  </Button>
}
