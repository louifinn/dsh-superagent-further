# 0004 — Operational incidents are detected deterministically, recorded durably, and never fixed automatically

- **Status:** accepted
- **Amended by:** [ADR 0005](0005-read-only-incident-diagnosis.md) — adds the read-only diagnoser and its audited operator actions; the detection contract here stands
- **Date:** 2026-11-11
- **Deciders:** the operator (approval recorded in the M33 brief), implemented by mission M33

## Context

The host already notices operational trouble: the health board reports each claim's state, the M21 watchdog asks the
Lead about a worker Session that has gone quiet, and the operational log keeps every warning in a bounded ring and the
JSONL files. None of it survives as a finding. A repeated fault — an Executor that fails four Assignments in ten
minutes, an outbox that cannot deliver, a Source whose polls keep timing out — is a hundred log lines that a person has
to read at the right moment, and the ring only holds the newest 2,000 entries.

Two adjacent capabilities exist but do not cover this. The self-evolution Issue outlet (schema 24, docs/014) turns
*findings about the product* into GitHub Issues, and the watchdog asks a Lead to inspect one stalled Assignment. Neither
records an operational condition as its own durable, deduplicated record with evidence, and neither is meant to: the
Issue outlet files outward, the watchdog acts inside one Ticket.

The approved control-plane plan fixes the boundary for this phase: detection makes zero model calls, writes no code and
changes no Ticket; evidence lives under the Orchestrator workspace; a later read-only diagnoser (M34) may interpret a
record, and the update pipeline (M36) owns the update-failure rule. This ADR records the decisions behind that contract.

## Decision

1. **A Store-owned `incident` table is schema 25.** The record holds `id`, a `fingerprint` that is `UNIQUE`, the `rule`,
   the scope ids (`project`, `ticket`, `request`, `session`) as their own columns beside the JSON value, `severity`
   (`low`, `medium`, `high`, `critical`), `status` (`detected`, `bundled`, `diagnosed`, `resolved`, `dismissed`),
   `first_at`, `last_at`, `occurrences`, `title`, `detail`, `evidence_dir`, `diagnosis`, `resolution` and `updated_at`.
   The Store creates the table before the migration chain runs; `migrateTo25` is a documented no-op and backfills
   nothing, so an upgraded installation starts with no invented history. Later phases add fields or transitions; the
   detection contract does not change.

2. **Detection is pure and deterministic.** `IncidentDetector` consumes four signals the Runtime already produces —
   Engine `DomainEvents`, every entry accepted by the `Logs` ring (before the verbosity gate, so a debug `poll.failed`
   still counts), the health board's real transitions, and the watchdog's stalled Assignment — and returns candidates or a
   recovery fingerprint. The rules are: failed/stopped/interrupted Assignment-end bursts (4 in 10 minutes per project),
   `agent.error` (3 in 10 minutes), outbox `reply delivery failed` (3 in 30 minutes), consecutive `poll.failed` per
   Source (3 in 10 minutes, recovered by `poll.recovered`), a health claim entering `error` (immediate, high) and a
   stalled Assignment (high, deduped against the watchdog's own request). `update-failures` is reserved for M36 and has
   no detector. Detection calls no model, keeps only bounded windows, and writes no Ticket, code or setting. The
   watchdog integration records an incident when it raises its existing request and never raises a second request.

3. **Noise is governed by the fingerprint, not by wording.** The fingerprint is a SHA-256 over the rule, the normalized
   scope ids and a detail whose digits are replaced, so a count changing from 3 to 7 is the same condition. An open
   record with that fingerprint increments `occurrences` and `last_at` and moves severity only upward; it never creates
   a second record or bundle. A `resolved` or `dismissed` record stays quiet for a one-hour cooldown measured from
   `last_at`, then reopens the same record and clears the resolution. New records are bounded by a daily budget (default
   2, per UTC day of `first_at`), an open-record cap (100) and a minimum severity (default `high`). `health-error` and
   `stalled-assignment` are exempt from the daily budget, because they describe a live outage that must be recorded
   even after the day's budget is spent (`incidentBudgetExempt` in `src/core/incidents.ts`); fingerprint dedupe, the
   closed-record cooldown, the open-record cap and the minimum severity still apply to them. A disabled detector records
   nothing.

4. **Evidence is a content-addressed bundle under the workspace.** Before a record becomes `bundled` the service writes
   `<workspace>/artifacts/incidents/<id>/`: `config.json` (schema, version, rule, scope, severity, the incidents
   settings and the settings redacted through `redactData`), `health.json` (the current claims), `related.json` (the
   rule and scope ids) and `log-window.jsonl` (a 30-minute window from the ring and the durable JSONL files, deduped and
   capped at 500 lines), then `manifest.json` with each file's name, size, SHA-256 and a content digest over the list.
   Directories and files are owner-only (`0700`/`0600`, `restrictToOwner`). The newest 20 bundles and those under 30
   days are kept. A failed bundle deletes its partial directory, leaves the record `detected` with no evidence, sets the
   `incidents` health claim to `error` and writes one log line — never throws out of the emitting pass, and never loses
   the record.

5. **Recording is automatic; fixing is not.** No rule changes code, retries a Ticket, edits a setting or calls a model.
   The transitions `detected → bundled → diagnosed → resolved|dismissed` and the reopen path exist for a person and for
   M34; this release exposes no diagnose or dismiss button, and only the service's `recover` resolves a record when a
   condition clears (a Source polling again). Detection is not audited, because no person decided anything; M34's
   diagnosis and dismissal actions will be.

6. **The panel and the API read the same records.** `GET incidents` filters by status (`open`, one status or `all`),
   severity and scope ids and pages with `offset`/`limit`; `GET incidents/<id>` adds the evidence summary. The Incidents
   tab lists, filters and opens records, and Overview shows a "needs you" block while any record is open. The settings
   are a tier-C `executor.incidents` block (`enabled`, `autoDiagnose`, `dailyBudget`, `minimumSeverity`) on the
   Execution settings; `autoDiagnose` is stored for M34 and changes no behavior now.

## Rejected alternatives

- **A model call to triage the log.** It would make the same fault cost differently every time, introduce prompt and
  provider failures into the detection path, and blur the operator's approved boundary. Detection stays arithmetic;
  interpretation belongs to M34's read-only diagnoser.
- **Deduplicate by title or by a fixed rule id alone.** Titles are prose and rule ids are too coarse: every stalled
  Assignment in a project would collapse into one record and hide which Ticket stalled. The fingerprint over rule,
  scope and normalized detail keeps distinct conditions distinct and repeated bursts as occurrences.
- **Keep incidents only in the log ring or the JSONL files.** The ring is bounded and the files are pruned; neither can
  answer "how many times did this happen since Tuesday", and neither can carry a status. The table is the durable truth;
  the log window inside the bundle is evidence, not the record.
- **Store the evidence blobs in SQLite.** It grows the hot database with opaque payloads and makes the backup story
  worse; a directory under the workspace the operator already backs up keeps the bundle inspectable, and the manifest
  makes it verifiable. The trade-off is that the bundles are outside `archive-state`, which the runbook states.
- **Write the record and bundle atomically.** The bundle is filesystem I/O and can fail for reasons the database never
  sees; coupling them would either lose a real incident or leave a half-written directory. The record commits first as a
  finding, the bundle promotes it to `bundled`, and a failed bundle is a health error the operator can see.
- **Auto-fix obvious conditions (retry the Ticket, restart a Source).** The approved plan forbids automatic fixes, and a
  detector that also acts cannot be trusted as evidence: a crash in the repair would be attributed to the fault. M36's
  update pipeline and a person's decisions own the actions.
- **Reuse the self-evolution Issue outlet for operational findings.** The outlet's target is the product repository and
  its triage is a person approving a draft; an incident is about *this* installation and must stay local, with its own
  evidence and status. Routing an operational finding to GitHub is a later, deliberate decision, not detection.

## Consequences

- An installation that upgrades from schema 24 gains an empty `incident` table and no historical incidents; only
  conditions observed after the upgrade are recorded.
- A burst that repeats inside the cooldown is one record with a higher `occurrences` count, so the panel shows the
  persistence of the fault rather than one row per failure. A record that a person resolved stays quiet for an hour,
  then reopens by itself if the condition comes back; that is the intended reminder, and the daily budget bounds new
  records rather than repeats, except for the two live-outage rules it deliberately exempts.
- Evidence bundles are owner-only and pruned independently of the database: the runbook documents the path, the
  retention and the backup caveat. A failed bundle is visible on the `incidents` health entry and in the log, and the
  incident itself remains.
- The `incidents` health claim is `ready` while detection works; it is `error` only when a record could not be written
  or its bundle could not be produced, so a single bad filesystem state does not silence detection.
- Tests: `tests/incidents.spec.ts` pins the model, the fingerprint and every rule; `tests/incidents-runtime.spec.ts`
  pins a seeded fault becoming exactly one incident with a complete bundle, cooldown counting and reopen, the failed
  bundle's health error without a throw, the watchdog dedupe and the management API; `tests/migration.spec.ts` and
  `tests/properties.spec.ts` pin schema 25; `tests/panel-incidents.spec.tsx` pins the page and the Overview row.

## References

- [005 Panel](../005-panel.md) — the Incidents tab, the Overview "needs you" block and the Execution settings group.
- [006 Deployment](../006-deployment.md) — schema 25 verification, the tier-C incidents settings and the API routes.
- [007 Architecture](../007-architecture.md) — the incident table, `src/app/incidents.ts`, `src/app/incident-detectors.ts` and the runtime wiring.
- [011 Capabilities](../011-capabilities.md) — Part M, the approved detection contract.
- [013 Operations runbook](../013-operations-runbook.md) — where evidence lives, retention and the settings gate.
- [014 Self-evolution](../014-self-evolution.md) — the neighboring Issue outlet and its schema 24 table.
- [ADR 0002](0002-operational-log-files.md) — the durable JSONL log the evidence window reads.
- `src/core/incidents.ts`, `src/app/incidents.ts`, `src/app/incident-detectors.ts`, `src/app/logs.ts`, `src/app/runtime.ts`.
