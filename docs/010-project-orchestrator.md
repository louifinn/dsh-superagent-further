# 010 Project-level orchestrator

Status: **accepted** (2026-11-08). The operator opened the design with two observations: the total
Orchestrator and the executors have no project-level layer between them, and executors are root
Sessions in the session list; and the panel's GitHub Source card showed one watched repository even
though the Source polls every registered project. The card is fixed (`2b36d37`). This document plans
the first change; the decisions below were made by the operator in two interview rounds.

## Why

Today one main Session routes every project, and every Ticket gets its own root DSH Session
(`worker-<ticketId>`). With several projects that means:

- the session list grows with Tickets, and the project a Session works on is only visible inside it;
- the main Session carries project-level labour (replies, follow-ups, restarts) for every project;
- the main Session has no way to delegate a whole project: it can accept work and start an executor,
  but it cannot hand the project's day-to-day execution to someone with project context.

A project layer turns Tickets into the unit a **Lead** handles: one persistent Session per project,
which dispatches executors as its own subagents. The main Session keeps the Sources, Eval, Policy and
cross-project priority; the Lead keeps its project's execution.

## What the research found

Three local investigations (reports under `.artifacts/research/`, gitignored) and the repository's
own architecture set the facts:

- **DSH already provides the mechanism.** `@deepseek-ai/dsh-subagent` exposes
  `ctx.subagents.startActivation({provider, label, request:{cwd, agentPreset, prompt, parent},
  signal, delivery})`; the child is a durable DSH Session with `parentSessionId` and
  `origin: 'subagent'`, hidden from the ordinary sidebar and opened from its parent's descendant
  catalog. Completion arrives as a settlement message in the parent's inbox; `send_message`,
  `interrupt_agent` and `list_agents` exist. This is exactly what dsh-tower and Agent Teams use.
  Defaults: `maxDepth: 1`, `maxActiveSubagents: 8`; this profile sets 2 and 10.
- **dsh-tower is the closest blueprint, not a dependency.** It models missions with subagent
  workers/reviewers, a roster, a durable inbox, adoption after restart, and a review/merge gate, with
  per-mission worktrees and `state.json` under `<git-common-dir>/dsh-tower/`. Its spawn pipeline
  (reserve → `startActivation` → record → wait/backoff), two-phase state with revision CAS, and the
  gate codes are worth borrowing as patterns. It cannot be embedded: it assumes one tower per
  repository (`workspaceLock`), fixed tool names and module singletons, so N projects would collide.
- **forge is not an orchestrator.** The installed `@deepseek-ai/dsh-experimental-forge-*` packages are
  a provider-neutral change-request panel bound to Sessions (checks, reviews, diffs), plus a
  worktree/session option; they create no subagents or teams and aggregate nothing across children.
  Its reusable ideas are the evidence-derived projection and the worktree-per-unit-of-work grammar.
- **Our repository has the seams and the blockers.** Projects already exist as data
  (`src/projects.ts`, `Ticket.project`, per-project worktrees in `src/executor/dsh.ts`). Workers are
  root Sessions created by `Sessions.ensure(..., 'worker')`; the worker preset already mounts the
  subagent tools, while the router preset deliberately has none. The Engine is the only writer of
  domain state, and delivery already flows through effects/relay/notice. Blockers for this change:
  `Sessions.decorate` early-returns for agents that are neither the master nor a `worker-<id>`;
  prompt `Role` is a closed union; notices and assessment assume one `masterId`; `DshExecutor` drives
  Sessions through `prompt`/`ensure` and cannot prompt a subagent-owned Session; the panel links
  root worker Sessions; concurrency is a single global `WorkerSlots`.

## Decisions (operator, 2026-11-08)

| Question | Decision |
| --- | --- |
| Topology and visibility | Orchestrator (visible) → **Lead Session per project (visible)** → executors as **hidden subagents** of the Lead |
| Responsibility split | The Orchestrator keeps Source intake, Eval, admission and cross-project priority; the Lead does execution orchestration |
| Lead lifetime | One persistent Session per project, idle between assignments, recovered after a host restart |
| Lead authority | A real LLM orchestrator with guardrails: sequencing, concurrency and model choice, retries, escalation; it never changes Policy or settings |
| Human input | A person may talk directly to a Lead; that is the project's highest-priority human input, but it cannot change Policy |
| Communication | sqlite records are authoritative; effects only deliver (no second durable bus, no shared task board) |
| Naming | Orchestrator (total) / **Lead** (project) / Worker (executor) |
| Restart | The Lead Session is recovered; in-flight executor subagents are adopted when their Sessions still exist, otherwise the Ticket is interrupted and redispatched |
| Concurrency | 2 executor subagents per Lead by default, 8 globally, both configurable |
| First slice | Pure foundation layer first: presets, Session governance, message records and project-aware interfaces, with no entry-point change |
| Unresolvable project | Refuse the acceptance and point at **Execution → Projects**; one path, no implicit fallback |
| One Ticket, several executors | Deferred inside a Ticket. The operator approved the Request bundle for cross-project work: one acceptance creates one Request plus one Ticket per delivery unit, so parallelism between projects never needs several executors on one Ticket. The analysis for a later segmented fan-out stays in "Splitting work across executors" so the implementation does not drift |
| Cross-project requests | A **Request** groups per-delivery Tickets (approved 2026-11-08): one acceptance makes one Request and 1..N ordinary Tickets, each with one project, checkout, Lead and pull request; the Orchestrator creates and coordinates them, a project Lead only executes its own |
| Dependencies between Tickets | Simple `after` edges: the Orchestrator dispatches a Ticket to its project Lead only once its prerequisites have ended; serial and parallel both fall out of the edges |
| Delivery and aggregation | One pull request per Ticket (a cross-project request necessarily has several); the Request produces the single acknowledgement, the single final result listing the pull requests, and the single "done" state |
| Ticket creation | Only the Orchestrator creates Tickets. A Lead that needs another project asks or hands back; it never adds a Ticket |
| Naming of the aggregate | **Request** — the accepted human ask, grouped above per-delivery Tickets |

## Target model

**Roles.**

- `Orchestrator` — the existing main Session, `orchestrator-<hash of stateDir>`. Sources, Eval,
  Policy, admission, replies, cross-project priority. It never starts a worker directly once the new
  path is on: it hands an accepted Ticket to the project's Lead.
- `Lead` — one persistent Session per registered project, id `lead-<projectId>`, title
  `项目 <name>` / `Project <name>`. It receives an assignment, dispatches executors, watches their
  reports and the pul requests, and reports back. It is a project-scoped worker of the total
  Orchestrator, not a second Engine.
- `Worker` — the existing executor, now a subagent of its Lead. The reserved session id stays
  `worker-<ticketId>`, so `ticketOfSession`, the panel and recovery keep working; the difference is
  that its parent is the Lead's Session and the sidebar hides it.

**Session layout.**

```
orchestrator-<hash>          visible  sources, Eval, Policy, tickets, replies
  lead-<projectId> (×N)      visible  one per registered project
  worker-<ticketId> (×M)     hidden   subagent of its Lead, one per running assignment
```

**Flow of one accepted Ticket.**

1. A Source Trigger reaches the Orchestrator; Eval accepts it and the Engine creates the Ticket and
   its first Assignment (today's path, unchanged).
2. A dispatch effect writes a `project_message` record (`kind: assignment`, the Ticket id, project,
   the assignment's brief) and prompts the Lead Session with a stable request id.
3. The Lead reads the Ticket through its project-scoped tools, decides how to execute it and starts
   one worker subagent (`startActivation`, `agentPreset: dsh-superagent-worker`, `cwd` = the Ticket's
   checkout, `parent` = the Lead agent, reserved id `worker-<ticketId>`).
4. The worker reports through the existing `orchestrator_report` tool; the Lead validates it, asks a
   person when the Ticket stage is `person`, and writes a `project_message` (`kind: report`) back to
   the Orchestrator, which keeps the domain: replies, finish notes, the Ticket's end.
5. The Ticket ends as it does today; the Lead frees its slot and the next assignment can arrive.

**Communication rules.**

- A `project_message` row is written before anything is delivered, carries a `requestId` and an
  idempotency key, and is delivered by effects; the receiver records delivery and acknowledgement.
  A retry re-delivers the same row, and the receiver drops a duplicate by `requestId`.
- Only the Orchestrator's side writes domain state (Tickets, Assignments, replies). The Lead may only
  propose: its messages become effects that the Orchestrator applies through the Engine, as reports
  do today. A Lead never mutates Policy, settings or another project's state.
- The Lead's own status (which Ticket it runs, what waits for a person) is a projection read from the
  records and the Ticket table, not a second source of truth.

**Lifecycle and recovery.**

- Startup ensures one Lead Session per registered project (creation is cheap; an idle DSH Session
  spends no model tokens). The project list is the Execution block, so adding a project creates a
  Lead on the next start or on the next pass.
- After a restart, a Lead Session is ensured again. For each open assignment the recovery step lists
  the Lead's descendants; a worker Session that still exists is adopted (the Lead waits for its
  settlement), otherwise the Assignment is marked interrupted and requeued through the Engine.
- The existing host lock still allows one host per state directory; Leads live inside it.

## Data model changes

- **Schema 13** adds `project_message`: `id, projectId, from ('orchestrator'|'lead'|'person'),
  to ('orchestrator'|'lead'), kind ('assignment'|'report'|'question'|'notice'), requestId,
  ticketId?, body, at, deliveredAt?, ackAt?`. Its writer is a `LeadMessages` module of its own, the
  same way the Outbox owns its receipts; the Engine remains the only writer of domain tables.
- KV: `lead.session(<projectId>)` maps a project to its Session id (survives restarts like
  `masterId`).
- `Ticket.project` already exists; `Assignment` needs no shape change for the first slice. Multi-worker
  fan-out for a single Ticket is **not** in the first slice: the current domain binds one Assignment
  to one Executor instance, so splitting one Ticket across executors needs a domain change and is
  deferred (see Phases, P4).
- Settings: `executor.projectWorkers` (default 2) and `executor.maxWorkers` as the global cap (default
  8). Both are panel-only, like the rest of the environment fields. There is no orchestration switch:
  a Project Ticket always runs under its Lead, and only an installation with no project registered yet
  keeps the bootstrap root path.

## Presets and tools

- New preset `dsh-superagent-lead` (order 89): the router's shell/job 5-second behaviour, file reads
  and search, skills, compaction, and a delegation group with `tool-subagent` and
  `tool-subagent-control`; app tools `lead_assign` (start a worker subagent for a Ticket),
  `lead_status` (its running subagents and pending messages) and `lead_report` (send a
  `project_message`), registered by `Sessions` when the Lead agent is decorated. It has no tool that
  edits settings, Policy, Sources or another project.
- The Lead's prompt is built from the existing prompt parts plus a project section: project name,
  repository, workspace, base branch, the current allowed list, and the rule that it may only propose
  domain changes. Prompt revisions are recorded as they are for the other roles.
- The worker preset and worker prompt stay as they are; the only change is who its parent is and how
  its Session is created.

## Phases

**P1 — Foundation (no entry-point change).** Schema 13 + `LeadMessages`; the Lead preset and its
prompt section; `Sessions` gains a Lead branch (`ensureLead(projectId)`, decoration, prompt
registration, disposal) and reserved-id recognition; project-aware interfaces for the Engine and
Executor (interfaces only, old path still used); recovery scaffolding (`adoptLead(projectId)`).
Acceptance: existing `pnpm check` stays green; new unit tests cover message records, idempotent
delivery, Lead ensure/decorate, and `ticketOfSession` for a subagent worker; a manual script creates a
Lead Session, round-trips one message and disposes it on the real host.

Status (2026-11-08): built — schema 13 with the `lead_message` table and `LeadMessages`, the
`dsh-superagent-lead` preset and its prompt section, `ensureLead`/`adoptLead` with reserved ids, and the
project-aware interfaces. The manual round-trip on the real host follows once P2 exercises a Lead.

**P2 — Execution path.** `DshExecutor` starts a Ticket's worker as a Lead subagent whenever the
Ticket has a registered project (landed: `executorActivation`/`LeadActivations` in
`src/executor/lead-dispatch.ts`, the launch branch and disposal on stop and shutdown): `startActivation` with the reserved id, `delivery: 'parent'`,
worker decoration, report settlement, interrupt/stop, and adoption after restart. Per-project and
global concurrency move from the single `WorkerSlots` to a project-aware scheduler.
Acceptance: a host-level test drives one project through acceptance → dispatch → consumer report →
reply with the fake subagent host; the real host runs one hand-made Ticket (created through the
management API, not a Source) end to end; recovery test interrupts a host mid-assignment and adopts
the surviving subagent.

Status (2026-11-08): the launch, report settlement, interrupt/stop and restart adoption are proven on
the real host — Issue #9 in `louifinn/project-check` became Ticket `aaf66561…`, whose executor ran as
the child Session of `lead-project-check`, opened PR #10, and the Ticket ended `merged` after the
operator merged it and the worker's final report reached the Lead. Inputs and status requests reach a
Lead-hosted child through its Lead (`LeadActivations.steer`/`send`), since a subagent-owned Session
refuses a root prompt, and a report that names an already-merged PR now ends the Ticket merged at
once. Concurrency is now project-aware: `WorkerSlots` enforces `executor.projectWorkers` (default 2) per
project beside the global `maxWorkers`. The host-level test drives the same path with the fake subagent service
(`tests/runtime.spec.ts`, "starts a Ticket executor as a child of its project Lead"), and the recovery
test interrupts a host mid-assignment and adopts the surviving child from its Lead ("adopts a
Lead-hosted child after a restart instead of starting a new Session"). P2 is complete; the real-host runs used Source Tickets, and a route that creates a Ticket from the panel is not part of P2 or P3.

Status (2026-11-08, P3 done): both entry points are proven through a Lead on the real host — Issue #9 in `louifinn/project-check` became Ticket `aaf66561…` (executor as the child of `lead-project-check`, PR #10, ended `merged`), and an operator Feishu message became Ticket `bb956598…` in the same project (child Session of the Lead, PR #11, ended `merged`; the acknowledgement, PR reply and merged notice were sent to the thread). The Overview carries one `LeadRow` per registered project and opens the Lead Session from it, a Lead carries the read-only `lead_status` tool, a lead-mode launch records its dispatch as a delivered `assignment` message, and input and status requests reach a Lead-hosted child through its Lead (`LeadActivations.steer`/`send`). A Feishu Ticket's environment now names its project's repository (`2b2f4db`). Docs 001/003/004/006/007 and the test tables describe the Lead; P4 below removes the switch so every Project Ticket runs this way.

**P3 — Entry points and panel.** The Orchestrator dispatches accepted Tickets to the Lead instead of
creating a root worker Session; notices/replies route through the Lead; the panel shows a project row
(Lead Session, running executors, waiting messages) on the Overview and lets a person open the Lead;
Execution settings gain the concurrency fields; docs 001/003/004/006/007 and the panel test table are
updated.
Acceptance: a real GitHub request and a real Feishu request each become a Ticket executed by a worker
subagent, merged, with the Lead visible and the executor hidden; `pnpm check` and CI green.

**P4 — Clean up and widen.** Remove the feature flag and simplify `Sessions`/`DshExecutor`/panel links,
then the deferred width items: onboarding that requires a project (so the bootstrap root path can go),
a per-project model/prompt override, a project page rather than a row, and the one-Ticket-to-many-
executors design below.

Status (2026-11-08): the `executor.orchestration` switch is removed — a Project Ticket always runs under
its Lead, and an acceptance no registered project can own is refused with a pointer to **Execution →
Projects** (the operator's decision: one path, no implicit fallback). The only remaining root path is
the bootstrap exception for an installation with no project registered yet; P4b removes it by requiring
a project during onboarding. That step and the bootstrap removal go together: the current host test
harness accepts Tickets without projects and asserts a root worker Session, so P4b starts by moving the
harness (and the specifications that assert root deliveries) onto Lead-hosted executors, then makes the
setup require a project. **P5 — Request bundle.** One acceptance becomes one Request plus 1..N Tickets, one per delivery unit
(the Orchestrator splits, using the registered projects and, for a Feishu message, the projects the
assessment names). Each Ticket keeps today's authority and execution: one project, checkout, Lead, PR
and end. `after` edges order the Tickets; the Orchestrator dispatches a Ticket to its project's Lead
only when its prerequisites have ended. The Request produces one acknowledgement, one final result
listing the pull requests (or the failed Ticket and what landed), and one done state; silence
otherwise. Schema 14 adds the Request records and backfills one Request per existing Ticket. Panel and
digest show one row per waiting Request and expand to its Tickets; Triggers, Threads and Subscriptions
keep their keys, so idempotence and history are untouched. The Lead keeps its within-project freedom;
it never creates Tickets.
Acceptance: core engine tests prove one accept → one Request + N Tickets, dependency dispatch only
after prerequisites end, and request-level end/partial-end with one result message; a host test proves
one acknowledgement and one result through the fake Sources; a live GitHub request that spans
`louifinn/project-check` and `louifinn/Napkid-Derivate` produces two Tickets (one per project), two
pull requests, and one Request result after both merge; `pnpm check` and the six-combination CI stay
green.

Status (2026-11-08): the record layer is built — the `Request` model, the `request` table and accessor, schema 14 and a migration that gives each existing Ticket a Request of its own. The Engine that creates a Request with its Tickets, the `after` dispatch, the request-level result and the panel rows follow. P4b harness migration stays a prerequisite for removing the bootstrap root path.
## Splitting work across executors: alternatives and the recommendation

Status: **analysis, background**; the operator approved the Request bundle below for cross-project work, so ticket-level parallelism stays deferred until a measured latency need. The operator asked
whether a Ticket should be split (into segments, or into several Tickets with a dependency graph),
what a Ticket actually is, and which design is theoretically best under this project's philosophy.

### What a Ticket is — and is not

`docs/001-domain.md` defines a Ticket as *a unit of authorized work*: only an Eval creates one; it
refers to its Mandate (what an accept grants), holds its Channels and Inputs, goes open → ended and
back when a person resumes it, and owns its execution and reports. It is **not** a task list and
**not** an agent run: an *Assignment* is the binding of a Ticket to one Executor instance, and a
Ticket has several Assignments over time (retry, restart, hand-off). "A Ticket can be handed off,
resumed, or run by several Executors, so it defines its own state" is an explicit non-goal reversal
in `docs/001-domain.md`.

So the Ticket's identity is authorization + delivery + audit. One accepted request is one Mandate,
one human reviewable result (one pull request or the Source's equivalent), one place where the
request ends. **Concurrency is an execution concern, not a Ticket concern** — the Executor is
outside the domain, and the domain only records Assignments and their reports.

### The alternatives

| # | Design | Granularity unit | PR / review | Domain changes |
| --- | --- | --- | --- | --- |
| A | One Ticket, one worker (today) | executors per Ticket | one PR | none |
| B | One Ticket, several **segment** Assignments started by its Lead | segment = a named part of one delivery | one PR, aggregated before review | Assignment/Execution carry a segment id; several concurrent assignments per Ticket; Lead needs assign/synthesise tools |
| C | One request → several **Tickets** related serially/parallel | ticket = a parallel work unit | one PR per Ticket unless an aggregation layer is added | Ticket gains a parent/workstream and dependency edges; a Decision must create several Tickets (today one accept = one Ticket); acceptance, acknowledgement, stop, resume and "done" need request-level aggregation |
| D | Hybrid: B for one delivery, C only for genuinely separate deliverables | delivery = ticket; parts of a delivery = segments | one PR per delivery | B, plus a way to accept several deliverables from one message |

### Evaluation against the project's philosophy

The philosophy (`docs/000-philosophy.md`) judges every design by human attention: **few concepts,
few settings, one reviewable result per request, silence while working, one question when a person
must decide, and every failure visible**. The other design rules are the Engine's single-writer
rule and "only Eval creates a Ticket" (`docs/001-domain.md`, `docs/007-architecture.md`).

- **Concepts.** A adds none. B adds one execution attribute (a segment id) and no domain aggregate.
  C adds at least three domain concepts — a request/workstream, dependency edges, and aggregate
  completion — plus a Decision fan-out. The philosophy rejects a concept per business need; C is the
  most concept-heavy option. D adds B's attribute and defers C's cost to a real need.
- **Attention.** A produces one review and one result message. B produces one review and one result
  message; the segments are invisible. C produces N reviews, N result messages and N end notices
  unless an aggregation layer (another concept) is built; the person must also reconstruct "is the
  original request done?" from several Ticket states. For the *same* deliverable, C spends N times
  the attention and adds no value — it is a work decomposition, not a delivery decomposition.
- **Audit and idempotence.** A/B keep one Trigger → one accept → one Mandate → one Ticket, which is
  what "accepting a Trigger twice creates one Ticket" relies on. C needs the same Trigger to authorise
  several Tickets: either the same Mandate is shared by N Tickets (then a stop, a Policy change or a
  resume must fan out correctly), or the Trigger is accepted N times, which contradicts the current
  idempotence rule and would need its own concept.
- **Failure and recovery.** A/B report per segment to the Lead and keep the Ticket's single end
  decision (`ready`/`failed`/`blocked`); a lost child is redispatched and the surviving children are
  adopted. C makes each Ticket end independently; a partial request has N end states, and a
  dependency graph needs a scheduler and a new panel surface to show what waits on what.
- **Concurrency.** B routes each child through the same `projectWorkers`/`maxWorkers` caps; the
  Lead's own context is the only new load. C needs a scheduler for inter-Ticket dependencies in
  addition to the existing per-project caps.
- **Philosophy fit summary.** B is "few concepts, one result"; C is "a task graph", which this
  project deliberately avoids — dependency waiting is modelled as a Source today
  (`docs/001-domain.md` rejects Eval-scheduled waiting). Where a wire is genuinely needed between
  independent deliverables, a person can ask for the second deliverable when the first lands, or the
  Orchestrator can ask one question and accept the two deliverables as two ordinary Tickets from two
  requests.

### What the Lead's freedom means

The Lead is a real Session with its own context, so the routing topology (one executor now, two in
parallel, a next segment only after one reports, a re-plan after a failure) is a **prompt-level
execution decision**, not a persisted graph. B represents exactly that: the domain records
Assignments and reports; the Lead decides how many children to start and in which order, and
synthesises their reports into the Ticket's single report. This preserves the user's intent — the
Lead may choose finer granularity and organise topology per project — without turning the domain
into a task scheduler.

### Recommendation for approval

1. **For one delivery, parallel work stays an execution concern later** (segments); its day is not now. Cross-project and multi-deliverable work is solved above the Ticket by the approved Request bundle, which gives each delivery its own Ticket — this is C's request-level shape, not a dependency graph inside one delivery. A segmented fan-out would only return when one delivery's latency justifies it: several segment Assignments
   under one Ticket, one PR, one end. C stays unbuilt until a real case needs *independent
   deliveries* that a person wants to review separately; if that need appears, its unit is a new
   accepted request, not a sub-ticket of this one.
2. **The Ticket keeps one Mandate and one delivery.** Segments inherit the Ticket's authority and
   are hidden from the panel as separate Tickets.
3. **The Lead owns the split and the topology**, with an `lead_assign` tool (P4b); the Orchestrator
   never splits a Ticket.
4. **The integration step is a hidden worker**, not the Lead: it merges segment branches on the
   Ticket's base, runs the checks available in the project, and opens the single PR. A segment's
   failure is retried by the Lead; repeated failure ends the Ticket `failed` with the segment
   branches kept for inspection.
5. **Each segment counts against `projectWorkers`**, so a fan-out cannot starve other projects.

### Resolved decisions (operator, 2026-11-08)

1. Approve B (segments under one Ticket + one aggregated PR) as the direction, or ask for C's
   ticket graph instead?
2. For one message that genuinely contains several independent deliverables (different repositories
   or separate reviews): should the Orchestrator ask one question and accept them as several
   ordinary Tickets, or should the project wait for a real multi-delivery request?
3. Aggregate always into a single PR, or allow the Lead to deliver several PRs when the request
   itself names several deliverables (that is C's delivery pattern, at the request level)?
## Cross-project requests: the Request bundle

Status: **accepted by the operator (2026-11-08)**: model F, fter edges, one pull request per Ticket with a Request-level result, Orchestrator-only Ticket creation, and the name **Request**. The operator raised the decisive question: who
creates a Ticket, the global Orchestrator or a project Lead? Today the answer is the global side —
only an Eval creates a Ticket (`docs/001-domain.md`), the Eval and Decision live in the global
pipeline, and the Ticket merely carries a `project` field that selects its checkout and Lead. A
project Lead cannot create a Ticket; it starts executors (`lead_assign` in P4b). That design cannot
divide a request that spans projects: one Ticket has one project and one checkout, one Lead, one
delivery.

The operator also chose that a message containing several independent deliverables should be split
**automatically**, and left the PR-aggregation rule open for discussion.

### Alternatives for cross-project work

| # | Design | One request across two projects becomes | New concepts |
| --- | --- | --- | --- |
| E | A Ticket has several projects: segments carry their own project, one Mandate, one end | one Ticket with two deliveries (two PRs) and no single project Lead | a per-segment project, multi-delivery ending, a coordinating Lead |
| F | A **Request** groups N ordinary Tickets, each with one project and one delivery; the Orchestrator creates the Request and its Tickets, and each project's Lead executes its own | a Request with two Tickets (one per project), each a normal Lead-hosted delivery | a Request aggregate (parent of Tickets, dependency edges, request-level end) |

E keeps one Mandate and one acknowledgement, but breaks the Ticket's tightest invariants: one project
checkout, one delivery, one Lead. Whose Lead starts a child in the other project? Which project's
`projectWorkers` slot does it take? Which PR ends the Ticket if the other is still open? It also
makes `Ticket.project` ambiguous for the panel, the digest and the executor environment. F keeps
every Ticket exactly as it is today — one project, one checkout, one Lead, one PR, one end — and adds
one aggregate above it that captures what a person actually asked for and what coordinates the
deliveries.

### Proposed model (F)

- **Request** — the accepted human ask: the Decision, the Trigger batch it came from, the common
  authorization (its Mandate), a title, an optional deadline for a person, and the list of Tickets it
  produced. Only an Eval creates one; accepting the same Trigger twice still yields one Request.
- **Tickets** — unchanged in authority and execution: one per *delivery unit* (a project/repository,
  or a part a person should review separately). Each carries its project, its checkout, its Lead, its
  PR and its own end. A Ticket's Mandate is the Request's Mandate narrowed to that Ticket's scope
  ("wider scope means a new Ticket" already says this).
- **Splitting** — the Orchestrator decides at acceptance, from the request text and the registered
  projects, how many Tickets the Request needs and in what order; this is the "automatic split" the
  operator approved. The Orchestrator creates them with the Request in one Engine transaction, so one
  accept = one Request + 1..N Tickets.
- **Dependencies** — each Ticket may name the Tickets it waits on (serial and parallel both fall out:
  no edges = parallel, edges = ordered). The Orchestrator dispatches a Ticket to its project's Lead
  only when its prerequisites have ended, so waiting stays an orchestration rule rather than a new
  scheduler inside the Executor.
- **Within a Ticket** — the Lead keeps the freedom discussed above: one executor, or several segment
  assignments under the same Ticket, with the single-PR aggregation when approved.
- **Completion and attention** — the Request is the unit a person sees: one acknowledgement, one
  final result (a list of merged PRs, or the failed Ticket and what landed), one end. Ticket ends
  still drive the Request: all Tickets merged/closed → Request done; one failed after the others
  merged → Request ends partial and asks one question, "retry this Ticket or accept what landed?".
  Silence otherwise, per the philosophy.
- **Who may add a Ticket later** — the Orchestrator only, through a person's message or a Lead's
  proposal. A Lead stays an executor of its own project: if it finds the request needs another
  project, it hands the finding back (a question or a handback), the Orchestrator decides, and a new
  Ticket joins the Request under the same Mandate if the Policy still holds it.

### What this implies for the current code

- `src/core/model.ts`: new `Request` type; `Ticket.requestId`; keep `Ticket.project` as the single
  project; `Mandate` moves to (or is referenced by) the Request and Ticket creation narrows it.
- `src/app/migration.ts`: schema 14 adds `request` records and backfills one Request per existing
  Ticket, so history keeps its identity.
- `src/core/engine.ts`: accept creates Request + Tickets atomically; a new people/Orchestrator command
  to accept further Tickets into an open Request; Request end derived from its Tickets; a
  `request.ended` event for the single result message.
- `src/executor/dsh.ts`: unchanged per Ticket; the Orchestrator's dispatch waits on prerequisites.
- Panel and digest: one Request row per waiting ask, expanding to its Tickets; "waiting on a person"
  stays the attention rule. Triggers/Tickets keep their keys, so Threads, Subscriptions and
  idempotence are not touched.
- Tests: core engine tests for Request creation, splitting and dependency dispatch; host tests for the
  single acknowledgement/result; panel tests for the grouped rows.

### Resolved decisions (operator, 2026-11-08)

1. **Model F** — a Request groups per-delivery Tickets; the Orchestrator creates and coordinates;
   each project's Lead executes its own. Model E (one multi-project Ticket) is rejected.
2. **`after` edges** between Tickets; the Orchestrator dispatches a Ticket only when its prerequisites
   have ended. No phase list, no persisted scheduler beyond the edges.
3. **One pull request per Ticket**, so a cross-project Request necessarily has several; the Request
   produces one acknowledgement, one final result listing them, and one done state.
4. **Only the Orchestrator creates Tickets.** A Lead asks or hands back; it never adds a Ticket.
5. **Name: Request.**
## Risks and mitigations

- **DSH experimental API drift.** `startActivation` exists in the running 0.2.2-rc.1 build but not in
  older 0.2.x; superagent's peer range is `^0.2.1-alpha.2`. Feature-detect the service at startup,
  keep one adapter module, and fail setup with a clear problem instead of crashing.
- **Eight idle Lead Sessions.** They cost context and desk clutter. Mitigation: keep their prompts
  short, create them lazily-but-eagerly per registered project, and log their bootstrap cost; a
  `park` behaviour can follow if the cost is real.
- **Message ordering and duplicates.** One writer (the dispatch/Lead message module), `requestId`
  dedupe, records before delivery, and acknowledgement rows; tests cover redelivery.
- **Recovery of in-flight subagents.** The first slice adopts rather than re-spawns; when a binding
  cannot be proven, the Assignment is requeued and a duplicate-preventing report id keeps the Ticket
  coherent.
- **The Engine's single-writer rule.** The Lead proposes; only the Orchestrator's Engine writes. A
  review of every new Lead effect goes through that rule.
- **Session-ownership errors.** A subagent Session cannot be prompted through the Session controller
  (`session/agent-busy`); all Lead↔worker traffic uses the subagent service or `AgentDelivery`.
- **Concurrency fairness.** A per-project cap prevents one project from eating the global slots; the
  scheduler rejects work when the global cap is full and the Lead waits, as a worker does today.

## Review questions, resolved

The operator answered these on 2026-11-08, taking the proposed defaults:

1. A Lead for every registered project at startup, so the sidebar and panel are predictable.
2. The Lead row lives on the Overview; a Projects page can follow if the row grows.
3. A Lead uses the default model; a per-project model override is a P4 widening item.
4. Fan out one Ticket across several executors later, along the direction recorded above.
5. Cross-project and multi-deliverable requests use the **Request** bundle (model F), approved on
   2026-11-08: one acceptance creates one Request plus one ordinary Ticket per delivery unit.
6. Dependencies between Tickets are `after` edges; the Orchestrator dispatches a Ticket to its
   project's Lead only when its prerequisites have ended.
7. Delivery is one pull request per Ticket; the Request produces the single acknowledgement, the
   single final result that lists them, and the single done state.
8. Only the Orchestrator creates Tickets; a Lead asks or hands back and never adds one. The
   within-project segment fan-out stays deferred until a measured latency need.
