# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). While it is a research prototype, `0.x` versions may change
the settings schema and the state database; the upgrade steps in `docs/006-deployment.md` say how to migrate.

## [Unreleased]

### Added

- A stable supervisor and a versioned domain runtime (ADR-0006, schema 25 unchanged). `src/index.ts` now starts
  `Supervisor`, which owns the state-directory lock, one process-wide `Logs` ring and `LogFileSink`, the machine
  configuration, the runtime version pointers and journal, and the drain controller. It exposes readiness through
  `configured()`/`setupProblem()`/`versionStatus()`; runtime health stays on the runtime's `HealthBoard`. The domain
  runtime is reached only through the frozen `RuntimeHost` v1 (`src/runtime-host.ts`): the live Cordis context as the
  DSH service channel, the DSH values the runtime must not import (`Service`, `freezeMessage`, `MessageId`,
  `ReasoningEffortId`, `scopeParentOf`, schemastery), the machine, restart, logger, lifetime signal, logs, sink, flush
  and lock release. `src/runtime-entry.ts` exports `createRuntime(host)` and is built as the self-contained
  `lib/runtime-entry.js` with a `lib/runtime-manifest.json` descriptor; `scripts/check-runtime-bundle.mjs` checks the
  bundle and is part of `pnpm check`, and the packaged fallback requires that built pair; an unbuilt source checkout
  logs the discovery failure and still starts a verified deployed version, and only when no candidate starts does the
  error name `pnpm build`. Startup verifies `<stateDir>/runtime/current.json` (safe entry inside the version directory,
  SHA-256, host API and a schema that is not older than the database), falls back to the previous verified version and
  then to the packaged runtime, and records every rejection, recovery and journal phase. Readiness is bounded at 30 s, a
  failed runtime's dispose at 10 s, a log-sink close at 10 s and the state-directory lock release at 10 s (the last two
  warn and continue), and a failed `load`/`init` journals that phase. The drain is idempotent and ordered — stop intake,
  cancel remaining agents with their inboxes kept, wait bounded for in-flight work (10 s), dispose, flush the logs,
  close the Store, release the lock, return the phase report — and `completed` is true only when every phase is `done`,
  so an aborted drain is reported as incomplete. Only intake/cancel/in-flight may be skipped by an abort signal; the
  maintenance phases always run, so an aborted drain still closes the database and frees the directory. A supervisor
  that never started reports an incomplete drain while still flushing and releasing. A crash between steps recovers from
  `<stateDir>/runtime/journal.json` without ever downgrading the schema. M35 reads `previous.json` but does not write it;
  M36's update pipeline does. `pnpm check` builds before it tests, so a clean checkout without `lib/` is green.
  `tests/supervisor.spec.ts` covers the resolution, packaged manifest, loader, bounded readiness with a hanging dispose,
  bounded sink close and lock release, one ring kept across a failed candidate, packaged discovery failure, the empty
  drain, journal, host-freeze and swap paths, and `tests/runtime.spec.ts` covers the bounded in-flight phase, the
  incomplete abort report and an abort before the store phase that still closes it; both inject a packaged runtime so
  they pass without a built `lib/`.
- Read-only diagnosis of operational incidents and routing of the conclusion through the existing self-evolution
  outlets (ADR-0005, schema 25 unchanged). A new agent preset `dsh-superagent-further-diagnostician` (order 95, not
  selectable by hand) carries only `agent-instructions`, `time-context` and a `tool-fs` mounted with `write: false`
  and `edit: false`; no shell, job, search, skill, compaction, delegation, scheduling, goal, plan-mode, plugin-manager,
  web, todo, question or present tool is installed, and `src/app/diagnosis.ts` also puts the started child Session on
  the `read-only` permission preset where the host exposes one. After a new incident is bundled, `Diagnosis.consider`
  gates auto-diagnosis on `autoDiagnose`, a `high`/`critical` severity at or above `minimumSeverity` and an open
  status; a person may diagnose a `detected` or `bundled` record from the panel, `orchestrator_incident` or
  `POST incidents/<id>/diagnose`, and that action is audited (a `diagnosed` record can only be routed, dismissed or
  resolved). Dispatch goes through the host `subagents` service
  (`spawn`, delivery `caller`, `maxDepth` 1, the main Session parent, the selected Orchestrator workspace as cwd,
  `diag-<incidentId>-<suffix>`), with the incident JSON, evidence directory and workspace in the prompt and a strict
  JSON answer contract (`rootCause`, `evidence[]`, `hypotheses[]`, `fixPlan`, `confidence`, `target`). Start and result
  together are bounded to 10 minutes: a start that overruns aborts the signal and an activation that resolves after the
  deadline is disposed once, while a result-phase timeout disposes the activation it holds; both log one `diagnosis`
  warning, set the `incidents` health error and leave the record `bundled`, and detection starts no model call. A
  completion that finds the record changed (dismissed, resolved, reopened or counted again) is refused as `stale`
  through a compare-and-swap save that merges only the diagnosis, so a slow writer never resurrects a closed record or
  erases a repeat count. The new tier-C `executor.incidents.diagnoseDailyBudget`
  (0–24, default 2) is a durable per-UTC-day attempt counter in the Store's kv area that survives a restart, and runs
  are single-flight. A parsed diagnosis is stored as JSON in the existing `incident.diagnosis` column and shown on
  `GET incidents/<id>`; an unparseable answer is kept as a low-confidence diagnosis with target `none` instead of
  failing the run. Routing runs once per record and requires the current record to still be `diagnosed` with a
  non-empty parsed diagnosis, then a non-empty `incident.resolution`: a registered project becomes a
  discovery Request (`engine.raiseDiscoveryRequest`, discovery Mandate, units naming the project) that the Lead turns
  into Tickets under the normal PR and human-merge flow (`request:<id>`); a `self` finding or an unregistered
  repository becomes a Request under the registered self project when there is one (`request:<id>`), and otherwise
  goes through `SelfReports.raise` with its three-state `eval.selfReport` gate, dedupe, cap and jurisdiction refusal
  (`self-report:<id>` or `self-report:off`) — the Issue outlet refuses jurisdiction while the self repository is
  registered, so that case must take the Request path; an operational or none conclusion creates no Request and no
  Issue (`operational`). A route is single-flight per record while it awaits the work item, so an overlapping
  automatic, panel, HTTP or tool call is refused as `concurrent` (HTTP 409) and creates nothing; settlement is a
  compare-and-swap on the status and `updated_at` captured at route start, so a dismissal, recovery or repeat that
  lands during the await is refused as `conflict` (HTTP 409), the newer record and its reason survive, and work
  already created is named in one `diagnosis.route-conflict` warning but is neither recorded as the resolution nor
  deleted. Reopening a record keeps the old diagnosis text but clears the resolution, and the status check refuses to
  route that stale text. A failed automatic route leaves the resolution empty so the operator can retry with
  `confirm: true`. `POST incidents/<id>/dismiss`
  requires a reason and records `Dismissed: <reason>`, rendered through the localized dismissal key; the diagnose
  response and its audit carry the auto-created `resolution` token. The panel's Incidents detail gains Diagnose,
  Create fix (confirmed) and Dismiss actions with pending and error states and links to the created Request or
  self-report, a self-report resolution deep-links to the named draft row highlighted on the Overview, Overview keeps
  its "needs you" row, Execution settings gain the diagnosis budget, and both locales are updated.
  `orchestrator_incident` (`list|get|diagnose|dismiss|route`) exposes the same services to the main Session with typed
  refusals and a filtered list total. Covered by
  `tests/diagnosis.spec.ts` (dispatch, gates, durable budget and restart, single-flight, parse fallback, start-overrun
  abort and late disposal, stale dismissals and repeat counts, routing including the registered-self-project fallback,
  route single-flight and settle conflict, dismissal),
  `tests/diagnosis-runtime.spec.ts` (no model call in detection, event-path scope exclusion, preset delivery and
  read-only permission, same-origin routes with metadata-only audit including the created resolution, 400/404/409
  including the `concurrent`/`conflict` route refusals, reopened-record route refusal, filtered list total, manual
  route retry, the tool),
  `tests/incidents.spec.ts` (the compare-and-swap store and filtered count), `tests/bundle-patch.spec.ts`
  (the preset inventory), `tests/panel-incidents.spec.tsx` (the actions, the localized dismissal and the Overview deep
  link) and the extended HTTP, tool, view, locale and settings specs, with docs 005, 006, 007, 009, 011, 013 and 014
  and ADR-0005 synchronized and the generated reference pages refreshed.
- Deterministic operational incidents with durable records, fingerprint dedupe and content-addressed evidence bundles
  (schema 25, ADR-0004). The Store-owned `incident` table keeps `{ id, fingerprint UNIQUE, rule, scope { project?,
  ticket?, request?, session? }, severity: 'low' | 'medium' | 'high' | 'critical', status: 'detected' | 'bundled' |
  'diagnosed' | 'resolved' | 'dismissed', first_at, last_at, occurrences, title, detail, evidence_dir, diagnosis?,
  resolution?, updated_at }`; schema 24 migrates to 25 on start by creating the empty table, with no backfill.
  `src/app/incident-detectors.ts` watches what the Runtime already produces — failed or stopped Assignment ends
  (4 in 10 minutes per project), `agent.error` (3/10), outbox `reply delivery failed` (3/30), consecutive `poll.failed`
  per Source (3/10, recovered by `poll.recovered`), a health claim entering `error` and the M21 watchdog's stalled
  Assignment (sharing its existing request) — with zero model calls, no code changes and no automatic fixes;
  `update-failures` is reserved for the update pipeline. A stable fingerprint over the rule, normalized scope ids and a
  digit-normalized detail counts repeats instead of duplicating (one-hour cooldown from `last_at`, then reopen), the
  daily budget (2 per UTC day), the open cap (100) and the minimum severity (`high`) bound the noise, with
  `health-error` and `stalled-assignment` exempt from the daily budget because they describe a live outage (dedupe,
  cooldown and the open cap still apply); each first
  record writes owner-only `config.json`, `health.json`, `related.json`, a 30-minute `log-window.jsonl` and a hashed
  `manifest.json` under `<workspace>/artifacts/incidents/<id>/` (newest 20 kept, 30 days), leaving the record
  `detected` and the `incidents` health claim in error when a bundle cannot be written. The tier-C
  `executor.incidents` setting (`enabled`, `autoDiagnose` reserved for M34, `dailyBudget`, `minimumSeverity`) has
  controls under Execution settings; the Incidents tab lists and filters records and shows the evidence manifest,
  Overview adds a "needs you" block while any is open, and `GET incidents` / `GET incidents/<id>` serve the same
  views. Covered by `tests/incidents.spec.ts`, `tests/incidents-runtime.spec.ts` (a seeded fault yields exactly one
  incident inside the cooldown, a second after it, a complete bundle, a failed bundle that cannot crash the pass and
  no model call), the schema 25 migration and properties specs, `tests/panel-incidents.spec.tsx` and the extended
  panel-overview, panel-panel, panel-settings, http and policy specs, with docs 005, 006, 007, 009, 011, 013 and the
  ADR synchronized and the generated reference pages refreshed.
- The self-evolution Issue outlet and the discovery provenance (phase 2 of document 014, schema 24). The store-owned
  `self_report` table keeps `{ id, title, body, evidence, raised_by { session, ticket? }, target_repo, status:
  'draft' | 'filed' | 'dismissed', issue_number?, filed_at?, created_at }`; schema 23 migrates to 24 on start by
  creating the empty table, with no backfill. `orchestrator_issue_create` targets the fixed
  `SELF_REPOSITORY = 'louifinn/dsh-superagent-further'` and refuses when that repository is a registered project,
  naming the discovery route instead. The Eval settings gain the tier-B `selfReport` gate — `off` records nothing,
  `observe` (default) keeps a draft, `auto` files through the existing `gh` command path — bounded by deduplication
  against the target's open Issues and this installation's filed reports of the last 14 days, at most three filed
  Issues per day, required title/evidence/reproduction, the automated-agent disclosure, no Feishu content
  (chat, message, user, union and app ids), credentials or private local paths (Unicode drive-letter and UNC
  paths and the POSIX homes and system roots, while URLs and repository-relative paths stay valid), and only
  labels the repository already has. Drafts appear in Overview with their target repository, an evidence
  preview and age, and Approve and file or Dismiss actions recorded in the audit log; approving re-checks the
  exclusive jurisdiction rule, so a draft raised before the self repository was registered cannot file.
  `orchestrator_request_create` accepts `via: 'discovery'` (mutually exclusive with `automation`), so an
  in-jurisdiction finding becomes a Request and a Ticket under the Mandate basis `{ via: 'discovery' }`, which
  revalidation trusts like the installation basis; the Orchestrator prompt routes self-findings through these two
  outlets instead of the interim `memory_write` tag. Covered by `tests/self-reports.spec.ts`,
  `tests/self-reports-app.spec.ts`, `tests/http.spec.ts` (the real approve/dismiss routes and their audit entries),
  the extended tool, policy, migration, properties, prompt, view, panel and model-surface specs, and the regenerated
  `docs/reference` pages.
- The Orchestrator workspace is mandatory and first-class. The main Session now runs in an operator-selected, explicitly
  titled DeepSeek Harness workspace (`dsh-superagent-further · <directory name>`) instead of the plugin's `stateDir`; the
  path is a tier-A `workspace` settings block, validated and canonicalized by `src/app/workspace-root.ts` (absolute, empty
  or carrying `.dsh-superagent-workspace`, owner-only `0700`/ACL, no overlap with the state directory and its `work/`, the
  DSH home/profile/session store, the checkout or a project workspace; no symlink, UNC or root path). The master Session id
  is derived from the workspace (`orchestrator-<hash>`), and setup resolves the workspace before projects, accounts and the
  worker environment. A missing or invalid workspace is `workspaceRequired`, `workspaceInvalid`, `workspaceNotEmpty`,
  `workspaceNotWritable` or `workspaceUnsafe`, and startup stays `paused`/`setupPending` with no workspace registration, no
  master Session, no Source polling and no Executor. An upgrade archives the old master Session with `stopActivity`, deletes
  the legacy `stateDir` DSH workspace registration without deleting a Session, creates the new master Session in the selected
  workspace and publishes the new id in one `store.atomic` write; retiring the previous master is best-effort, so an archive
  or delete failure is logged as a warning, leaves the old Session and registration intact and readable, and startup still
  reaches `ready`. The setup wizard's workspace step is mandatory — skip,
  close and finish are inert until a workspace is saved, and `PUT wizard` refuses a skip — the Execution settings page shows
  the titled workspace card, and `GET state`/`GET settings` expose `setup.workspace` and `blocks.workspace`.
  `docs/adr/0003-workspace-identity.md` records the decision. Covered by `tests/workspace-identity.spec.ts` and the extended
  runtime, http, policy, model-surface and panel specs.
- Design document 014 — self-evolution: discovering superagent's own problems in flight and routing them by
  jurisdiction to a self-fix Ticket (repository registered) or a GitHub Issue on the self repository, with a
  gated Issue outlet and a switchable scheduled self-inspection. Approved by the operator on 2026-11-10 with
  the recommended defaults; implementation begins with the prompt layer. A Chinese counterpart,
  `docs/014-self-evolution.zh-CN.md`, carries the same content for the operator's review.
- The self-evolution discovery layer (first phase of document 014): the worker, Lead and Orchestrator prompts and the
  project-request skill tell a Session that notices a concrete, checkable problem of superagent itself to record it,
  never fix it inside the current Ticket, and route it by jurisdiction — `request_create` in the self repository's own
  project, a Lead escalation from any other, and `memory_write` tagged `self-finding` for the main Session until its
  routing outlets land.
- The Execution tab gains a Workers block: `GET workers` lists each open Ticket's worker Session, its Assignment state,
  and each background job's status and latest output preview, including jobs still running. `DshExecutor.jobsSnapshot()`
  now merges a running worker's live jobs (read observe-only from the job registry) with the persisted settled snapshots.
- A failed `orchestrator_send_file` now says why: `Runtime.sendFile` keeps the Source's reason in the thrown error and the
  tool response, records it in a bounded delivery-failure ring, writes a warning to the Host log, and Overview shows the
  recent failures as a problem row naming the file, chat and reason.
- A Ticket now records why it ended: `ended.cause` is `report` (the worker's own ready or dropped Report), `human` (a
  person's stop), `merge` (a followed pull request's close) or `eval`, beside `ended.by` (`executor` or `human`) and the
  outcome. `Executor.stop` receives the matching `ExecutorStopCause` (`TicketEndCause | 'retry'`) instead of inferring
  teardown authority from report timing, and schema 23 backfills every ended Ticket's cause.
- `docs/adr/0001-ticket-end-authority.md` records the ticket-end decision: explicit causes, retirement after the reporting
  turn, immediate external preemption, one notification authority per role, the rejected alternatives and the accepted
  crash-window risk.
- The panel's Host log now outlives a restart and carries the plugin's full operational record. `src/app/logs.ts` keeps
  a 2000-entry ring (200 by default) with level and scope filters, keyword search, structured `data`, credential
  redaction, minimum-level gating and 60-second folding of repeated entries. `src/app/log-files.ts` appends every entry
  to durable JSONL files under `<stateDir>/logs`: one file per UTC day, rotation to `.N` at 20 MiB, retention pruning at
  startup and day rollover, a 50 ms unref batch flush, a bounded queue with a dropped count, owner-only ACLs, an 8 KiB
  line cap, and one `logs` health claim that reports a write failure once without breaking the caller or recursing.
  Its `close()` stops accepting entries from its first line, shares one promise across repeated calls and drains the
  last batch with asynchronous appends, so shutdown bounds a real wait instead of a synchronous disk stall.
  Sessions, Setup, Automations and the Outbox keep writing their scoped warnings, and the Runtime records the lifecycle,
  outbox delivery, health-transition, `policy.changed` and `decision.recorded` entries. The Executor and Sources add
  metadata-only scopes: launch/retire/preempt, turn start/end, background-job settlement, report state/outcome and agent
  errors under `executor`, and per-poll success/failure/recovery under each Source kind. The Execution settings block
  gains `logLevel` (`info` or `debug`) and `logRetentionDays` (1–30), which apply without a restart; the panel exposes
  both in a Logs group. `GET logs` accepts the keyword search as `q` beside its level and scope filters. `tests/log-files.spec.ts` and `tests/operational-log.spec.ts` cover the sink, redaction, folding,
  level gating and every new scope; nothing records a message body, tool argument or result, report summary, setting
  value, or model content.
- The Logs page completes the operator surface: a keyword search (`q`, matching message, scope and data), **Copy**
  of the current filtered view as JSONL, a client-side **Download JSONL** Blob with one object per line in the file's
  fields, **Load more** in pages of 200 up to the 2000-entry ring with the loaded count, and a deep link from Ticket,
  Request and Assignment views that prefills `q=ticket=<id>`, `q=request=<id>` or `q=assignment=<id>` through the
  typed client route (no new HTTP route, no file route).
- Human-triggered domain actions now leave an `audit` scope entry beside the automatic lifecycle records: settings
  save and restore (block, revision, restored-from), Ticket retry and stop, escalation decisions (request, decision and
  unit count) and automation create/edit/run/delete (automation id). Every entry is level `info`, carries
  `actor=operator`, and records no setting value, reply or reason text, automation instruction, message body, tool
  argument or result; failed actions and automatic events create none. `tests/http.spec.ts` pins both directions.
- `scripts/archive-state.mjs` now archives the real database, `<stateDir>/orchestrator.sqlite`, by default and accepts
  `--database <path>`; its usage text, SECURITY.md, CONTRIBUTING.md and docs/013 say `orchestrator.sqlite`.
  docs/013 also documents that `<stateDir>/logs` is not part of an archive-state snapshot, its day/`.N` rotation and
  1–30 day retention, and copying it by hand; `tests/archive-state.spec.ts` covers the default, the override and the
  refusals.
- `docs/adr/0002-operational-log-files.md` records the operational-log decision: one durable JSONL sink beside the
  memory ring, single writer, UTC day files, 20 MiB rotation, 1–30 day pruning, metadata-only with an operator audit
  allowlist, the crash window of the last queued batch, and why logs stay outside archive-state; it also records the
  rejected memory-only, database-table and full-body alternatives. docs/005, docs/006, docs/007, docs/009,
  docs/011 Part H, docs/013, README and README.zh-CN are synchronized.

### Changed

- Memory is labeled an experimental feature and is off by default: a fresh installation injects nothing, the memory tools
  refuse, and finished work is not recorded until the operator turns on **Memory enabled** in **Settings → Memory**. The
  Memory page carries the experimental label, pre-injection stays a separate opt-in, and existing installations keep
  their saved switch value.
- Memory pre-injection is off by default: a project Lead or the main Session still has the memory tools and automatic
  records, but pinned and recent memories reach the model only after the operator turns on **Inject memory** in
  **Settings → Memory**. Existing installations keep their saved switch value.
- A background job that settles as its worker's turn ends no longer loses its result: the Executor watches each running worker Session's jobs, records a bounded snapshot on the Assignment for the panel, and wakes a worker that still runs through its project Lead with an idempotent `job-settled:<jobId>` message telling it to read the output with `job_output` and continue. DSH's own completion notice is only injected in that case, and a turn that ends before its next step can miss it.
- A Runtime watchdog checks open Tickets every minute: when a running Assignment's worker Session has been idle for 10 minutes, the watchdog writes a waiting Report that raises the Ticket's attention and sends its Lead one durable notice to inspect the Session or stop the work; a newer Report or the end of the Assignment clears the attention.
- A worker's `job_output` wait lasts 60 seconds by default and up to 10 minutes (previously 5 seconds), so it can finish a
  background job before its turn ends; router and Lead Sessions keep their 5-second waits.
- A worker finishes every background job it starts before its turn ends: the work instructions tell it to run the command
  in the foreground, wait on the job with `job_output` until it settles, or report blocked naming the job, and forbid
  ending a turn to wait for a wake, which stalled one assignment for three hours.
- A worker keeps one worktree and cwd per Ticket: another worktree is evidence only through its absolute path, and no gate
  probe relies on a relative path.
- A report that ends an `answer` Ticket no longer cancels the turn that made it. Retirement runs after the ending
  transaction commits and waits up to `RETIRE_GRACE_MS` (60 s) for the worker's turn to end before disposing its
  activation and stopping background work; a turn that outlives the grace is cancelled as a user stop. External endings
  (a person's stop, a followed pull request's close, an Eval stop, a retry) still preempt the turn at once, and a retry
  ends only the Assignment. Covered by `tests/executor-retirement.spec.ts`.
- Worker activations now start with DSH delivery `caller`, so the application's own durable Lead messages are the single
  notification authority and DSH settlement notices never reach the Lead model; reviewer activations keep `parent`
  delivery because the reviewer has no application tool, and its settlement notice is what prompts the Lead's
  `lead_review_record` verdict. This also stops a report-caused retirement from telling the Lead the worker was stopped
  before its turn ended.
- Documentation pass for the ticket-end contract: docs/003 and docs/010 describe retirement and the caller/parent split,
  docs/007 names `TicketEndBy`/`TicketEndCause` and the grace, docs/014 plans the future `self_report` at schema 24
  (schema 23 is the cause backfill), the roadmap carries the current counts and a Sprint 36 checklist, and numbered docs
  may link to `docs/adr/*.md`.

### Fixed

- Selecting a previously used workspace after switching away no longer leaves the Orchestrator silently disabled. Switching
  away archived that workspace's deterministic master Session, and DSH's archived-session gate then rejected every step
  while startup still reported `ready`. Startup now unarchives the desired workspace-derived master before resolving it, so
  the workspace resumes its own identity and conversation instead of resuming a dead Session; the legacy `stateDir`-derived
  master stays archived and is never resumed, and an unarchive failure fails closed with `workspaceUnsafe` rather than
  starting an orchestrator that cannot take a step. Covered by the A → B → A restart test in
  `tests/workspace-identity.spec.ts`.
- A workspace path that merely starts with `..` is no longer mistaken for a parent escape. The overlap check treated any
  `relative()` result beginning with `..` as outside, so a directory inside a forbidden location whose own name begins
  with two dots — `<stateDir>/..workspace`, a DSH-home descendant or a project-checkout descendant — was accepted as the
  agent cwd and DSH workspace. Only the `..` parent entry itself or a path beginning with `..` plus the separator is now
  treated as outside, so every descendant of the state directory, the DSH home/profile/session store, the checkout and
  the project checkouts is rejected. Covered by `tests/workspace-identity.spec.ts`.

## [0.4.0] - 2026-11-10

### Added

- Merged and closed pull requests are relayed to the affected project Lead, which notifies the Ticket's worker Sessions with
  the new `lead_notify_worker` tool. The Orchestrator writes one durable Lead message per ended Ticket; a project-less
  installation Ticket has no Lead to notify, and a Lead may only relay to worker or reviewer Sessions of its own project.

- A change Ticket can carry an independent review its project Lead starts with `lead_review`; a blocked verdict keeps the Ticket open when its pull request merges.
- Reports may carry up to 20 verification checks, shown as evidence on the Ticket and counted in request notices.
- A layering check (`architecture:check`) rejects core importing the layers above it, the client importing the server, and src importing development tooling.
- An operations runbook (013) documents the daily checks, state backups, recovery and upgrades; `SECURITY.md` records the trust boundaries and the reporting path.
- `scripts/archive-state.mjs` takes a consistent `VACUUM INTO` copy of the state database and prunes old archives; `pnpm test:coverage` reports coverage without gating.
- `CONTRIBUTING.md` describes the working loop, the gates and the hand-offs for a person, an ordinary coding agent, the Orchestrator, a Lead, a Worker and a Reviewer.

- `pnpm check` now verifies the packed tarball against `scripts/pack-manifest.json` (`pack:check`) and compares the generated tool and settings references with the code (`docs:generate`, `docs:check`), so packaging or reference drift fails the gate.

- A mounted-surface test asserts every loaded tool set, the bundled skills and the bundle's preset rows, and seeded property tests cover admission, Trigger identity across repositories, idempotent creation, schema 22 migration and reconcile fixed points.

- Escalations can be decided from the Overview with their required reply; the panel and the main Session share the same decision path and Lead delivery.

- Three operational skills ship with the plugin — triage, release and project requests — registered for every Session and protected from a same-named custom skill.

- Project requests (schema 21): `request_create` lets a worker raise a durable project request when its Ticket needs a
  decision, a new deliverable or another project's work, and its completion report names the requests it leaves open
  in `requests`. Project requests bypass the admission gate and grant no wider authority than the Lead already owns.
  The project Lead answers through `lead_requests`, `lead_request_decide`, `lead_request_reply`,
  `lead_request_complete`, `lead_request_approval` and `lead_request_approve`; every disposition carries a non-empty
  reply delivered to the raising Session, an unanswered request is reminded twice and then recorded as needing
  attention, and an accepted work request creates the ordinary Request and its staged Tickets under a Lead Mandate
  confined to that project. A rejected or `needs-info` request records the answer and changes nothing else.

- The project-request report and approval flow: a root request is closed with one aggregate report on the Channels its
  chain started from, listing every Ticket, its pull-request outcome and every derived request; an architecture
  request first creates a design Ticket, sends the proposal to the root Thread, and creates the implementation Request
  and Tickets only after `lead_request_approve` records a person's approval written after the proposal. An explicit
  whitelisted @ mention or direct message now receives one notice when Eval ignores it, finds it unavailable or stops
  it. An independent DSH Session can submit work through the `session` Source kind and the global `superagent_submit`
  tool; every outcome is answered on that Session, and a completed Request reports back to it.

- A Ticket deliverable contract (schema 22): `deliverable` is `change` or `answer`. A change Ticket ends only through
  the pull requests it names or follows: its ready report without a pull request is refused with
  `changeNeedsPullRequest`, records the pull request it names, and it is prepared in its own branch. An answer Ticket
  reads the project's live checkout read-only — no branch, worktree, prepare command or write access — and its ready
  report ends it as `completed`, shown as Answered. The accept names the deliverable (`deliverable` defaults to
  `change`; only a change requires `worktree_name`). Migration to schema 22 records `change` for open Tickets and for
  ended Tickets with a followed pull request, and `answer` for any other ended Ticket.

- Lead-raised project requests from automation deliveries (docs/012 D11): a project-scope automation delivery is a
  standing instruction, not a Source Trigger, so the Lead may raise one work project request for its own project with
  `lead_request_create` (recording the `automation` id from the delivery marker) and decide it with
  `lead_request_decide`. Accepting a request without a root Trigger now creates the ordinary Request and its Tickets
  through `Tickets.createLead`, with empty Channels and a `dsh-superagent:lead:<project>` Mandate actor; a rootless
  architecture accept still refuses because the human approval needs the root Thread. The report-only rule permits
  exactly that project request and no other project write, and the panel's Lead row shows the pending count and how
  many came from automations.

- Installation-level self-bootstrap (docs/012 D12): `orchestrator_request_create` lets the main Session turn an
  installation automation delivery's findings into one rootless Request with one Ticket per registered delivery unit.
  The tool requires an existing `installation`-scope automation (project findings stay with their Lead), records the
  automation id as the Mandate's provenance (`basis.via = 'installation'`, actor `dsh-superagent:installation`), returns
  the open Request for a repeated raise, and creates no Channels; revalidation trusts the installation basis. The
  delivery's write budget remains the Request it creates.

- Lead escalation (docs/012 D13): `lead_request_escalate` lets a project Lead escalate work that belongs outside its
  project; `orchestrator_escalations` and `orchestrator_escalation_decide` let the Orchestrator answer with the
  mandatory reply and, on accept, create one installation-level Request under an escalation Mandate. Reject and
  needs-info create no work; the decision is recorded as a durable notice for the source project's Lead.

- Manual run and delete for installation- and project-scope automation tasks: `automation_run` asks the Host's `schedule`
  service to deliver one run now without moving the scheduled occurrence and reports a pending execution as a conflict;
  `automation_delete` removes the Host task, the record and its whole delivery history on an explicit human request. Both
  are available from the Automations page (`Run now`, and `Delete` behind a confirmation dialog), through
  `POST /orchestrator/api/automations/:id/run` and `DELETE /orchestrator/api/automations/:id`, and in the main Session's
  tool list (six automation tools). A Host refusal to run or delete keeps the record and is reported; deleting an already
  missing Host task is fine.

- GitHub Issue and pull request labels for the main Session: `orchestrator_label` adds or removes labels the repository
  already defines on the work a Trigger names, through the new `SourceKind.labels` contract and its GitHub adapter. It
  never creates, renames or deletes labels, and it changes nothing else about the Issue.

- Issue and pull request triage as a built-in rule, and Feishu delivery of a design decision document: the new
  `triage` rule classifies an Issue or pull request, suggests severity, priority and assignment, and applies only
  labels that already exist when the operator explicitly asks it to; `src/sources/feishu-file.ts` and the main
  Session's `orchestrator_send_file` tool deliver an existing file inside a registered project's workspace to a
  Feishu chat (the file's directory is the CLI working directory, and the idempotency key hashes the chat and file),
  so a manager who is away from the machine can review a decision document. The resolver refuses absolute, parent,
  dot and repeated-separator paths, directories and missing files.

- The panel gains a **Logs** tab and `GET logs`: the plugin keeps a bounded in-memory ring of the Host log (400
  entries; no new on-disk artefact), with level and scope filters, while the Host logger still receives the raw
  printf arguments and console output is unchanged.

- The Overview gathers the work that waits for a person in one place: open escalations awaiting the Orchestrator and
  automation records that are orphaned or failed delivery now appear beside open Requests and Tickets, with a link to
  the Automations page. The view is read-only; approvals stay in the main Session.

### Changed

- The built-in accept rule set now has sixteen categories: `settings` (更改 SuperAgent 配置), `automation`
  (项目 dsh 自动化任务), `deps` (依赖与工具链升级), `pr-feedback` (审查意见修复), `design` (方案设计与架构决策) and
  `triage` (Issue/PR 分流) join the existing ten, and every built-in rule ships enabled instead of only `copy` and
  `visual`. A large or cross-project refactor first produces a staged plan and rollback points under `design`, and the
  cross-project part becomes a Request. Existing installations whose stored rules are still exactly the 0.3.0 ten-rule
  defaults, the earlier twelve-category defaults or the earlier fifteen-category defaults are upgraded to the all-enabled
  sixteen-rule set when settings are read; operator-edited, renamed, added or removed rules are preserved.

### Fixed
- Trigger IDs for GitHub Issues, pull requests, comments and CI are scoped by repository, so an Issue in one project whose number another project already used is no longer dropped as a duplicate by the intake; the deployment's repository keeps its stored number-only IDs.

- A GitHub repository stream could skip an item and then stay blind to it: the read saved the listing's ETag even when it
  took nothing in, and every later conditional read was answered 304. A stream now saves an ETag only when the read
  skipped no item, trusts it for at most ten minutes before one unconditional read confirms the list again, and the first
  start after this upgrade drops saved stream ETags once so a list that was skipped earlier is read in full again. This
  is how an Issue filed in the project's own repository was listed by the poller but never became a Trigger.

## [0.3.0] - 2026-11-09

The package and every registration identity are now `dsh-superagent-further`: the npm package and bundle name, the
bundle's component and preset ids, the two Source component names, the web client bundle id, the skill names and
directories, the panel's locale namespace and the checked-in scripts. Existing installations follow the migration
steps in [006](docs/006-deployment.md#migrating-from-dsh-superagent): replace the profile dependency and bundle entry,
update the profile patch's package rows, rewrite the Session headers that name the old agent preset ids, and keep the
existing `stateDir`. The state database needs no rename migration: Source kinds, Thread and Ticket ids, the
`DSH_SUPERAGENT_*` environment variables and the stored delivery/comment markers keep their pre-0.3.0 values so queued
work, prepared commands and posted comments stay valid. The README status counts, state schema, panel documentation and
glossary are brought up to date with the current suite.

### Added

- The project layer: registered projects (id, local clone, remote repository), one GitHub Source polling every
  project's repository with qualified Thread ids, one persistent Lead Session per project, executors that run as the
  Lead's subagent in the project's own worktree, and Requests that group the Tickets of one cross-project delivery.
- Persistent memory: `memory_write`, `memory_search` and `memory_forget`, deterministic records for ended Tickets
  and Requests, a runtime-context snapshot that changes without rewriting the system prompt, and the panel Memory page
  with live switches, limits, keyword search, project filter, paging, pinning and retention that only ages out
  automatic records.
- A default-language setting carried to every Session in the runtime-context snapshot; Feishu and GitHub replies
  follow the message they answer while repository artifacts keep the repository's language.
- Ten Chinese proactive-rule categories with a lazy, idempotent upgrade of an installation's untouched English
  `copy`/`visual` pair; the eight new categories ship disabled.
- A first-run setup wizard (automatic once per browser session, permanent header entry, skippable) and the project
  editor under Settings → Execution.
- Agent-safe configuration: tiers A/B/C, a reason on every tool save, tier-B proposals with a panel diff and
  Apply/Reject, per-block restore of any retained revision, and the actor and reason in the settings history.
- Installation- and project-scope automation tasks around the DeepSeek Harness schedule service, with a panel page,
  panel-only notices and a bounded per-task delivery history.
- The `dsh-superagent-further` rename and `scripts/migrate-rename.mjs`, which also rewrites the Session preset cache
  so an installed host resumes.
- The derived primary repository: the GitHub Source no longer configures its own repository; the first registered
  project supplies it.
- Memory, language and automation runtime-context snapshots, and the schema 10 → 20 migrations.

## [0.2.0] - 2026-11-07

The first version that runs natively on Windows and is installable into a profile that already exists.

### Added

- A native Windows deployment path: absolute paths in the schema, `.cmd` workers, `icacls` owner-only state, a
  `cmd.exe` invocation for batch-file CLIs, `pwsh` as the main Session's shell tool, and a service script written in
  Node (no Python, no `tmux`, no `fcntl`).
- `POST /orchestrator/api/shutdown`, so a detached Windows host can stop gracefully.
- Installing the bundle into an existing profile (`dsh plugin --profile desktop add "link:…"`), and the warning that an
  in-app host applies the worker environment to every Session in the application.
- A daily digest of waiting Tickets to a Feishu chat (`digestChat`, `digestHour`), with its own health entry.
- `scripts/verify-install`, including a read-only state-database schema check.
- `scripts/switch-project`, for one profile per project.
- Observability in the panel: when a Source checks next, the reply queue with its oldest wait and next attempt, and a
  waiting Ticket's action with a warning after a day.
- `.github/workflows/check.yml`, running `pnpm check` on Linux, macOS and Windows with Node 22 and 24.

### Changed

- Every gate reads only the trusted Trigger fields, and how a body is treated as data is documented in
  `docs/007-architecture.md` and pinned by `tests/trust.spec.ts`.
- The test suite allows 30 s per test and 30 s per hook, because the specs drive real timers and SQLite.
- The state database migrates from schema 10 to 11 on start.

### Fixed

- A Feishu `[event] ready` line could overwrite a parse error and report the consumer as healthy.
- `scripts/dsh-superagent` could discover its own `status` process as the service on Linux.
- A recorded process that had already exited made `status` and `stop` fail instead of reporting it as stopped.
- A GitHub or Feishu reply carrying a newline could never be posted through a `.cmd` CLI; bodies now travel on stdin.
- A URL-encoded query string (`since=…T20%3A02%3A26.941Z`) was refused as if it were a `%VAR%` expansion.
- Two multi-step tests timed out on a loaded Windows CI runner; they now allow 30 s.

## [0.1.0] - 2026-10-31

The research prototype as imported from `deepseek-ai/dsh-superagent-prototype`: GitHub and Feishu Sources, the Policy
and admission pipeline, Tickets and their Executor Sessions, the management API and the web panel, on macOS and Linux.
