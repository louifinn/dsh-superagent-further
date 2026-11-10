# 013 Operations runbook

An installed Host runs unattended for weeks. This runbook covers the checks an operator runs, what the panel shows,
where the state lives, and how to take a consistent backup or recover from a stalled process. It assumes the
deployment commands in [006 Deployment](006-deployment.md) and the data model in [007 Architecture](007-architecture.md).

## Daily checks

1. Open the panel and the Overview tab. It gathers the work waiting for a person: open Requests, escalations the
   Orchestrator must decide, automations whose Host task ended or reported an error, and the Leads and Executors per
   project.
2. Open the Logs tab, filter to `warn` and `error`, and read the scopes (`host`, `github`, `feishu`, `executor`).
   A Source that fails three polls in a row reports an error entry; a single failed poll stays behind `warn`.
3. Read the artifact log from the current start when a panel entry is not enough:
   `.artifacts/dsh-superagent-further-<profile>-<time>.log` under the workspace that started the Host.
4. Run `node scripts/verify-install --state-dir <dir>`; it prints the schema version, the enabled blocks and the
   Source setup problems, and exits non-zero while setup is incomplete.

## State and backups

- The state database is `state.sqlite` in the profile's state directory (the panel's setup page prints the path). It
  runs in WAL mode; never copy it by hand while the Host is writing.
- Take a consistent archive with `node scripts/archive-state.mjs --state-dir <dir> [--keep 5] [--out <dir>]`. It uses
  SQLite's `VACUUM INTO` under the database's own lock, writes `state-<UTC timestamp>.sqlite` into `<stateDir>/archive`
  and prunes the oldest archives beyond `--keep`. Run it before an upgrade or a manual repair.
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

## Upgrade

1. `node scripts/archive-state.mjs`; 2. pull the release tarball; 3. `pnpm install --frozen-lockfile && pnpm build`;
4. `node scripts/verify-install`; 5. reload the plugin; 6. confirm Overview and Logs are clean.
