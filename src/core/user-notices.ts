/**
 * A durable request to notify a person, and the approval that lets it out (docs/016-information-discipline.md notification
 * section, issue #29, ADR-0009 decision 7).
 *
 * A worker asks its project Lead; a Lead asks the Orchestrator, the installation-level approver. Every request is one row
 * that survives restarts, carries the raiser's words, and is answered once with an approve or a refusal that states why.
 * Approval sends the notice to the person's channel; a failed delivery stays visible as `attention` instead of vanishing.
 */

/** Who may raise a user-notice request: a worker or a project Lead. */
export type UserNoticeRole = 'worker' | 'lead'
/** Who answers it: the direct superior. */
export type UserNoticeApprover = 'lead' | 'orchestrator'
/** Where a request is in its life. */
export type UserNoticeStatus = 'pending' | 'approved' | 'refused' | 'sent' | 'attention'
/** One durable request. */
export interface UserNoticeRecord {
  readonly id: string
  readonly dedupe: string
  readonly session: string
  readonly role: UserNoticeRole
  readonly project?: string
  readonly ticketId?: string
  /** The exact words the person would read, or a short request the approver may reword? The words are preserved; approval does not rewrite them. */
  readonly text: string
  readonly approver: UserNoticeApprover
  readonly approverProject?: string
  readonly status: UserNoticeStatus
  readonly createdAt: string
  readonly decidedAt?: string
  readonly decidedBy?: string
  readonly reason?: string
  /** How the notice went out, when it did. */
  readonly via?: 'channel' | 'alert'
  readonly deliveredAt?: string
  readonly error?: string
  /** The root information record of the request. */
  readonly root: string
}
/** What a raiser supplies; the store stamps the status, id and time. */
export interface UserNoticeInput {
  readonly text: string
  readonly session: string
  readonly role: UserNoticeRole
  readonly project?: string
  readonly ticketId?: string
  readonly approver: UserNoticeApprover
  readonly approverProject?: string
  readonly at: string
}
/** The dedupe key: the same raiser asking for the same words is one request. */
export const userNoticeDedupe = (session: string, text: string): string => `user-notice:${session}:${text}`
/** The approver a raiser's role owes: a worker's Lead, a Lead's Orchestrator. */
export const userNoticeApprover = (role: UserNoticeRole): UserNoticeApprover => role === 'worker' ? 'lead' : 'orchestrator'
/** Whether `record` was approved already (approved, sent or attention) rather than refused. */
export const userNoticeApproved = (record: Pick<UserNoticeRecord, 'status'>): boolean =>
  record.status === 'approved' || record.status === 'sent' || record.status === 'attention'
