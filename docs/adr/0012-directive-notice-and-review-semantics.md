# 0012 — Directive, user-notice and review semantics

- Status: Accepted
- Date: 2026-11-26
- Context: Issues #20, #21 and #22 (a person may write into any Session; one Directive model, one-shot
  consumption, no reverse adjustment of the source node), #29 (a durable request to inform the person through the
  direct superior's approval) and #34 (a first-class `review` deliverable). Decisions 3–5 and 7–9 of ADR-0009 record
  the operator's answers; docs/016 P8 and its Directive, notification and review sections state the normative rules.
  The implementation had no Directive record, no approval path for a user notice, and no review subtype that names its
  subject.

## Decisions

1. **One Directive record for the three Session kinds.** A `user/message` whose source is the person is recorded in
   the schema 28 `directive` table before anything acts on it: its text, origin message id, source Session, project and
   Ticket when known, the role chain it will climb, its hop count, and its propagation and consumption times. Its
   origin is one `information` record of kind `instruction`, direction `in`, from `person` to the addressed role, with
   the original text as payload. The dedupe key is the source Session and the origin message id, so a redelivery is the
   same Directive and never a second adjustment. There is no second bus: the upward hops are ordinary `information`
   records, and the parent is prompted through the existing Session delivery.
2. **The tree carries the word, not the acknowledgement.** A worker's Directive has hops `worker → lead` and
   `lead → orchestrator`; a Lead's has `lead → orchestrator`; an Orchestrator's owes no hop. Each hop is written
   before the parent is prompted and keeps the original words. The parent may adjust its own work and its other
   branches once with a reason while the Directive is unconsumed, but it may not steer the addressed node against it:
   `lead_notify_worker` and `orchestrator_lead_instruction` refuse with the stable `directiveSourceLocked` UserError
   and write a refused `audit_boundary` row. The Directive is consumed once — by the addressed Agent's turn end for an
   Orchestrator or Lead, and by the worker's report for a worker, which must name `directive_effect` (`acted`,
   `adjusted` or `handback`); `handback` returns the concrete reason to the Lead with the original words. No ack turn is
   generated and no automatic acknowledgement loop is possible.
3. **A user notice is a durable request with an approval chain.** A worker raises `request_user_notice`; a Lead raises
   `lead_request_user_notice`. The direct superior decides (`lead_notice_decide` for a worker's request,
   `orchestrator_notice_decide` for a Lead's) and a refusal must state a reason, which reaches the raiser. An approved
   request is delivered once through the originating Ticket's channel, then the configured alert chat, then attention
   with a durable wake; the request and decision are `information` records, the dedupe key makes a repeated raise the
   same request, and a failed delivery stays visible as `attention`. The top-level fault bypass of docs/016 is not
   automated in this batch and no tool pretends to bypass approval.
4. **`review` is a deliverable, not a change.** `Deliverable` gains `review`; an accept names `review_scope`
   (`repository`, optional `ref`, and the `standard` the review is judged against). The Ticket runs read-only under the
   normal read-only preset, never requires a branch, follow-up or pull request, and completes only on a ready report
   carrying a `clean` or `blocked` verdict and a non-empty coverage statement; `blocked` keeps the Ticket open with the
   findings. A change Ticket that matched the `review` rule, or a review subtype without that rule, is refused with
   the correction (`reviewNeedsSubtype`), and a review without a standard is refused (`reviewNeedsScope`). The Lead's
   independent reviewer for a change Ticket (`lead_review`) remains a separate quality gate and is not this subtype.
   A Request may split a review across projects; each Ticket carries its own subject and report, and the Request's
   result is the one aggregate with the coverage statements.

## Consequences

- Schema 28 adds `directive` (id, root, parent, source and parent Session, origin, dedupe, audience, times, effect,
  value) and `user_notice` (id, dedupe, session, role, project, Ticket, approver, approver project, status, times,
  value), with their indexes; the migration is the schema bump and creates empty tables. No existing record changes.
- `src/core/directives.ts`, `src/app/directive-records.ts` and `src/app/directives.ts` own the Directive; the
  `directives` read resource and `orchestrator_directives` expose the pending queue; `lead_notify_worker` and
  `orchestrator_lead_instruction` enforce the source lock.
- `src/core/user-notices.ts`, `src/app/user-notice-records.ts` and `src/app/user-notices.ts` own the notice; the
  prompt, approve/refuse and delivery steps are durable, and the `user-notice` effect retries.
- `Deliverable` gains `review`; `ReviewScope` and `ReviewReport` live in `src/core/model.ts`; accept, assessment,
  routing/HTTP, report and cards carry the subject and the verdict.
- Tests: `tests/directives.spec.ts`, `tests/user-notices.spec.ts` and `tests/review.spec.ts`; the schema assertions and
  the 27→28 migration test in `tests/information.spec.ts` and `tests/migration.spec.ts`; the updated property and tool
  expectations in `tests/properties.spec.ts` and `tests/tools.spec.ts`.
- Docs: `docs/003-execution.md` gains the Directive, user-notice and review sections; `docs/007-architecture.md` registers
  the modules, effects and specs; `docs/016-information-discipline.md` links this ADR.
