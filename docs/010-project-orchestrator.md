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
| One Ticket, several executors | Keep one worker per Ticket now; the future design direction is recorded in "Future: one Ticket, several executors" so the implementation does not drift |

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
a project during onboarding. The multi-executor design is recorded (not implemented) in the next
section.

## Future: one Ticket, several executors

Direction decided on 2026-11-08 (implementation deferred): keep one worker per Ticket now, but grow
along these lines so execution does not drift.

- **Domain.** An `Assignment` stays one worker; a Ticket may carry several `Assignment`s in one
  *stage*, each over a *segment* (a named, non-overlapping part of the work) with its own worktree and
  branch `agent/<worktree-name>/<segment>`, all cut from the project's clone.
- **Dispatch.** Only the Orchestrator creates a Ticket and hands it to the Lead as one assignment
  message. The Lead splits it into segments with `lead_assign` (a Lead application tool, P4b) when the
  request names independent parts; each segment starts a hidden child through the subagent service, and
  every child's report settles back as a `report` message to the Lead.
- **Aggregation.** The Lead decides when the stage is complete: it either picks one segment branch as
  the Ticket's, or starts one integration child that merges the others in ticket order, resolves
  conflicts, and opens the single PR. The Ticket still binds one PR and ends `merged`; a failed segment
  is retried or dropped by the Lead with a reason recorded in the ticket.
- **Bounds and visibility.** All children count against `projectWorkers` and `maxWorkers`; the Lead row
  shows running executors and waiting messages; the Trigger/Ticket keys and the Mandate stay one per
  Ticket, so policy, audit and duplicate prevention are unchanged.
- **Not in scope now.** Per-segment PRs, partial merges into `main`, and cross-project single Tickets.

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
