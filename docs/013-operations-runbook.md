# 013 Operations runbook

An installed Host runs unattended for weeks. This runbook covers the checks an operator runs, what the panel shows,
where the state lives, and how to take a consistent backup or recover from a stalled process. It assumes the
deployment commands in [006 Deployment](006-deployment.md) and the data model in [007 Architecture](007-architecture.md).

## Daily checks

1. Open the panel and the Overview tab. It gathers the work waiting for a person: open Requests, escalations the
   Orchestrator must decide, automations whose Host task ended or reported an error, and the Leads and Executors per
   project.
2. Open the Logs tab, filter to `warn` and `error`, and read entries by scope. Healthy operations are `info` entries
   under `runtime` (one startup summary of the claims that came up ready), `trigger`, `ticket`, `request` and
   `assignment`. `host` holds the Runtime's own warnings, including a failed file delivery; `outbox` carries reply
   delivery (delivered, dropped or failed). A GitHub Source that fails `failuresBeforeError` polls in a row (default
   3, configurable from 1 to 20) reports `github` as a `warn` "is error" entry, and its recovery is an `info`
   "recovered: ready" entry; the Feishu loops (`feishu`) and the Feishu digest (`digest`) report an error on their
   first observed failure. `session`, `setup` and `automation` carry the plugin's own warnings. A single failed
   GitHub poll is not an error entry, and a failed reply logs one `warn` `reply delivery failed` for its first
   failure only — later retries of the same reply stay silent.
3. Read the artifact log from the current start when a panel entry is not enough, on a service-script host:
   `.artifacts/dsh-superagent-further-<profile>-<time>.log` under the workspace that started the Host. A desktop
   Host writes no artifact log; use the Logs tab and the JSONL files below instead.
4. Run `node scripts/verify-install --state-dir <dir>`; it prints the schema version, the enabled blocks and the
   Source setup problems, and exits non-zero while setup is incomplete.
5. Open the **Incidents** tab and work through any open record. The host creates and dedupes them without a model
   call, the **Diagnose** action interprets one read-only within the day's budget, and the next section says where
   the evidence lives, how a diagnosis becomes a Request or a self-report, and what the settings gate controls.

## Incidents

Detection is deterministic and records, but fixes nothing: an incident is a durable finding, not a repair. The host
watches four signals it already has — failed or stopped Assignment ends, the operational log (`agent.error`,
`reply delivery failed`, consecutive `poll.failed` per Source and its `poll.recovered`), a health claim flipping to
`error` and back, and the M21 watchdog's stalled Assignment — and dedupes them by fingerprint.

- **Where to look**: the **Incidents** tab, or `GET incidents` / `GET incidents/<id>` on the management API. The list
  starts at open records (`detected`, `bundled`, `diagnosed`) and filters by any status, severity and scope id
  (`project`, `ticket`, `request`, `session`). A record shows the rule, severity, scope ids, first and last seen times,
  `occurrences`, a short ids-and-counts detail and the fingerprint. Overview adds a "needs you" block while any record
  is open.
- **Evidence**: each record writes a bundle under `<workspace>/artifacts/incidents/<id>/` — its directory is shown on
  the detail. The bundle holds `config.json` (the redacted settings block and the plugin version), `health.json`, the
  related scope ids and a 30-minute `log-window.jsonl` gathered from the ring and the durable files, and
  `manifest.json` hashes every file. The directories and files are owner-only. The newest 20 bundles and those under
  30 days are kept; a record whose bundle could not be written stays `detected` with no evidence, and the `incidents`
  health claim turns to `error` — a detection failure never breaks a pass.
- **Noise controls**: **Execution → Settings → Incident detection** (tier C, panel or API only) sets `enabled`, the
  daily budget of new records (default 2), the diagnosis budget of attempts (default 2, `diagnoseDailyBudget`), the
  minimum severity (default `high`) and `autoDiagnose`. Repeats of one condition count occurrences and do not use the
  detection budget; a resolved or dismissed record stays quiet for a one-hour cooldown and then reopens. A health flip
  and a stalled Assignment are recorded at high severity even after the daily budget is spent; fingerprint dedupe, the
  cooldown and the open-record cap still apply to them.
- **Diagnosis**: a `detected` or `bundled` record can be diagnosed read-only by the **Diagnose** button, the
  `orchestrator_incident` tool (`{action: "diagnose", id}`) or `POST incidents/<id>/diagnose`; a `diagnosed` record
  can only be routed, dismissed or resolved. Auto-diagnosis runs by default for `high` and
  `critical` records once they are bundled; it is on only while `autoDiagnose` is on, the severity is at or above
  `minimumSeverity`, and the day's attempt budget is not spent. Every attempt counts, including a timeout, so a spent
  budget refuses until the next UTC day; a manual diagnosis and an automatic one share the same budget and there is
  one run at a time. Start and result together are bounded to 10 minutes: a start that overruns aborts the signal and
  disposes a late activation once, a result timeout disposes the activation it holds, and either one logs a warning in
  the `diagnosis` scope, turns the `incidents` health claim to `error`, and leaves the record retryable. A completion
  that finds the record dismissed, resolved, reopened or counted again while it ran is refused as `stale` (one
  `diagnosis` warning, no health error) and the newer record wins, so a slow run never resurrects a closed record or
  loses occurrences. The diagnosis appears on the detail with its root cause, evidence, hypotheses, fix
  plan, confidence and target; an unparseable answer is kept as a low-confidence diagnosis and is not routable.
- **Creating fix work**: **Create fix** (or `{action: "route", id, confirm: true}` / `POST incidents/<id>/route` with
  `{"confirm": true}`) routes a current diagnosed record with a parsed diagnosis once; reopening a record keeps the
  old diagnosis text but clears the token, so routing it is refused until it is diagnosed again. A registered project
  becomes a discovery Request — the Lead turns it into Tickets and the normal PR and human-merge flow applies — and the
  detail links to it (`request:<id>`). A `self` finding, or a `project` that is not registered, becomes a discovery
  Request under the registered self project when there is one (`request:<id>`); otherwise it goes to the
  self-evolution outlet as a draft or an Issue depending on the `eval.selfReport` gate (`self-report:<id>`, or
  `self-report:off` when the gate is off). The Issue outlet refuses jurisdiction while the self repository is
  registered, which is exactly why that case takes the Request path instead. An operational conclusion creates no
  Request and no Issue; it stays on the record (`operational`). One route runs at a time per record: an overlapping
  automatic, panel, HTTP or tool call is refused as `concurrent` (HTTP 409) and creates nothing. If the record is
  dismissed, resolved or counted again while the route awaits the work item, settlement is refused as `conflict`
  (HTTP 409): the newer record and its dismissal or recovery reason survive, and any work already created is named in
  one `diagnosis.route-conflict` warning, never recorded as the resolution and never deleted. If an automatic route
  failed the resolution is empty and the button retries it; the reservation is released afterwards, so the retry is
  never blocked. A failed route logs one warning in the `diagnosis` scope and never creates a second route for the
  same record.
- **Dismiss and audit**: **Dismiss** requires a reason and records `Dismissed: <reason>` on the record; the detail
  shows the reason through the localized dismissal key, and a second dismissal is refused. Diagnose, Create fix and
  Dismiss are audited in the Logs tab under `audit` with the action (`incident.diagnose`, `incident.route`,
  `incident.dismiss`), the incident id, status, confidence, target and the created resolution token
  (`request:<id>`, `self-report:<id>`, `self-report:off` or `operational`) — never the diagnosis prose or the evidence.
  The diagnose response carries the same token so a caller learns the work id the automatic route created.
- **What this does not do**: detection and diagnosis make no code change, retry no Ticket and merge nothing, and an
  operational conclusion never becomes an Issue. The `update-failures` rule remains reserved for M36.
- **Schema**: records live in the `incident` table of schema 25. A schema 24 database migrates on start with the
  table created empty; no backfill invents historical incidents. The table is not part of `archive-state` beyond the
  database copy, and the evidence bundles live outside the database, so copy `<workspace>/artifacts/incidents`
  separately when a backup must include them.

## State and backups

- The state database is `orchestrator.sqlite` in the profile's state directory (the panel's setup page prints the
  path). It runs in WAL mode; never copy it by hand while the Host is writing.
- Take a consistent archive with `node scripts/archive-state.mjs --state-dir <dir> [--database <path>] [--keep 5]
  [--out <dir>]`. `--database` overrides the default `<stateDir>/orchestrator.sqlite`. It uses SQLite's `VACUUM INTO`
  under the database's own lock, writes `state-<UTC timestamp>.sqlite` into `<stateDir>/archive` and prunes the oldest
  archives beyond `--keep`. Run it before an upgrade or a manual repair.
- The operational log files under `<stateDir>/logs` are **not** part of an archive-state snapshot. Keep them for
  troubleshooting in their retention window: one JSONL file per UTC day (`YYYY-MM-DD.jsonl`); at 20 MiB that file is
  closed and the next flush opens `YYYY-MM-DD.1.jsonl`, then `.2`, and so on, so the base day file keeps the day's
  oldest records. Older files are pruned after the configured 1–30 days. Copy them by hand when a backup must include
  them, and stop the Host for a quiescent copy: pausing is not enough, because the pause holds evaluation, dispatch
  and outbound delivery while Sources and health transitions still log. A copy taken while the Host runs (paused or
  not) may gain lines, so treat it as a best-effort backup rather than a consistent snapshot.
- `<stateDir>/runtime/` holds the versioned runtime: `current.json` and `previous.json` descriptors, one directory per
  deployed version, and `journal.json`. It belongs in a backup with the database; do not edit a pointer or a version
  directory while the Host runs, and never hand-edit a hash to make a bundle verify.
- Worktrees live under `<stateDir>/work`; `scripts/clean-worktrees` prunes finished ones by age. Do not delete a
  worktree of an open Ticket; its assignment is the only record of the checkout.

## Recovery

- **Stalled Source**: the Sources page shows `starting` while a Source is booting and `error` with the failure count
  when polling keeps failing. A reload of the plugin (below) restarts the Source loops without restarting DSH.
- **Stuck Host after an upgrade**: stop it with `node scripts/dsh-superagent-further stop`, rebuild `pnpm build`, start
  it again. The state database migrates forward on start; verify with `verify-install`.
- **Stale read position**: the GitHub Source keeps a per-repository cursor and an ETag. If a listing was skipped while an
  ETag was valid, the next poll re-reads after ten minutes; a one-time repair also runs when the plugin first sees the
  new code. Do not edit the `kv` table by hand.
- **A Ticket that will not end**: a change Ticket with a blocked review stays open by design; record a clean review or
  close it manually. A change Ticket whose worker never opened a pull request refuses `ready` with
  `changeNeedsPullRequest`; the report is the next action, not a retry.
- **Reload the plugin without restarting DSH**: in the plugin manager, disable and re-enable
  `include:dsh-superagent-further-github`; the loader reloads the bundle from `lib/` (rebuild first). The panel and the
  main Session keep working; the Sources restart as `starting`.
- **A deployed runtime was refused or fell back**: the Logs page (`host` scope) names the descriptor that was rejected
  and why — a missing or unreadable pointer, a bad hash, another host API, or a schema older than the database. Read
  `<stateDir>/runtime/journal.json` for the recorded phase and recovery note. Fix the deployment or remove
  `current.json` while the Host is stopped to start the packaged runtime; do not delete `previous.json` if it is the last
  known-good version.
- **The journal says `running`**: the previous process stopped during `startup` or `drain`. The next start recovers by
  preferring the recorded current version when it still verifies, then the previous verified version, then the packaged
  runtime, and records the recovery. Do not edit the journal or the database schema by hand; a runtime whose schema is
  older than the database is refused by design and the schema is never migrated down.

## Upgrade

1. `node scripts/archive-state.mjs --state-dir <dir>`; 2. pull the release tarball; 3. `pnpm install --frozen-lockfile && pnpm build`
(which also writes `lib/runtime-entry.js` and its manifest through the bundle check); 4. `node scripts/verify-install`;
5. reload the plugin; 6. confirm Overview and Logs are clean.

If the installation predates workspace identity, step 4 reports exit 2 and the panel shows `workspaceRequired`: open the setup wizard, select an absolute empty directory (not the state directory, a DSH home or profile, the checkout, or a project workspace), and save. The host registers the titled DSH workspace and creates a new master Session; the old one stays archived and readable, and the main conversation does not continue. A workspace selected again after switching away is unarchived and resumes its own master Session. Then repeat step 4 until it exits 0.

- **The host starts paused at `workspaceRequired`**: this is the fail-closed state, not a broken upgrade. Select the workspace in the wizard or under **Execution → Settings**; until then nothing polls, no Executor starts and no master Session exists. An invalid path reports `workspaceInvalid`, `workspaceNotEmpty`, `workspaceNotWritable` or `workspaceUnsafe` with the reason, and nothing is saved.
- **Choosing the workspace**: it is the directory the main Session works in, not the state directory. It must be absolute, empty or carry the `.dsh-superagent-workspace` marker, and must not overlap the state directory and its `work/`, the DSH home and profile, the source checkout, or a registered project workspace. The tool sets it owner-only.
