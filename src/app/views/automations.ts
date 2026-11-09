/** The panel's Automations page view: the plugin's tasks, their recent deliveries and the projects a new task can target. */
import type { AutomationDeliveryView, AutomationList, AutomationSummary } from '../automations.ts'

/** One registered project offered by the create form's project select. */
export interface AutomationProjectView { id: string; name: string }
/** One task as the panel lists it: its summary plus its newest recorded deliveries, failures and orphan events. */
export interface AutomationPanelItem extends AutomationSummary { history: AutomationDeliveryView[] }
/** The `GET automations` response. Absent Host schedule service is a 503 before this view is built. */
export interface AutomationsView {
  service: true
  items: AutomationPanelItem[]
  unrecorded: AutomationList['unrecorded']
  projects: AutomationProjectView[]
  /** Tasks the panel must flag: orphaned, or holding a delivery or reconciliation error. */
  attention: number
}
