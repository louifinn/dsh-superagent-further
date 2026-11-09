# 012 — Project-level Requests and lead-dispatched work (Sprint 22)

Status: approved by the operator on 2026-11-10 (Tower mode, mission chain M13–M18) and implemented; missions M13–M18
are merged. The operator later added D11 (Lead-raised work from automation deliveries, Sprint 25), D12 (installation-level
self-bootstrap, Sprint 26) and D13 (Lead escalation to the Orchestrator, Sprint 27), all implemented. `docs/011-capabilities.md`
Parts E–G record the decision summaries.

## Why

Today only the Orchestrator (the main Session) can create a Request: a Request exists only as the result of an
`accept` Decision of an Eval over a source Thread. A project Lead can read its project's Tickets (`lead_status`) but
cannot create or dispose work, cannot reply to its workers beyond a worker report's own lifecycle, and the local design
documents a `design` rule produces cannot reach a remote manager. Workers cannot raise work upward. External DSH
Sessions in related workspaces cannot ask this plugin for anything.

The operator asked for four capabilities (2026-11-10):

1. **R1 — Architecture and large refactors**: a large refactor or cross-project architecture decision found by a
   worker becomes a project-level Request; the Lead runs the normal flow (spec → plan → request approval → implement →
   report) and only steps that genuinely need a human (approval) are human-gated.
2. **R2 — Project-level Requests raised by workers**: a worker may raise a project-level Request; its project Lead
   disposes it (accept / reject / needs-info), creates Tickets, may receive further requests during the work, and
   **must reply to the worker — never ignore it**. When every derived Ticket and Request is done the Lead reports all
   completed work back through the source channel of the initial request.
3. **R3 — External DSH Session bridge**: an independent DSH Session in a related workspace, not managed by SuperAgent,
   can call a tool to submit a Request to the Orchestrator under the existing admission rules; whatever the assessment,
   the Session must receive a reply, and when work is done the Orchestrator reports back to that Session.
4. **R4 — Explicit requests always answered**: a whitelisted user's @ mention or direct message is always an explicit
   request; for an explicit request the answer must be sent whatever the assessment outcome (accepted, ignored,
   unavailable, stop).

## Decisions

### D1. ProjectRequest is its own record, not a Request

A new durable record `project_request` (schema 21) represents *work asked of a project's Lead*, before any Request
exists. It is neither a Trigger (no Policy gate, no Eval) nor a Request (no Mandate from a source accept yet).

```ts
interface ProjectRequest {
  id: string                       // 'prq-<8hex>'
  project: string
  kind: 'work' | 'architecture'    // architecture uses the approval flow (D7)
  title: string
  instruction: string              // what the worker wants done, bounded
  raised_by: { session: string; ticket?: string; assignment?: string }
  root?: { request_id?: string; project_request_id?: string; trigger_id: string; thread_key: string }
  status: 'pending' | 'needs-info' | 'accepted' | 'rejected'
  | 'awaiting-approval' | 'approved' | 'completed' | 'withdrawn'
  replies: LeadReply[]             // every Lead answer, oldest first
  decision?: { action: 'accept' | 'reject' | 'needs-info'; at: string; notes?: string }
  request_id?: string              // the Request created on accept
  tickets: string[]                // Tickets of this request and of derived requests
  derived: string[]                // ProjectRequest ids raised from this root
  approval?: { thread_key: string; trigger_id: string; at: string; by: 'human'; text: string }
  created_at: string; updated_at: string
  completed_at?: string
}
interface LeadReply { at: string; by: string; text: string }
```

`root` is only set on a **root** ProjectRequest (raised from source-triggered work) and captures the original Trigger,
Thread and Request so the final report can go back to the channel the whole chain started from. A derived request
points at its root via `root.project_request_id`. `replies` is the audit of "Lead must answer".

### D2. Authority: the Lead acts for its project, not for the Policy

A project Request is exempt from the admission gate. It grants no more than the Lead already owns: accepting it creates
a normal domain `Request` whose Mandate has basis `{ via: 'lead', project, project_request_id }` and strength
`'explicit'`; every Ticket is confined to that project. `Policy.revalidate` returns true for a `lead` basis.
Cross-project work is **not** a project Request: the Lead escalates to the Orchestrator (a normal source Request by a
person, or `lead_escalate` tool in a later phase) because only the Orchestrator owns projects.

### D3. Mandatory reply, never ignored

- `project_request.decide` (Lead tool) requires a non-empty `reply`; it records the reply, then applies the action.
- The runtime enforces reply at the **Lead activation boundary**: when a Lead turn ends with `pending` requests (or a
  worker completion report that has no reply), the runtime records the unanswered item, re-prompts the Lead with a
  reminder listing it, and repeats at most twice. After that it marks the item `needs-attention` in the store (so the
  panel and the Orchestrator see it) — the protocol never silently drops a request.
- Worker completion reports that raised requests must reply with those ids; the worker report tool takes
  `requests?: string[]` and the prompt requires it.

### D4. Worker tools

The worker Session gets `request_create`:

```ts
request_create({ title, instruction, kind?: 'work'|'architecture', parent?: string, evidence?: string })
  -> { id: string; status: 'pending' }
```

It stores the ProjectRequest (project from the worker's Ticket), marks the request pending, and delivers a message to
the project Lead Session; if the Lead is not running, `Sessions.ensureLead` + wake as usual. **Today the Lead is a
passive durable parent**: an assignment is written as a `lead_message` row and is never prompted, and worker reports go
to the main Session (`src/executor/dsh.ts:544-555`, `src/app/tools/executor.ts:84-117`). This phase also adds the effect
kind that actually prompts the Lead (`Sessions.prompt(leadSessionId, …)`) for raised requests and unanswered worker
reports, so the mandatory-reply gate has something to gate on. Idempotency: one open
request per (ticket, title) — a repeated call returns the existing id. The worker's ordinary `report` gains
`requests: string[]` so a completion report states what it raised.

### D5. Lead tools

`lead_status` stays read-only. New Lead tools:

- `lead_requests({ status?: ... })` — pending/recent ProjectRequests of the project, with raised_by, root, derived and
  replies, plus unanswered worker reports.
- `lead_request_decide({ id, action: 'accept'|'reject'|'needs-info', reply, statement?, deliverables?, notes? })`
  — records the mandatory reply and, on accept, creates the Request and its Tickets (each `deliverables` item becomes a
  Ticket in the project, `after` edges preserved; default one Ticket from the statement). Replies are delivered to the
  raising session (a Session message) and recorded on the request.
- `lead_request_reply({ id, reply })` — extra reply without a disposition (rare; still recorded).
- `lead_request_complete({ id, summary })` — after all tickets/derived requests ended: sends the aggregate report to
  the root's channels (D6), marks completed.
- `lead_request_approval({ id })` — architecture flow: send the design proposal to the root channel and mark
  `awaiting-approval` (D7).

### D6. Final aggregate report through the origin channel

When a root ProjectRequest's tickets and derived requests are done, the Lead calls `lead_request_complete`. The runtime
queues one Outbox message per channel of `root.request_id`/`root.trigger_id` (the original source channel), listing
every Ticket outcome, every derived Request and its outcome, and the summary. `request.ended` notices remain for the
Request itself; the project-level report is the aggregate across the derived chain and is delivered once
(idempotent id `project-result-<root id>`).

### D7. Architecture approval flow (R1)

`kind: 'architecture'` requests use the same lifecycle plus an approval gate:

1. Lead accepts → creates a **design Ticket** (one Ticket whose worker produces a decision document/plan; no code
   changes) plus, when the Lead already knows, the staged plan as tasks in the request's statement.
2. Design Ticket ends → Lead calls `lead_request_approval`: the runtime sends the design report/proposal to the root
   channel asking for approval and sets `awaiting-approval`.
3. The human reply on that thread is routed by the Orchestrator to the Lead (thread follow + Lead message). The Lead
   calls `lead_request_decide({ action: 'accept' })`? No — a dedicated `lead_request_approve({ id, approved, text })`
   records `approval` (only from a human Trigger on the root thread) and, on approval, creates the implementation
   Request with the staged Tickets; on rejection it records and replies.
4. Implementation Request ends → Lead `lead_request_complete` with the implementation summary.

If the human approval can't be linked automatically, the Orchestrator's `route` to the Lead is the fallback and the
request stays `awaiting-approval`.

### D8. Explicit requests always answered (R4)

The gate already admits a whitelisted sender's @ mention or DM as an explicit Trigger. Add `expects_reply: true` to
the Trigger intake for `basis.via === 'addressed'` (mention/direct) **and** a whitelisted sender, including messages
that are not actionable. In `Engine.decide`, an `ignore`, `unavailable` or `stop` decision whose Trigger has
`expects_reply` queues one Outbox `notice` to that Trigger's Channels explaining the outcome and reason (idempotent
id `explicit-reply-<decisionId>`). Accepted requests keep the existing acknowledgement and result replies. No reply is
sent when the sender is not whitelisted or the message is not addressed.

### D9. External DSH Session bridge (R3)

Implemented in M17 as the `session` Source kind (`src/sources/session.ts`) and the global `superagent_submit` tool.
An independent DSH Session calls it with `{ title, instruction, project?, session_id? }`; the tool builds one Trigger
per call (`human:false`, actor id empty, the Session's ID as the Channel address, and a Thread of its own because the
call id keeps independent submissions out of one evaluation batch) and receives it through the ordinary intake, so
the existing Policy's admission rules apply. The `workspace` admission row reports the candidate; its
`unlistedUnaddressed` cell decides admission and defaults to `ignore`, so an operator opts in by setting it to
`inferred`.

Cordis plugins register model-visible tools with `ctx.tools.register(defineTool(...))`; the Runtime registers this one
on the plugin's root context, so every unmanaged root Session sees it, while the main Session's and worker's
`ctx.tools.restrict` allow lists hide it. The project Lead sees it but has no root identity, and the tool refuses the
master, `lead-*` and `worker-*` Session ids, subagent Sessions (`session.header.parentSession`), and a `session_id`
that does not name the caller. The tool is registered only when the Host exposes the root `tools` service; the Source
kind is always registered and can be turned off like any other Source.

A call carries `exec.agent` (the Session's identity and root check) and `exec.callId` (the idempotent Trigger id). Every
Decision outcome queues an Outbox notice back to the Session: on `decision.recorded`, the Runtime finds the Decision's
Session Triggers and sends `sessionDecisionText` (accept names the Ticket and promises the result; ignore, unavailable
and stop explain why). The transport is `Sessions.prompt`/`AgentDelivery`, which delivers a queued message idempotently
by message id and resumes a cold Session through `ctx.sessionController.resolveAgent`; a `session/not-found` target
settles as gone. Completion needs no extra path: the accepted Trigger's Channel flows into the Request and the existing
`request.ended`/`project-result` notices report the result back to the same Session. Filtered Triggers never reach a
Decision and get no reply.

Feasibility pointers from the 2026-11-10 survey that remain useful: `ctx.tools.register(defineTool(...))` global versus
agent-scoped registration; `exec.agent` and `exec.callId`; `ctx.sessionController.resolveAgent(sessionId)` for a live or
resumed Session, refusing subagent-owned Sessions (`session/agent-busy`); `AgentHandle.followup()` through
`AgentDelivery`/`Sessions.prompt`; Session identity and workspace from `exec.agent.session.header`; a reply target must
be a root Session.

### D10. Matt Pocock-style flow mapping

Our mapping from the referenced skills workflow: spec/decision document (this file, `design` rule) → tickets
(`request_create` / Lead deliverables) → implementation slices (Tickets, `after` edges) → independent review
(governance `review` rule, Lead gates) → report (aggregate report D6). Decisions stay in durable specs and records, not
only in a conversation.

### D11. Lead-raised work from automation deliveries

A scheduled project automation delivery is a standing instruction, not a Source Trigger, so it cannot create work by
itself (docs/011 B-D2). A′ keeps the scheduler a scheduler: the delivered instruction tells the Lead to inspect and
report, and when the inspection finds work the Lead raises **one work project request** for its own project with
`lead_request_create`, passing the automation id from the delivery marker, and decides it with `lead_request_decide`.
The Lead is both raiser and disposer; the mandatory reply and the needs-attention reminder still apply, and the
automation provenance lives in `raised_by.automation`.

Accepting a work request with no root Trigger creates the ordinary Request and its Tickets immediately through
`Tickets.createLead`: the Request's channels are empty, its origin is `key('project-request', decisionId)`, its Trigger
ids are empty, and the Mandate's actor falls back to `dsh-superagent:lead:<project>`. Architecture requests keep the
root requirement even when a Lead raises them: a rootless architecture accept still refuses with
`approvalRootRequired`, because a person's approval has to arrive on the root Thread. Repeating a raise with the same
title in one Lead Session returns the open request instead of creating a second one.

The automation delivery's write budget stays the capability decision's: raising and deciding that project request is
the only project record it may change, while the repository, Settings, Sources, Tickets and Policy stay untouched. The
panel's project Lead row shows the pending project-request count and how many arrived from automations.

### D12. Installation-level self-bootstrap

An installation automation delivery is a standing instruction like a project one, but it targets the main Session and no
project Lead. When its inspection finds work, the main Session calls `orchestrator_request_create`. The tool validates
that the automation named is an existing `installation`-scope record (a project task's findings still go through its
Lead, D11), that every delivery unit names a registered project, and then raises one rootless Request through
`Tickets.createLead` with an empty Channel set. The Mandate basis is `{ via: 'installation', automation }`, its actor
`dsh-superagent:installation`, and revalidation trusts that basis because no Source message admitted the work. A repeated
raise for the same title and automation while the first Request is open returns that Request instead of creating a
second one.

The tool never accepts Source candidates, never creates architecture work (a person's approval needs a root Thread), and
the delivery's write budget remains the Request it creates: the repository, Settings, Sources, Tickets, Policy and panel
records stay untouched directly. The Request appears in the panel like any other, and its Mandate records the automation
id that produced it.

### D13. Escalation to the Orchestrator

A project Lead whose automation delivery finds work that belongs outside its own project — another project's code, a
shared build, the installation's own configuration — raises an `escalation` project request with
`lead_request_escalate`: a pending request the Orchestrator disposes, never the Lead (the Lead's decide/reply commands
refuse it). The Orchestrator sees it through `orchestrator_escalations` and answers it with
`orchestrator_escalation_decide` and its mandatory reply. An accept names at least one delivery unit (every unit a
registered project), and creates one rootless installation-level Request and its Tickets through `Tickets.createLead`:
the Mandate basis is `{ via: 'escalation', project, request }`, its actor `dsh-superagent:orchestrator`, and revalidation
trusts that basis like a Lead accept, because the Orchestrator decided it rather than a Source message. Reject and
needs-info record the reply and create no work. The reply is written as a `lead_message` notice for the source project
and delivered to its Lead, which reports it onward through the original worker; a repeated escalation of the same title
in the same Lead Session returns the open request. A person's architecture approval is unaffected: architecture work
still needs a root Thread, so escalation stays inside the work kind.

## Phases / missions

- M13 (P1) — **done**: schema 21 `project_request` store, engine APIs (`raise`, `decide` on a request, `complete`),
  migration, unit tests. No tools.
- M14 (P2) — **done**: worker `request_create` + report `requests`; Lead tools (D5); mandatory-reply enforcement at the
  Lead activation boundary; prompts; tests.
- M15 (P3) — **done**: aggregate origin-channel report (D6) + R4 explicit-always-reply (D8) + tests.
- M16 (P4) — **done**: architecture approval flow (D7) + tests.
- M17 (P5) — **done**: external DSH Session bridge (D9) through the `session` Source kind and `superagent_submit`.
- M18 (P6) — **done**: docs (002/003/004/007/009/011), CHANGELOG, README counts, full `pnpm check`; the six-combination
  CI and live smoke run under the tower after the chain merges.

Phases merged in order (M13 → M14 → M15 → M16 → M17 → M18); scopes overlapped in `src/core`, `src/app`, `tests` and
`docs`, so Tower serialized them.
