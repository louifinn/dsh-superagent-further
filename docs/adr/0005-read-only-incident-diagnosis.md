# 0005 — Incidents are diagnosed read-only, within a bounded budget, and routed through the existing outlets

- **Status:** accepted
- **Date:** 2026-11-11
- **Deciders:** the operator (approval recorded in the M34 brief), implemented by mission M34

## Context

M33 records operational incidents deterministically and writes an evidence bundle, but a record is only a heading: the
title, rule and scope say *that* something failed, not why. Reading the bundle is work a person does rarely and late,
and the same fault can need the same explanation twice. The approved control-plane plan therefore adds a read-only
diagnoser: it may interpret one record and its evidence, and it must not write code, change a Ticket or touch the
installation.

Two adjacent mechanisms already create work. A *finding about the product* goes through the self-evolution outlet
(`SelfReports`, schema 24, docs/014) to a GitHub Issue with a three-state gate; a *finding about a registered project*
can become a discovery Request (`engine.raiseDiscoveryRequest`) that a Lead turns into Tickets and the normal PR and
human-merge flow finishes. Both take prose and both dedupe, and neither should be reimplemented for incidents. The
question this ADR settles is how a diagnosis becomes work without giving a model agency over the installation.

The M34 brief fixes the boundary: a read-only preset with only `agent-instructions`, `time-context` and a read-only
`tool-fs`; auto-diagnosis only for `high`/`critical` records, on by default, two a day; manual diagnosis from the panel
and the Orchestrator tool; routing through the already-implemented outlets; operational conclusions never become
Issues; every human action audited; no automatic fix or merge. This ADR records the decisions behind that contract.

## Decision

1. **The diagnostician is a separate, mechanism-enforced read-only preset.** `cordis.patch.yml` gains the row
   `dsh-superagent-further-diagnostician-preset` for the agent preset `dsh-superagent-further-diagnostician` (order 95,
   Chinese name and description, not selectable by hand). Its plugin inventory is exactly `agent-instructions`,
   `time-context` and `tool-fs` mounted with `write: false` and `edit: false`; it carries no shell, job, filesystem-search,
   skill, compaction, delegation, scheduling, goal, plan-mode, plugin-manager, web, todo, question or present tool. The
   preset, not the prompt, is the enforcement: a diagnosis cannot mutate because no mutating tool is installed. As
   defense in depth the dispatcher also puts the started child Session on the `read-only` permission preset through the
   host's `permissionPresets` service, where the host exposes one. `tests/bundle-patch.spec.ts` pins the inventory.

2. **Diagnosis is dispatched from the app layer, asynchronously, never inside detection.** `src/app/diagnosis.ts`
   (class `Diagnosis`) calls the DSH `subagents` service with `provider: 'spawn'`, `delivery: 'caller'`, `maxDepth: 1`,
   `agentPreset: DIAGNOSTICIAN_PRESET`, `childId: diag-<incidentId>-<8 hex>`, the main Session Agent as `parent`, and
   `cwd` equal to the selected Orchestrator workspace (never the state directory). The prompt carries the incident JSON,
   the evidence directory, the workspace, and the exact answer contract: one strict JSON object with `rootCause`,
   `evidence[]`, `hypotheses[]`, `fixPlan`, `confidence` and `target`
   (`{kind:'project', project} | {kind:'self'} | {kind:'operational'} | {kind:'none'}`), plus an instruction to read the
   bundle and write nothing. Detection itself makes no model call: `Runtime.detect` only hands a newly bundled record to
   `Diagnosis.consider`, whose gates and `setTimeout(…, 0)` schedule the work after the synchronous pass.

3. **Auto-diagnosis is narrow; manual diagnosis is deliberate.** `consider` starts a run only when incidents are
   enabled, `autoDiagnose` is on, the severity is `high` or `critical` and at or above `minimumSeverity`, the record is
   `detected` or `bundled`, and no run is active. A person may diagnose any open record from the panel or the
   `orchestrator_incident` tool; that action is audited. A run counts as an attempt even when it times out, fails or
   yields an unparseable answer, and the counter is not refunded.

4. **The budget and the single-flight are durable where they must be.** The attempt counter lives in the Store's kv area
   under a UTC day key (`incident-diagnoses:<YYYY-MM-DD>`) and is read and incremented inside one `Store.atomic`, so it
   survives a restart. The limit is the new tier-C setting `executor.incidents.diagnoseDailyBudget` (integer 0–24,
   default 2) beside the existing `executor.incidents` block; schema stays 25. Concurrency is one *in memory*: a second
   call while a run is active is refused with `concurrent` and does not spend budget. No `diagnosing` status is
   persisted, so a crash cannot strand a record.

5. **The wait is bounded and failure is local.** Starting the activation and awaiting its result are each bounded to
   10 minutes (`DIAGNOSIS_TIMEOUT_MS`) through `host.lifetime`; a timeout disposes the activation, records one `warn`
   line in scope `diagnosis`, sets the `incidents` health entry to `error` and leaves the record `bundled` with no
   diagnosis. The same holds for a refused start, an empty answer or an exception. Nothing escapes into the detector
   pass, and the record remains diagnosable and dismissable.

6. **The diagnosis is embedded in the existing record; schema 25 stays.** On success the service transitions
   `bundled → diagnosed` with `transitionIncident` and stores one JSON document in the existing `incident.diagnosis`
   column: `rootCause`, `evidence`, `hypotheses`, `fixPlan`, `confidence`, `target`, `parsed` and, for an unparseable
   answer, `raw`. `parseIncidentDiagnosis` validates it on read, and `GET incidents/<id>` exposes the parsed view. An
   unparseable answer is kept as a `low` confidence diagnosis with `target: none` — the evidence-and-raw text stays, and
   the run is not a failure. Parsing and validation never create a second model call.

7. **Routing reuses the two outlets and runs once per incident.** After a successful diagnosis the service routes by
   target, guarded by a non-empty `incident.resolution` so a record cannot be routed twice:
   - `project` (or a diagnosis naming a registered project by id, name or repository) →
     `engine.raiseDiscoveryRequest({title, instruction, units:[{project}]})` with the discovery Mandate basis and
     reason `discoveryFinding`; the Lead turns it into Tickets and the normal PR and human-merge flow applies. The
     resolution is `request:<id>`.
   - `self`, or a `project` target that is not registered → `SelfReports.raise`, which keeps its own three-state
     `eval.selfReport` gate (`off` drafts nothing, `observe` keeps a draft, `auto` files within its dedupe and daily
     cap) and its jurisdiction refusal. When the fixed self repository *is* a registered project, the route falls back
     to a discovery Request under that project. The resolution is `self-report:<id>` or `self-report:off`.
   - `operational` or `none` → **no Request and no Issue**: the diagnosis stays on the record and is surfaced in the
     panel and the Overview "needs you" row. The resolution is `operational`.
   A failed automatic route leaves the resolution empty, logs one `warn` line in scope `diagnosis`, and lets a person
   retry it from the panel or the tool. A person-triggered route requires `confirm: true`.

8. **Dismissal is explicit and reversible by detection.** `Incidents.dismiss(id, reason)` requires a reason, transitions
   the record to `dismissed` with `resolution: 'Dismissed: <reason>'`, saves it and logs one line. The reason is not an
   Issue comment and carries no evidence path.

9. **The panel, the HTTP routes and the Orchestrator tool share one service.** `GET incidents` and `GET incidents/<id>`
   stay read-only and typed; this release adds same-origin `POST incidents/:id/diagnose`, `POST incidents/:id/dismiss`
   (reason required) and `POST incidents/:id/route` (`confirm: true`), with 400 for a bad body, 404 for an unknown record
   and 409 for a wrong status or a refusal. The same actions are exposed as `orchestrator_incident`
   (`list|get|diagnose|dismiss|route`) on the main Session. Every human-triggered action writes the existing audit entry
   (`incident.diagnose`, `incident.dismiss`, `incident.route`) carrying metadata only: action, incident id, status,
   confidence, target and the resulting request/self-report ids. Never the diagnosis prose, the evidence or a log line.

10. **Diagnosis output cannot feed detection.** The incident detectors ignore log entries whose scope is `diagnosis` or a
    `diag-*` session, and `detect` ignores signals whose `scope.session` is a diagnosis child id. The `incidents` health
    entry is shared with detection and cannot itself be detected again (`healthChanged` already skips that name).

## Rejected alternatives

- **Enforce read-only in the prompt.** Prompts are suggestions; a model with `bash` or a writable `tool-fs` can ignore
  them. The preset inventory and the read-only permission preset are the enforcement, and the prompt only asks for the
  answer contract.
- **Diagnose inside the detector pass.** It would put provider latency and failures into a path that must be arithmetic
  and could double-record or recurse. The detector records; the app layer dispatches on its own turn.
- **A separate `diagnosis` table or a `diagnosing` status.** One optional JSON column on the existing record keeps schema
  25, gives reads a single row, and avoids a dangling intermediate state after a crash. The statuses remain the six
  M33 defined.
- **Unbounded or parallel diagnosis.** A diagnosis is optional work that costs money and may loop; two a day by default
  with a hard single-flight bounds both, and the setting can be zero.
- **Route operational incidents to GitHub.** The Issue outlet targets the product repository and its triage is a person
  approving a draft about the product. An operational incident is about *this* installation; filing it outward is noise
  the operator did not approve, so operational conclusions stay local.
- **Let the diagnosis create a Ticket or start a fix directly.** The approved flow keeps the Lead and the human merge
  authority between a finding and code. The diagnosis creates a Request or a self-report, never a Ticket, a branch or a
  pull request.
- **Reuse the Ticket end causes for routing.** They describe how a worker finished, not where a diagnosis went; storing
  the outcome in `incident.resolution` avoids a migration and keeps Ticket semantics untouched.

## Consequences

- Schema stays 25; the `diagnosis` column and the `resolution` column gain a documented JSON/token format, and an
  upgraded installation needs no migration.
- Auto-diagnosis is off only when the operator turns `autoDiagnose` off or the budget is spent; a manual diagnosis still
  works while the budget allows, and a spent budget surfaces as a refusal rather than an error.
- A timed-out or failed run is visible on the `incidents` health entry and in the log; the record remains `bundled` and
  can be diagnosed again after the budget resets or the fault is fixed.
- A routed record stays `diagnosed`; the resolution token is the only pointer to the Request or self-report, so the
  panel and the tool must resolve it rather than copy the URL. A `self-report:off` resolution means the outlet is off,
  not that routing failed.
- Operational conclusions never create outward work, so an operator who wants a product change from an operational
  incident must say so explicitly; the diagnosis and its evidence are one panel click away.
- Tests: `tests/diagnosis.spec.ts` pins dispatch (preset, parent, cwd, prompt, call), the timeout and failure
  degradations, the gates, the durable budget and restart, single-flight, parsing, routing (Request, self-report,
  operational, dedupe) and dismissal; `tests/diagnosis-runtime.spec.ts` pins the runtime wiring, that detection starts no
  model call, the HTTP actions and audit metadata, and the `orchestrator_incident` tool; `tests/bundle-patch.spec.ts`
  pins the preset inventory; `tests/panel-incidents.spec.tsx` and `tests/views.spec.ts` pin the panel actions and both
  locales.

## References

- [005 Panel](../005-panel.md) — the Incidents detail actions and the Overview row.
- [006 Deployment](../006-deployment.md) — `executor.incidents.diagnoseDailyBudget` and the API routes.
- [007 Architecture](../007-architecture.md) — `src/app/diagnosis.ts`, the preset and the runtime wiring.
- [011 Capabilities](../011-capabilities.md) — Part M, the read-only diagnosis contract.
- [013 Operations runbook](../013-operations-runbook.md) — diagnosis steps, the budget and the timeout.
- [014 Self-evolution](../014-self-evolution.md) — the Issue outlet the self target reuses and the Lead flow the project target reuses.
- [ADR 0004](0004-deterministic-incident-detection.md) — the detection contract this decision extends.
- `src/app/diagnosis.ts`, `src/app/incidents.ts`, `src/app/http.ts`, `src/app/tools/main.ts`, `cordis.patch.yml`.
