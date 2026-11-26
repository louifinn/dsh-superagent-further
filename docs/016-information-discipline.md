# 016 Information discipline

Status: **normative** (accepted by the operator on 2026-11-19). [ADR 0008](adr/0008-information-discipline.md) records
the decision. This document adds the missing requirements to the earlier documents; it does not replace them. Where an
earlier document describes a different direction or ownership of information, this document is normative for the
direction, the source and the obligation, and the earlier text is to be read as history until it is reconciled.

This document is written as a discipline, not as a code design. It describes what the organization of agents must know,
who must tell whom, and what "timely" means. How a deployment stores or delivers a message is an implementation detail;
the obligations below do not depend on it.

## Why information discipline

An agent organization can fail in two ways: it can do the wrong work, or it can know the wrong things. The earlier
documents address the first — authority, Mandates, admission, evidence. They do not address the second. Three failures
follow from that gap:

- **A level acts without what another level knows.** An Orchestrator accepts work that a Lead already knows is blocked;
  a Lead adjusts a project while a worker holds a person's direct instruction; a worker reports a result the Lead never
  sees.
- **The same fact arrives twice, in different words.** A merged pull request produces a pull-request notice and a
  request result; a project request produces a third. The person must reconcile them.
- **A fact that should move does not move.** A terminal ending, a model failure, a person's direct word, or an escalation
  stays where it happened because no level owns the obligation to pass it on.

Attention is scarce, but ignorance is more expensive. The philosophy of [000](000-philosophy.md) says: speak only when a
person must act or can use a result. That rule is about *progress reports*, not about *necessary knowledge*. A message
that prevents a wrong action, or that lets a level adjust before damage, earns its cost. Silence while working remains a
virtue; silence about what another level must know is a defect.

## The tree and its deformation

The organization is a tree of authority. The person stands above the Orchestrator; the Orchestrator above each project
Lead; a Lead above its Executors and its reviewer; Sources feed the Orchestrator. Normally the person holds the
Orchestrator, and information flows down the tree while results flow up.

A person may speak directly to any level. That act is not a permanent promotion and not a policy change. For that one
message the addressed node is lifted: it becomes the temporary highest source, its parent hangs below it for that
message, and the rest of the tree deforms under gravity. Information then follows the deformed shape: down from the
lifted node to its descendants, and up to the Orchestrator as the level that must know, and from the Orchestrator down
to the other Leads that must adjust.

The deformation is per message. The next message starts from the normal tree. No chain of automatic acknowledgements may
form: one input is propagated once and is then consumed.

## Principles

**P1 — Adjacent levels only.** Information travels between a level and its direct parent or direct child. A message that
would skip a level is carried by the skipped level, not sent around it.

**P2 — No same-level direct exchange.** Two Executors of the same Lead, two Leads, or two reviewers do not speak to each
other. Their common parent carries the information. A level also does not read another level's authoritative records or
files directly: a shared store is not a communication channel. Where the runtime shares storage, the deployment isolates
the reads or records the residual risk and detects it; a tool-level absence is not a guarantee.

**P3 — No skipping.** The Orchestrator does not send work or facts to an Executor; the Executor does not report to the
Orchestrator. The Lead is the mandatory carrier in both directions.

**P4 — One authoritative source per piece of information.** Every fact has one origin and one authoritative record. A
delivery, a retry, a second channel or a summary is not a second source. A forward preserves the original text and its
provenance; an upper level may add its own decision, but may not rewrite the fact and present it as the original.

**P5 — One direction per piece of information.** For one fact, every adjacent pair has one direction, fixed by the
origin and the deformation. Reverse propagation is forbidden. Different facts may travel in different directions; the
rule applies per fact, not to the network as a whole.

**P6 — Same-level information goes through the parent.** Within a project, an Executor's message to another Executor goes
Executor → Lead → Executor. Across projects, it goes source Lead → Orchestrator → target Lead. The parent may attach a
work-arrangement decision, but the original information stays distinguishable from it.

**P7 — Timely propagation is an obligation, not a courtesy.** Whoever learns something another level must know passes it
on within its current turn, or records why it cannot and escalates. A terminal ending, a failure that changes what a
level can do, a person's direct word, an escalation and a cross-project dependency are always "must know". Routine
progress is not.

**P8 — A person's direct word is authoritative and one-shot.** When a person writes directly into Orchestrator, Lead or
Executor:

- the message is a Directive: it is executed by the addressed level within its authority without asking an upper level
  for permission; it never changes Policy, a Mandate or a scope;
- it must be propagated upward immediately (the Orchestrator must know) and downward to the levels whose work it
  changes;
- for that message the addressed node is the temporary highest source. Its parent may adjust the *other* branches and
  its own work, but may not reverse or overrule the addressed node's instruction; the Orchestrator may adjust other
  projects, but not reverse the source project's adjustment;
- it is effective once. The propagation is one pass, not a recursive loop; repeating the same message does not repeat
  the adjustment.

**P9 — Every executor's information follows the same discipline.** A reviewer, an automation, a diagnosis, an external
session and a worker are all sources of information. Their facts move by P1–P7. A Lead that receives a new finding is
not always obliged to tell the Orchestrator: routine local findings may stay in the project. The obligations of P7 —
terminal events, failures, directives, escalations, cross-project effects, commitments to a person — still apply.

**P10 — Ordinary requests follow the same tree.** A request from Feishu or GitHub enters at the Orchestrator (or, for a
follow-up on a Ticket's own Thread, at that Ticket's Executor under its Mandate); its acceptance, adjustment and result
travel Orchestrator → Lead → Executor and back. No skipping, no multi-head acceptance, no duplicate delivery, no
reverse routing.

**P11 — Silence about progress, not about knowledge.** "Stay quiet while working" governs unsolicited progress
narration. It never justifies withholding a fact that changes another level's decision, a terminal state, or a failure.

**P12 — Every failure has an owner and a path to the top.** A failure is not finished when it is recorded in a panel. It
belongs to the direct superior, and when no superior can act, it reaches the person. The top is never allowed to be
uninformed.

## Roles and their information obligations

- **Person.** The ultimate authority. Not a membership concept in the domain model; a person's direct word is recorded
  as a Directive, not as an identity or a Mandate. A person may address any level; the answer returns to the level and
  channel addressed.
- **Orchestrator.** The single entry for Sources and for cross-project work. It owns the whole tree's knowledge of
  admission and priority. It must: pass work down only to the project Lead; relay a Directive to the Leads whose work
  changes; pass a cross-project fact from one Lead to another through itself; ensure an Orchestrator-level failure
  reaches the person; decide escalations with a reply. It does not bypass a Lead to reach an Executor.
- **Lead.** The mandatory carrier for its project. It must: receive every assignment from the Orchestrator, start and
  steer its Executors, receive every report and every terminal ending of its Tickets, pass up what the Orchestrator must
  know, pass down what its Executors must know, answer every project request, and escalate what it cannot decide. It may
  adjust its project's work for a Directive, but not the Executor the person addressed. It is not a second writer of
  domain records.
- **Executor.** Receives work only from its Lead; reports only to its Lead; raises project requests only to its Lead.
  It never contacts the Orchestrator, another Lead or another Executor. A person's direct word to it is authoritative
  for its work, and must be passed to its Lead in its next report or turn.
- **Reviewer.** A read-only source of a verdict for the Lead. Its verdict goes to the Lead, and nowhere else.
- **Source.** Feeds the Orchestrator with events. It is not a role that decides or routes; its Channel is a delivery
  address for the person.

## Directives

A Directive is the record of a person's direct word. It carries: who spoke, where, the text, the affected project or
Ticket if any, and its one-shot scope. It is not an Eval, not a Decision, not a Mandate.

Propagation for one Directive:

1. The addressed level acts within its authority and acknowledges at that level and channel.
2. It tells its parent. The parent tells its parent, up to the Orchestrator. Each hop records that it received the
   Directive; no level may drop it.
3. The addressed level also tells its direct children whose work changes, except that a Lead does not issue a
   contradicting instruction to the Executor the person addressed. The Orchestrator tells the other Leads whose work
   changes.
4. Each receiving level may adjust its own work and its other branches, once, with a reason. It may not reverse the
   addressed node's instruction.
5. The Directive is consumed. A redelivery of the same message is a duplicate, not a second adjustment.

If a level cannot comply — the instruction is outside its authority, unsafe, or contradicts a Mandate — it does not
quietly refuse. It reports upward with the concrete reason, and the level that can decide does so, or the person is
told.

## New information and derived work

New information arises from: a Source event, an Executor's finding, a reviewer's verdict, a pull request or CI result, an
incident, an automation delivery, a diagnosis, an external session, or the panel. Every source follows P1–P7.

Work is derived only through the accepted paths: an Eval accept, a Lead's accepted project request, an accepted
escalation, an installation-level request, or a discovery request. An Executor never creates a Ticket. A Lead never
creates a cross-project Ticket. A derived request must name its root and its origin; it must have a path for the person
to learn the outcome, or an explicit recorded decision that no person channel exists and why.

The depth of derivation is a product rule, not an accident. The current rule is at most two levels of project request
(root and derived). A deeper derivation needs an explicit new authorization, not a silent continuation. Any derivation
without a root must still carry an ownership and a notification decision.

A Lead receiving a routine local finding may keep it in the project. It must pass it on when it changes another project,
a commitment to a person, a terminal state, a failure, or an escalation.

When the same need arrives through two Sources, it is one intake fact for the Orchestrator: correlate it or record why it
is treated as separate. Two deliveries of one need must not become two unrelated pieces of work by default.

Every Ticket that runs has a project and therefore a Lead. A request no registered project can own is refused at
acceptance; an installation-level Request still names a registered project for every delivery unit, so there is no
project-less Ticket execution path.

A common request shape (a multi-project review, a multi-project change) has an acceptance template: the deliverable, the
delivery units, the dependency edges and, for a review, the subject. A missing field is a concrete rejection with a next
step, never an eventual timeout or a silent downgrade.

## Notification and channels

One fact, one notification per recipient. A recipient is a role or a person, not a channel. Sending the same fact on two
channels to the same recipient is duplication; sending two wordings of the same fact is also duplication.

Channel choice belongs to the fact and the recipient:

- **The source conversation is the default.** A reply goes where the person spoke: the Feishu thread, the GitHub Issue or
  pull request, the external Session.
- **The alert channel is for facts that cannot wait for a source conversation**: a top-level failure, an outage, a
  terminal outcome whose source channel is gone, a Directive that could not be delivered. The operator configures one
  alert channel; it is a channel for urgency, not a second timeline.
- **GitHub stays on GitHub.** A repository fact is not copied to chat merely because a chat exists.
- **The panel and the daily digest are slow surfaces.** They make a fact visible; they do not replace an obligation to
  tell the person who must act.
- **No sender chooses a channel for convenience.** The same fact must not appear in two places with two different
  descriptions.

Notification to the person is itself authorized information. An Executor asks its Lead; a Lead asks the Orchestrator; the
Orchestrator may speak. Every request is durable, answered, and recorded; a refusal states why. A top-level failure is
the exception: the Orchestrator (or the system on its behalf) alerts the person directly, because there is no higher
level to ask. Even then the alert is audited.

A notification is complete when the recipient has it, or when the sender has recorded that the channel is unavailable
and has escalated. "The panel shows it" is not completion.

## Failure, recovery and model degradation

A Session that stops before finishing is not a final state. The level above follows one ladder: continue the work;
retry; degrade and continue; replace the executor; escalate. Each step has a bound and leaves a record. A person's
explicit stop or request to wait is not overridden by this ladder.

A model request that fails is a transient fact first. The affected Session tries again. If the failure persists, it uses
the model its parent is using — the Executor uses the Lead's model, the Lead uses the Orchestrator's model. If the
parent is also failing, the failure escalates one level. If every level fails, the person receives a failure notice with
the concrete identity of the failure: role, Session, Ticket or project, provider and model, error kind and code, time,
what recovery was attempted, and what the person must do. A generic "something failed" notice is not sufficient.

Ownership follows the tree: an Executor's failure belongs to its Lead; a Lead's failure belongs to the Orchestrator; an
Orchestrator's failure belongs to the person. No level may treat a failure as invisible because a panel shows it.

Noise control may delay, merge or group a failure; it may not delete a live high-severity failure from the record or
from the notification path. A budget that would drop a critical fact is a defect, not a feature.

Recovery is not repair. Continuing, retrying, degrading a model and re-dispatching restore the flow of work; they do not
change code, Policy, settings or a Mandate. That boundary is what makes automatic recovery compatible with the
"detect, do not fix" decision of [ADR 0004](adr/0004-deterministic-incident-detection.md); [ADR 0008](adr/0008-information-discipline.md)
records the distinction.

A deployment that cannot yet resolve a parent model does not pretend to degrade: it records the configuration gap and
escalates to the next level. The parent-model rule is the target, not a claim that every current deployment already has
two distinct role models.

## Requests to inform the person

A level that finds something a person must know may ask to tell them. The request is information in its own right and
follows the same discipline:

- **Executor → Lead.** The Executor states the fact, why the person must know, and the evidence. The Lead decides:
  answer within its authority, ask the Orchestrator, or refuse with a reason. If it approves, one notification goes out;
  the Executor is told the outcome.
- **Lead → Orchestrator.** The Lead states the fact, why a person must know, and any cross-project effect. The
  Orchestrator approves and sends, or refuses with a reason. A Lead does not notify the person directly except for a
  fact the Lead owns and the person must act on (for example an approval it is waiting for); even then the Orchestrator
  is informed.
- **Orchestrator → person.** Direct, with the channel rules in the notification and channels section.

Every request is durable and answered. No level may silently swallow a request to inform. An urgent top-level failure
is the only path that bypasses approval, and it is still recorded.

Every request has a deadline. If it is not answered by then, it escalates to the direct superior with the original
request and the elapsed time; the superior may decide, return it with a question, or refuse with a reason. The deadline
is a deployment setting with a safe default, not a value each sender invents.

## Review as a subject

"Review the whole repository" is a review deliverable, not a change. It has a named subject — a repository, a ref, a
standard or a set of paths — a report, evidence and a statement of coverage. It must never require a pull request or a
branch. The acceptance names the subject; when the request spans projects, each project's subject is one delivery unit
and the Request carries one aggregate result.

A Lead may start an independent reviewer for a change Ticket. That reviewer is a quality gate on a change, not the same
thing as a person's requested review. The two must not be conflated in the domain, in the panel or in the result.

## Timeliness and guarantees

"Timely" means: the level that learns the fact acts in its current turn. If its turn has already ended, it acts at the
start of its next turn and no later than its next report. If it cannot deliver in that turn, it records the fact and
escalates; a retry may continue in the background, but the obligation is not suspended. Waiting for a convenient later
moment is not timely.

Before a deployment can claim this discipline, it publishes a **must-know matrix**: for each class of information — a
terminal event, a failure, a Directive, an escalation, a cross-project dependency, a request to inform the person —
which levels must know, in which direction, by which deadline and through which channel. The matrix is the acceptance
basis; a sender does not decide coverage case by case. The matrix lives with the deployment's information policy, and
changing it is a reviewed decision.

Guarantees:

- Every level's inbox is durable. No information that another level must know exists only in a model's context.
- A terminal event is not complete until the levels required by P7 have the fact, or a delivery failure is recorded and
  escalated.
- A Directive is complete when it has reached the Orchestrator and the affected branches have adjusted or refused with
  a reason.
- A failure is complete when its owner has acted or escalated; an Orchestrator failure is complete only when the person
  has been told.
- No fact may be delivered twice to the same recipient, in two wordings, or in the reverse direction.

## Relationship to the earlier documents

This document is the single normative source for the discipline. The earlier documents state the local consequence
for their own subject; a short summary is allowed, but it is subordinate and must not create a second authority. Where
a summary and this document differ, this document wins. Their relationship is:

- [000](000-philosophy.md): the attention rule stands; P11 limits it to progress, not knowledge. The "few concepts" rule
  yields for Information and Directive because no existing concept can carry origin, direction and one-shot authority.
- [001](001-domain.md): a person is still not a membership concept; a Directive is a record of an intervention, not a
  Mandate. The Lead remains a proposer, never a second writer.
- [002](002-authorization.md): authority still comes from the Mandate. A Directive directs work; it does not widen a
  scope, and an out-of-scope instruction is handed back, not obeyed.
- [003](003-execution.md): the ladder, the Lead carrier and the notification duty become explicit.
- [007](007-architecture.md): its description of direct relays is the current implementation, not the target direction.
- [010](010-project-orchestrator.md): the target model stands; the Lead is the mandatory carrier, and every ending
  reaches it, not only a merged pull request.
- [012](012-project-requests.md): D3's mandatory reply stands; D4's "passive parent" is historical; D6 and D13 gain the
  notification duty.
- [011](011-capabilities.md) Part P records the program decisions.
- [ADR 0012](adr/0012-directive-notice-and-review-semantics.md) records the Directive one-shot model, the durable
  user-notice approval chain and the `review` deliverable that implement issues #20–#22, #29 and #34.

## Non-goals

- A second durable message bus, a shared task board or a second notification truth: one authoritative record per fact,
  and delivery is an effect.
- A permanent hierarchy change from a Directive: it deforms the tree for one message and is consumed.
- Automatic repair: recovery restores flow; it does not change code, Policy, settings or a Mandate.
- A person as a membership identity: a Directive records an intervention, not a member.
- Extra progress narration: silence about progress remains the rule.

## Acceptance criteria

A deployment satisfies this document only when all of the following hold and are exercised by an acceptance baseline:

The baseline is executable: `tests/propagation.spec.ts` rehearses a normal Ticket, same-level relays, a failure, a cross-project relay, a person's Directive and a user-notice approval over real Sessions and checks each promise below against the records it produced; `pnpm propagation:check` (part of `pnpm check`) fails when the P1–P12 matrix loses a required edge, path or promise, or when the model starts accepting a forbidden pair (issue #38).

1. The must-know matrix exists and every class names its required levels, direction, deadline and channel.
2. For each terminal event, a trace shows every required level received it, once, in the correct direction and within
   its deadline; a delivery failure is recorded and escalated.
3. Every cross-role message has one authoritative record and one origin; no forbidden edge (Orchestrator↔Executor,
   Lead↔Lead, Executor↔Executor) carries a message; no fact is delivered in the reverse direction.
4. A same-level message reaches the peer only through the common parent, with the original text and provenance intact.
5. A Directive is recorded once, propagates up and down once, leaves the addressed node's instruction un-reversed, and a
   redelivery produces no second adjustment.
6. A same fact produces one user-facing notification per recipient; no two wordings and no second channel for the same
   recipient.
7. Every failure has its direct superior as owner; a persistent model failure uses the parent's model; a full-stack
   failure produces a person alert naming role, Session, Ticket or project, provider and model, error kind and code,
   time and attempted recovery.
8. A request to inform the person is durable, answered, and either sent once or refused with a reason; a top-level
   failure bypasses approval and is audited.
9. A whole-repository review names its subject, delivers a report with evidence and coverage, and never requires a pull
   request.
10. A shared-state read path is isolated or recorded as accepted risk and detected; the discipline is not claimed on the
    strength of tool-level absence alone.
11. The documents keep one normative source: no document contradicts this one; a local summary is subordinate and
    clearly local, never a second authority. `tests/docs.spec.ts` enforces this: only this document carries the P1–P12
    principles, and earlier documents link here instead of restating them.

## Out of scope

The following are decided by the tracked issues, not by this document: storage, schema and tool names; exact timeout
values, alert-channel configuration and severity routing (#19, #31); the shared-state isolation decision (#37); the
must-know matrix format and the acceptance harness (#38); the cross-Source correlation policy (#32); the acceptance
template details (#35); duplicated-document cleanup, terminology and the README index (#36). The implementation order is
a planning decision, not a normative one.

## Open work

The gaps between this discipline and the current implementation are tracked in the repository's issue tracker under the
information-discipline epic (#11). The implementation decisions the operator took on 2026-11-26 are recorded in [ADR 0009](adr/0009-information-discipline-decisions.md); the Batch A incident-budget decision is recorded in [ADR 0010](adr/0010-incident-budget-and-held-notices.md), and the Batch A boundary decision in [ADR 0011](adr/0011-operational-boundary-and-boundary-audit.md). This document deliberately does not prescribe code, storage or tool names; an
implementation may choose them, as long as the obligations above hold.
