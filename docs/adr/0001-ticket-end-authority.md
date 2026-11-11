# 0001 — Ticket-end authority: explicit causes and graceful retirement

- **Status:** accepted
- **Date:** 2026-11-11
- **Deciders:** the operator (approval recorded in the M24 brief), implemented by mission M24, documented by mission M26

## Context

A Report can end the Ticket that made it: a `ready` Report ends an `answer` Ticket, and a `dropped` Report ends its Ticket as the close that deferred it did, or as `dropped`. The ending is committed inside the `orchestrator_report` tool call, while the worker's turn — the model step and the tool call itself — is still running.

On 2026-11-10 that ordering caused an incident. `DshExecutor.stop` disposed the worker's Lead activation immediately after the ending committed; disposing a live activation cancels its running turn, so the report call was aborted after it had already recorded its result, and DSH told the Lead the worker had been stopped. The Lead saw a completed Report and a stopped worker at the same time.

The code could not tell the two teardown situations apart from the Ticket record. `ended` recorded when, by whom and with what outcome, but not why; `stop` therefore inferred from the latest Report's timing whether the worker had ended the Ticket itself. That inference is fragile: a person's stop, a followed pull request's close, an Eval's stop and a retry all end or replace an Assignment, and all of them legitimately want the turn stopped at once.

Worker activations also used DSH `delivery: 'parent'`, so DSH's settlement notice and the application's own durable Lead messages could both tell the Lead that the worker had finished, in different words and at different times. Reviewer activations have the opposite constraint: a reviewer preset has no application tool, so its verdict can only reach the Lead model as DSH's model-facing settlement notice.

## Decision

1. **Record the cause, never infer it.** `Ticket.ended` is `{ at, by, cause, outcome, reason? }`.
   - `TicketEndBy` is `executor` or `human`.
   - `TicketEndCause` is `report` (the worker's own ready or dropped Report), `human` (a person's stop), `merge` (a followed pull request closed) or `eval` (an Eval stopped the Ticket).
   - `TicketOutcome` stays `completed`, `merged`, `closed`, `dropped` or `stopped`.
   - `ExecutorStopCause` is `TicketEndCause | 'retry'`; `retry` ends an Assignment, not a Ticket. `Executor.stop(ticket, assignment, reason, cause)` receives the cause explicitly, and the `ticket.ended` event carries `by`, `cause` and `outcome`.
   - Schema 23 backfills every ended Ticket's cause: `merge` for a followed pull request, `human` for a person's stop, `report` otherwise.

2. **A report-caused end never cancels the reporting turn.** `stop` runs through `Store.afterCommit`, so a rolled-back end leaves the worker running. For cause `report` it takes the activation and waits, bounded by `RETIRE_GRACE_MS` (60 s), for the worker's turn to finish; it then disposes the activation and stops the worker's background work without cancelling the turn. Only a turn that outlives the grace is cancelled, as a user stop, with the Report already recorded. The wait is on the turn, not on background jobs: those are stopped after the turn ends.

3. **External causes preempt.** A `human`, `merge`, `eval` or `retry` stop cancels the running turn and disposes the activation at once, because the work is no longer wanted. A retry then uses the same worker Session for the replacement Assignment.

4. **One notification authority per role.** A worker activation starts with DSH `delivery: 'caller'`, so DSH sends the Lead no settlement notice; the application's durable Lead messages are the only authority that tells the Lead a worker reported or ended. A reviewer activation starts with `delivery: 'parent'`, because the reviewer preset has no application tool: its closing verdict reaches the Lead model only as DSH's settlement notice, and the Lead records it with `lead_review_record`.

5. **Shutdown keeps the same ordering.** Host shutdown disposes every Lead activation, cancels running workers with `keepInbox: true` (which also releases a retirement waiting on a turn), waits for the tracked retirements, then stops background work with `keepInbox: true` and aborts the collection of jobs left to a person.

## Rejected alternatives

- **Defer `ticket.end` until the report tool returns.** The end is domain truth and must commit atomically with the Report; moving it after the tool boundary means a failure or a crash between the two leaves a recorded Report on a Ticket that never ended, and every reader would need a second "about to end" state. The fix belongs in the teardown ordering, not in the domain transaction.
- **Catch `AbortError` in the report tool and keep going.** The tool has already recorded the Report; swallowing the abort hides the cancellation without preventing the activation disposal, the Lead notice or the loss of the rest of the turn. A cancelled tool call is a symptom, not the cause.
- **Filter the false "stopped" notice on the Lead side.** That gives the Lead a second authority and asks a model to reconcile two contradictory notices; the notice still enters its context, and the retirement still aborts the turn. It treats the message rather than the lifecycle.
- **Change DSH's delivery semantics.** DSH already exposes `caller` and `parent` per activation. Neither an upstream change nor a fork is needed; the correct choice is per role.
- **Infer authority from Report recency (the pre-M24 behaviour).** A timestamp cannot say whether the worker's own report ended the Ticket or a person/Eval/PR did it. The inference breaks exactly when the two happen close together, which is the incident.

## Consequences

- The report call completes, its result reaches the worker, and the Lead is not told the worker stopped before its turn ended.
- A report-ended worker can linger for up to 60 s while its turn finishes; background work stops after that turn, not before.
- External stops remain immediate, so a person's stop or a merged pull request does not wait for a model turn.
- The Lead receives exactly one notification stream for workers and exactly the DSH settlement for reviewers.
- Tests: `tests/executor-retirement.spec.ts` pins the grace and the no-cancel path; `tests/migration.spec.ts` and `tests/properties.spec.ts` pin the schema 23 backfill; `tests/lead-dispatch.spec.ts` pins worker `caller` and reviewer `parent`; `tests/core-engine.spec.ts` covers the explicit causes.
- Accepted residual risk: a crash between the Report commit and the retirement leaves the ended Ticket's child Session dormant and idle, with its activation undisposed. The Ticket is already ended, so nothing redispatches it; the child is continuable if a later person's message resumes the Ticket, and shutdown or a restart cleans it up. No report is lost and no second end is written.

## References

- [003 Execution](../003-execution.md) — the worker-lifecycle contract.
- [007 Architecture](../007-architecture.md) — the model fields and `DshExecutor`.
- [010 Project orchestrator](../010-project-orchestrator.md) — the Lead/worker/reviewer dispatch.
- `src/core/model.ts`, `src/core/ports.ts`, `src/core/assignments.ts`, `src/core/tickets.ts`, `src/executor/dsh.ts`, `src/executor/lead-dispatch.ts`.
