/** The panel's Automations page view: the plugin's tasks plus the projects a new task can target. */
import type { AutomationList, AutomationSummary } from '../automations.ts'

/** One registered project offered by the create form's project select. */
export interface AutomationProjectView { id: string; name: string }
/** The `GET automations` response. Absent Host schedule service is a 503 before this view is built. */
export interface AutomationsView {
  service: true
  items: AutomationSummary[]
  unrecorded: AutomationList['unrecorded']
  projects: AutomationProjectView[]
}
