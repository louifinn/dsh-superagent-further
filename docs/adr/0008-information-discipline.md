# 0008 — Information discipline: adjacent propagation, one source, one-shot directives, and escalation to the person

- **Status:** accepted
- **Date:** 2026-11-19
- **Deciders:** the operator (direct instruction, 2026-11-19)

## Context

The operator reviewed the multi-project flow and found that the implementation and its documents do not satisfy the
information discipline the organization needs: information must travel only between adjacent levels; same-level
exchange and skipping a level are forbidden; one fact has one authoritative source and one direction; same-level
information is carried by the common parent; information that another level must know is passed on in time; a person's
direct word is authoritative for that message and must travel up as well as down; and a failure must be owned by the
direct superior, with the top reaching the person.

The audit found four structural causes:

- The Lead layer exists in the documents but not in the message path. The Engine starts an Executor directly and the
  Executor's report is relayed directly to the main Session, so the Lead is a parent Session and a project-request
  handler rather than a carrier.
- There is no concept of "one piece of information" with an origin, a direction, a hop count and a one-shot scope. The
  domain records work state; messages are delivery effects. A fact therefore cannot be checked for single source,
  direction or coverage.
- Terminal endings, failures and model errors are recorded for some roles only. Notifications are duplicated in some
  cases and missing in others. The person has no alert channel; incidents live in the panel.
- A person's direct intervention is a single sentence in the Lead prompt. It has no upward propagation, no one-shot
  semantics and no protection against the superior reversing the addressed node's instruction.

The existing decisions do not forbid the change, but two boundaries must be respected: the Engine remains the only
writer of domain records ([001](../001-domain.md)), and operational detection does not repair the system
([ADR 0004](0004-deterministic-incident-detection.md)). Information discipline adds obligations and records; it does not
move domain-writing authority to a Lead and it does not turn detection into repair.

## Decision

1. **Adopt [016 Information discipline](../016-information-discipline.md) as normative** for the direction, source,
   ownership and timeliness of information. Where an earlier document describes a different direction — in particular a
   worker report reaching the main Session directly, or an assignment from the Orchestrator reaching an Executor — 016
   is normative for the target, and the earlier text is history to be reconciled.

2. **The Lead is the mandatory carrier of its project.** Work descends Orchestrator → Lead → Executor; reports and
   terminal endings ascend Executor → Lead → Orchestrator. The Orchestrator does not send work or facts directly to an
   Executor, and an Executor does not report to the Orchestrator. A same-level message is carried by the common parent:
   a worker's message to another worker goes through the Lead; a Lead's message to another Lead goes through the
   Orchestrator. A forward preserves the original text and its provenance; the parent may attach its own decision, not
   rewrite the fact.

3. **One fact has one authoritative record and one direction.** Delivery, retry, a second channel or a summary is not a
   second source. The direction of a fact is fixed by its origin and, for a Directive, by the deformation of the tree section of 016.
   Reverse propagation is forbidden. Two notifications of the same fact to the same recipient are a defect, not
   redundancy.

4. **A person's direct word is a Directive.** It is authoritative for that message within the addressed level's
   authority; it never changes Policy, a Mandate or a scope. It is propagated upward to the Orchestrator and downward to
   the affected branches in one pass; the addressed node is the temporary highest source for that message; the parent
   may adjust its other branches and its own work but must not reverse the addressed node's instruction; the
   Orchestrator may adjust other projects but not reverse the source project's adjustment. The Directive is consumed
   once; a redelivery is a duplicate, not a second adjustment. The exact jurisdiction is in 016, Directives.

5. **Timely propagation is an obligation.** A terminal ending, a failure that changes what a level can do, a Directive,
   an escalation and a cross-project dependency must be passed on within the level's current turn, or recorded and
   escalated. Routine progress remains silent. "The panel shows it" is not propagation.

6. **Notification to the person is authorized information.** An Executor asks its Lead; a Lead asks the Orchestrator; the
   Orchestrator may speak. Every request is durable and answered. A top-level failure is the exception: the person is
   alerted directly, with the concrete identity of the failure, and the alert is audited. Channel selection follows
   016, Notification and channels: the source conversation first, one configured alert channel for urgency, GitHub on GitHub, the panel and
   the digest as slow surfaces.

7. **Failure ownership follows the tree.** The Lead owns an Executor's failure; the Orchestrator owns a Lead's failure;
   the person owns the Orchestrator's failure in the sense that it must reach them. Recovery follows one ladder —
   continue, retry, degrade the model, replace the executor, escalate — with a bound and a record at each step. A
   persistent model failure uses the parent's model, then escalates. A person's explicit stop or hold is never
   overridden.

8. **Recovery is not repair.** Automatic continuation, retry, model degradation and re-dispatch restore the flow of
   work. They do not change code, Policy, settings or a Mandate, and they do not resolve an incident. ADR 0004's
   "detect, never fix automatically" stands; 016, Failure, recovery and model degradation and this decision distinguish restoration from repair.

9. **Noise control may delay, merge or group; it may not delete a live high-severity fact** from the record or from the
   notification path. A budget that would silently drop a critical condition is a defect.

10. **A review request is a subject, not a change.** "Review the whole repository" has a named subject, a report, its
    evidence and a coverage statement, and never requires a pull request. The independent reviewer a Lead starts for a
    change Ticket is a quality gate for that change, not the requested review.

## Rejected alternatives

- **Keep the flat prototype model and document the Lead as optional.** It fails the operator's requirement that the
  Lead carry information and that a person's direct word deform the tree; it also leaves the existing half-migrated
  state in place.
- **A second durable message bus.** It would create a second authoritative source and contradict the single-writer
  rule. One record per fact plus delivery effects is enough; the record, not the bus, is authoritative.
- **Express the discipline only in prompts.** Prompts cannot guarantee direction, single source or one-shot semantics,
  and they cannot be tested for coverage. The discipline needs records and obligations in the core; prompts describe
  them to the model.
- **Automatic repair on failure.** It would contradict ADR 0004 and make the repair indistinguishable from the fault.
  Recovery may restore flow; repair remains a person's or a Ticket's work.
- **A separate notification subsystem with its own truth.** The notifications must derive from the same authoritative
  facts; a second store would drift. The alert channel is a delivery route, not a second record.
- **Treat the person as a membership entity.** A person stays outside the membership model; the Directive is the record
  of an intervention, not an identity.

## Consequences

- The target direction differs from the current implementation in several places; the gap is tracked as issues under
  the information-discipline epic (#11), not silently ignored. The documentation is normative now; the code follows.
- The Lead gains obligations and loses none of its existing limits: it still proposes rather than writes domain records,
  and it still cannot change Policy, settings or another project's state.
- A Directive adds a small amount of state and a one-pass propagation plan. The "few concepts" rule of 000 is amended
  deliberately: Information and Directive are the minimum concepts that can carry origin, direction and one-shot
  authority; no existing concept can.
- Duplicate terminal notifications become defects to remove, not features to preserve. Some users may notice fewer
  messages; that is the intent.
- A top-level failure now has a path to the person. This adds a message in a rare case and must be deduplicated and
  audited.
- Documentation 000/001/002/003/004/005/007/009/010/011/012 is reconciled by the same program; where a historical
  statement is kept, it is marked as history.
- Tests gain an information-propagation acceptance baseline (the "must know" set, direction, count and timeliness),
  rather than only per-module state tests.

## References

- [016 Information discipline](../016-information-discipline.md)
- [000 Philosophy](../000-philosophy.md), [001 Domain model](../001-domain.md), [002 Authorization](../002-authorization.md),
  [003 Execution](../003-execution.md), [007 Architecture](../007-architecture.md),
  [010 Project-level orchestrator](../010-project-orchestrator.md), [012 Project requests](../012-project-requests.md)
- [ADR 0001](0001-ticket-end-authority.md) — ticket end authority
- [ADR 0004](0004-deterministic-incident-detection.md) — detect, never fix automatically
- The information-discipline epic (#11) and its child issues in the repository's issue tracker
