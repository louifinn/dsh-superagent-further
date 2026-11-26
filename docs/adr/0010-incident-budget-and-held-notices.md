# 0010 — Incident budget, severity exemption and held notices

- Status: Accepted
- Date: 2026-11-26
- Context: Issue #28 and decision 6 of ADR-0009. ADR-0004 caps new incident records per UTC day so a detector cannot
  flood the panel, but a budget refusal was silent: a real detection above the alert threshold could disappear without a
  record and without a notice. The operator asked for both a severity exemption and a held-notice queue.

## Decisions

1. **High and critical conditions are exempt from the daily record budget.** `incidentSeverityBudgetExempt` treats
   `high` and `critical` like the live-outage rules of ADR-0004. The rule, fingerprint, cooldown, open-record cap and
   `minimumSeverity` gates still apply; only the count of new records a day steps aside. A `critical` condition is never
   made quieter by a busy day.
2. **A budget-refused detection becomes a held notice above the alert threshold.** When a new record is refused and
   the detection's severity is at or above `executor.incidents.alertMinimumSeverity`, `Incidents.hold` writes one row to
   `incident_notification` keyed by fingerprint (a repeat joins the waiting notice). A detection the operator's alert
   configuration would drop anyway is not queued; the queue does not bypass that configuration.
3. **The watchdog flushes the queue through the alert chat.** `Incidents.flushNotifications` runs on every watchdog pass
   (also while the Runtime is paused) and stops at the first refusal, so the alert chat's daily allowance is not
   hammered. A sent notice is marked `notified_at` and logged as `incident.notified`; a refused one stays for the next
   pass. The queue is capped at 100 waiting notices, so a burst cannot grow an unbounded backlog.
4. **ADR-0004's boundary stands.** Detection stays deterministic and makes no model call; a held notice is
   notification, not repair. Continue/restore/model-fallback are recovery, incident fixes still need a person or a
   Ticket, and no automatic code or configuration change follows from an incident.

## Consequences

- Schema 26 adds `incident_notification` (id, fingerprint UNIQUE, rule, severity, title, detail, created_at,
  notified_at). No existing record changes; the migration is the schema bump only.
- Operators see `incident.held` / `incident.notified` lines in the `incidents` log scope and the digest still lists open
  records; `heldNotifications()` exposes the waiting count to the service and tests.
- A fresh installation with `alertChatId` empty keeps today's behaviour exactly: no alerts, no queue, records only.
- Tests in `tests/incidents.spec.ts` cover the severity exemption, the queue threshold, the flush-once path and a
  refused flush that keeps its notice.
