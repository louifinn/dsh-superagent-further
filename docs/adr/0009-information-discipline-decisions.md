# 0009 — Information-discipline implementation decisions

- Status: Accepted
- Date: 2026-11-26
- Context: Epic #11 (`docs/016-information-discipline.md` and ADR 0008) leaves the data model, tool names, timeout
  values, isolation boundary and acceptance harness to the tracked issues. The operator answered the twelve open
  questions on 2026-11-26. This record fixes those answers so implementation can proceed; it does not restate P1–P12.

## Decisions

1. **Information records (#13): full `InfoRecord` domain model.** Every cross-role message first becomes an authority
   record carrying its source, target, direction, hop count, root, one-shot flag, expected audience and delivery/ack
   state; delivery only renders that record. This is the largest available change and is accepted as the foundation for
   the remaining items.
2. **Same-level relay (#14): full cross-project Lead channel.** A same-project relay preserves the original text and
   provenance; a cross-project relay goes source Lead → Orchestrator → target Lead and leaves three auditable hops. No
   same-level direct path exists.
3. **User intervention (#20): one Directive model for all three session kinds, in phases.** A Directive takes effect
   inside the layer's Mandate and propagates up and down to the must-know set; the Orchestrator and Lead phases come
   first, the Worker phase follows. All documentation and prompts describe that one model.
4. **One-shot and tree deformation (#21): implement the full rules with #20.** A Directive records its source session
   and effective scope, its propagation plan is consumed once, and no upper layer may steer the source node against it.
5. **Worker direct input (#22): keep it and treat it as a Directive.** The worker executes within its Mandate and its
   next report carries the user's original words and their effect to the Lead; going beyond the Mandate hands back.
6. **Incident budget and ADR-0004 boundary (#28): both.** Critical/high incidents are exempt from (or have their own)
   daily budget, and a delayed-notification queue holds what the budget would have dropped. A new ADR states that
   continue/restore/model-fallback are recovery, alerting is notification, and code/configuration repair still needs a
   person or a Ticket; ADR-0004's “detect, do not fix” stands.
7. **User-notification approval chain (#29): a durable request entity with per-layer approval.** A worker or Lead
   raises one durable user-notice request; its direct superior approves or rejects with a reason, the Orchestrator is the
   installation-level approver, sending happens per Channel, retries survive restarts and failures are visible. Top-level
   incidents may bypass approval but stay audited (see #28/#19).
8. **Cross-Source correlation (#32): an explicit mark, not automatic merging.** The Orchestrator may mark two requests
   as the same need; the panel shows the link; each origin Channel gets one result and the work is delivered once.
   Automatic similarity merging is rejected as unreliable.
9. **Repo-wide review (#34): a first-class `review` subtype of the answer contract.** It names the repository/ref and
   the standard it checks, carries a report and an explicit coverage statement, is never a change and never asks for a
   pull request; one request may split into per-project units and aggregates into one result.
10. **Isolation (#37): operator/trust boundary, with detection.** The shared sqlite and `danger-full-access` are not a
    security boundary; the decision accepts that risk explicitly and adds detection/audit for cross-layer reads, and
    records it in SECURITY.md and a security-review note. Role-level isolation stays a separate future option.
11. **Epic #11: stay open.** It closes when the #38 acceptance baseline passes, not when individual children land.
12. **Acceptance baseline (#38): a propagation rehearsal with CI.** Given an information record and a session tree, the
    harness asserts the must-know set, direction, count and timeliness; it covers normal, failure, user-intervention and
    all-layer model-failure paths and runs in CI or as a release gate. It is implemented after #13/#20 give it a model.

## Consequences

- #13 is the critical path: #14, #20/#21, #29 and #38 consume its record model.
- Batch A (independent risk removals): #28, #32, #37.
- Batch B (information discipline v2): #13, then #14, #20/#21/#22, #29, #34.
- Batch C (acceptance): #38, then close #11.
- The prompts, docs 000/001/003/004/005/010/012 and the panel follow each batch; no second normative document is added.

## Links

- Normative discipline: `docs/016-information-discipline.md`
- Original architecture decision: `docs/adr/0008-information-discipline.md`
