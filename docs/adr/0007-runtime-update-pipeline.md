# 0007 — A staged runtime update pipeline

- **Status:** accepted
- **Date:** 2026-11-11
- **Deciders:** the operator (approved plan, M36 brief), implemented by mission M36
- **Builds on:** [0006 A stable supervisor starts a versioned domain runtime](0006-supervisor-and-versioned-runtime.md)

## Context

[0006](0006-supervisor-and-versioned-runtime.md) made the domain runtime a verified, versioned bundle that the stable
`Supervisor` can load, journal and drain. It did not yet give the operator a supported way to put a new bundle into the
state directory, to ask the running host to swap to it, or to return to the last known-good version after a bad build.
Editing `current.json` by hand was the only path, and it had no database safety: a new runtime migrates the SQLite
schema on start, and an older runtime that sees the newer database must never write it.

The update must work inside the running DeepSeek Harness process. A restart would lose in-flight work, and the
state-directory lock must stay held across the swap so a second process cannot migrate the same database. The runtime
bundle is self-contained ESM, so a staged version can be loaded and started from disk without rebuilding the plugin.
That leaves three questions: how a bundle arrives, who owns the swap, and what happens after a crash or a failed start.

## Decision

1. **Staging is an operator filesystem step, not an HTTP upload.** `scripts/deploy-runtime.mjs stage` (wrapped as
   `pnpm deploy stage`) takes a built package (`lib/runtime-entry.js` plus `lib/runtime-manifest.json`), verifies the
   manifest shape, version, host API, integer schema, entry name and SHA-256, and copies both files into
   `<stateDir>/runtime/<version>/` through a temporary directory and one atomic rename. The staged manifest adds
   `builtAt` (the entry's modification time) and `node` (the staging interpreter). Staging the same bundle again is
   idempotent; a different bundle under an already-staged version is refused. The build's own `lib/runtime-manifest.json`
   is never rewritten.

2. **The supervisor owns the swap; the operator only writes a request.** `apply` and `rollback` create one
   `{api:1, id, action:'apply'|'rollback', version?, at, by:'operator'}` file under `<stateDir>/updates/`
   exclusively (`wx` + fsync), so a second writer that races the status check loses with `EEXIST` and is refused
   instead of replacing the identifier that is already waiting; a torn file from a crash is quarantined as malformed,
   never acted on. The `UpdateEngine` polls with an unref'd 2 s timer while the supervisor runs, validates the request
   strictly, claims it by renaming `request.json` to `request.processing.json`, and processes one request at a time.
   Status, watch and the panel's rollback action read the same files; there is no request in memory that a crash would
   lose. The supervisor keeps the state-directory lock for the whole update.

3. **The apply is a journaled, bounded state machine.** `prepare → stage → backup → drain → swap → load → init →
   commit`:
   - `stage` verifies the staged descriptor again and refuses a schema older than the database before anything drains.
   - `backup` runs SQLite `VACUUM INTO <stateDir>/runtime/backups/<version>-<timestamp>.sqlite` while the old runtime
     still serves, bounded by a busy timeout; no database yet means the phase is skipped.
   - `drain` calls the old runtime handle's own `drain('update')` — the same contract and phases as shutdown — so intake
     stops, in-flight work settles, and the Store closes. The supervisor keeps the lock; the runtime's lock phase is a
     no-op because the supervisor has not set `releasing`.
   - `swap` writes `previous.json` (the old current, or the recorded previous when no current exists; only when that
     descriptor verifies inside the runtime directory, since the packaged descriptor is relative to the package and can
     never be a rollback target) and then `current.json` (the new descriptor), each through a mode-`0600` temporary file,
     fsync and rename.
   - `load` and `init` use the same loader as startup: host API, hash, integer schema and downgrade refusal, then a
     bounded `ready` and the supervisor's self-check (`configured()`, `setupProblem`, `versionStatus()`), which catches a
     runtime that starts but cannot serve.
   - `commit` updates the journal and the cached status, records `update.applied`, releases the claim and appends the
     history line.

4. **A failure after the backup or the swap restores everything.** The engine disposes the failed candidate with a bound,
   copies the database backup over `orchestrator.sqlite` (removing stale `-wal`/`-shm` files first), restores both
   pointers byte-for-byte as they were, reloads the previous runtime (else the packaged one) with the same bounded loader
   path, journals `fail('rollback', …)`, appends a `rolledback` or `failed` history entry and logs
   `update.failed phase=… reason=…`. The ring line feeds the `update-failures` incident rule. No exception is rethrown
   into the Cordis fiber; the supervisor stays alive. A failure before the swap only needs the journal and the history.

5. **The schema only moves forward.** Stage and load both refuse a descriptor whose `schema` is below the database's,
   and `loadRuntime` independently refuses a module whose `SCHEMA_VERSION` is lower. The engine never attempts a
   downgrade, and `rollback` is offered only when the previous descriptor verifies and its schema is not older than the
   database. A database backup exists for crash recovery, not for resurrecting an older schema.

6. **Crash semantics are split between the journal and the history, and recovery reconciles the pointers.**
   `journal.json` remains the single source of truth for what the supervisor was doing; `history.jsonl` is an
   append-only, bounded operator trail of completed or interrupted outcomes (`applied`, `rolledback`, `failed`,
   `interrupted`, `rejected`). After a crash mid-update the next start reads the running journal. A crash at `swap`,
   `load`, `init` or `commit` is special: the swap writes both pointer files before the candidate is loaded, so
   `current.json` may name a version that was never loaded, self-checked, drained-in or committed. Before resolving any
   version the supervisor therefore reconciles both pointers from the journal's baseline — `current.json` from the
   recorded current (removed when the journal records no current), `previous.json` from the recorded previous
   (removed when it recorded `null`, left untouched when the record predates the field) — and logs
   `update.pointers-reconciled phase=… current=… previous=…`. Only then does it resolve, preferring the journal's
   recorded current when it still verifies. The engine records the pre-swap backup path in the journal
   (`Journal.noteBackup`), so if the database schema is newer than the recorded baseline's — the candidate's `init`
   migration committed before the process died — the supervisor also restores that backup and re-reads the schema before
   resolving, logging `update.database-restored phase=… schema=… backup=…`. Without this, the baseline and the packaged
   runtime would both be refused as schema downgrades and the host could not start. The restore is WAL-safe: the backup
   is copied to `<db>.restoring.tmp`, synced and verified as a readable SQLite database, then published as the
   complete-copy marker `<db>.restoring`; only after the marker exists are the failed database's `-wal`/`-shm` sidecars
   removed and the marker renamed over the database. A missing, unreadable or truncated backup, a failed copy or a crash
   during the copy therefore leaves the database and the write-ahead log SQLite would replay untouched, so a later boot
   still reads the candidate's committed schema and keeps failing closed instead of silently starting the baseline over
   dropped WAL frames. A crash after the marker is published is finished on the next boot before the schema is read —
   sidecars removed, marker renamed into place, `update.database-restore-finished schema=…` — while a partial
   `<db>.restoring.tmp` is discarded and the database is left alone. The restore is limited to a running `update` journal
   at `swap`, `load`, `init` or `commit`, a recorded path inside `runtime/backups/`, and a database strictly newer than
   the baseline schema; a committed journal, a missing or unreadable backup, a path outside that directory or an
   unrecorded baseline schema leaves the database untouched (`update.database-restore-skipped …`) and the ordinary
   fail-closed refusal stands. The complete marker is verified again at boot before it replaces the database. Without the pointer reconciliation, the *second* boot would have no running
   journal to lean on and would silently start the uncommitted candidate from `current.json`, with no drain, backup,
   self-check, history entry or journal record. A crash inside `commit`, after the candidate began serving in memory,
   still reconciles to the baseline: serving was never durable, and the baseline is the only state the journal vouches
   for. The engine then clears the stale processing claim and appends an `interrupted` entry; it never re-runs the failed
   swap. A crash between `journal.commit` and the history append is reconciled by the committed journal: the stale claim
   is cleared and the missing `applied` entry is appended from the claimed request.

7. **The panel surface is read-only plus one confirmed write.** The runtime exposes `GET updates` (same-origin, reads the
   files) and `POST updates/rollback`, which requires the literal `confirm:'ROLLBACK'`, audits `updates.rollback`, and
   writes one request. It refuses with 409 while a request is pending, a request is claimed or an update is running, and
   when no verified previous runtime exists. There is no route that accepts code, a path, a URL or a version body for
   staging. The Overview shows a pending or failed update as needing a person and links to the Updates tab.

8. **Dev-only HMR is not the production path.** The `dsh-tower enable-dev-hmr` command and the profile's
   `cordis.patch.yml` `id: hmr` entry reload client-plugin bundles during development, and even then a page refresh is
   often needed. Production updates are the staged version swap above; the HMR path is documented as development-only in
   [013 Operations runbook](../013-operations-runbook.md).

## Rejected alternatives

- **Upload a bundle through the panel or an HTTP route.** It would put untrusted code acceptance in the same surface a
  browser can reach, need its own authentication and size/streaming rules, and bypass the build check that guarantees a
  self-contained, hash-described artifact. The panel should not be a code-distribution channel; the operator stages on
  the host's filesystem.
- **Write `current.json` when the operator asks and restart nothing else.** No drain, no backup, no recovery: an
  in-flight Ticket would run against a closed Store, and a failed start would leave the pointers naming a bundle that
  cannot load. The journaled swap exists precisely to make each intermediate state recoverable.
- **Swap without a database backup.** Migrations run inside the new runtime's `init`; without a pre-swap copy, a failed
  migration could not be undone and the previous runtime could not reopen the database. `VACUUM INTO` is consistent and
  does not require a second process.
- **Remove the write-ahead log before copying the backup.** The first restore deleted `-wal`/`-shm` up front so SQLite
  would not replay the failed database's frames over the restored file. Production runs in WAL mode, so if the copy then
  failed — a missing, unreadable or truncated backup — or the process died between the two steps, the candidate's
  committed migration survived only in that log and the next boot read the older main file and started the baseline,
  silently dropping it. The restore now copies, syncs and verifies the backup, publishes it as a complete-copy marker,
  and only then removes the sidecars; a crash after the marker is published is finished at boot, and a failure before it
  leaves the database and its WAL untouched.
- **Allow a schema downgrade so rollback always works.** It lets older code rewrite a newer database, losing columns and
  semantics. Rollback is therefore limited to a previous runtime whose schema is at least the current database's, and the
  backup is a crash-recovery artifact, not a downgrade tool: boot recovery restores it only to undo a migration an
  uncommitted candidate committed, never to move a committed database backwards.
- **Run the update in the panel process or a helper process.** The state-directory lock, the log ring and the drain all
  live in the supervisor; a second process would either need the lock (blocked by design) or race the running runtime.
- **Keep the update request in memory or in the database.** A file is visible to the CLI, survives a crash, and can be
  claimed atomically by rename without a schema change. The database belongs to the domain runtime, which is being
  drained during the swap.
- **Treat every update as an incident and stop retrying.** A failed update is actionable, but one failed init is not an
  outage of the host: the engine recovers the previous runtime, records the phase and lets the operator stage a fixed
  build. The incident rule exists for the trace, not for an automatic retry loop.

## Consequences

The state directory gains `runtime/backups/`, `runtime/history.jsonl` and `updates/`; the runtime and its supervisor gain
the update engine, the staged deploy and drill scripts, the Updates tab and the `update-failures` detector. Schema stays
25, `RuntimeHost` stays at API 1 (the update engine is supervisor-side and the panel reads files), and no dependency is
added. An update is visible in the journal, the append-only history, the log ring, the incident record and the panel; a
rollback is one more request and swaps the same way. The operator can always fall back to the packaged runtime by
stopping the host and removing `current.json`, and can exercise the whole path with `pnpm drill` against a throwaway
state directory before touching production.

`tests/update.spec.ts` covers the two-boot crash recovery at `swap` and `init` (the reconciled pointers, the recovered
`versionStatus`, the uncommitted version never starting and `updateStatus()` reporting the recovered current/previous),
a schema-bumping crash that restores the journaled database backup and keeps the committed case from restoring, a
missing backup that fails closed (including a WAL-mode database whose committed migration must survive a refused restore,
so a second boot still refuses instead of starting the baseline), the complete-marker finish and partial-copy discard of
an interrupted restore, a truncated backup that is refused before the sidecars are touched, a committed update that lost
only its history append, and the packaged runtime never being recorded as the previous pointer; it also backs up a
database while another connection keeps WAL open, and drives a real `Runtime` through `drain('update')` and a
replacement start on the same state directory. `scripts/drill.mjs` runs 16
scenarios, including a simulated crash at each of the eight journaled apply phases followed by a second boot that must
serve the reconciled current pointer, and a schema-bumping crash that must restore the pre-swap database and serve the
baseline. The engine's apply loop itself is driven with interchangeable fake ESM bundles: serving the real built bundle
through the engine in-process needs the built package and the live DSH host, so that one composition is exercised by the
drill and by inspection of the shared `loadRuntime`/`DrainController` paths rather than by a unit test. That is the
residual risk: a defect confined to the composition inside `UpdateEngine.run` that neither the fake bundles nor the
real-runtime restart test would show.
