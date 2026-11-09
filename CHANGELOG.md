# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). While it is a research prototype, `0.x` versions may change
the settings schema and the state database; the upgrade steps in `docs/006-deployment.md` say how to migrate.

## [Unreleased]

### Added

- Manual run and delete for installation- and project-scope automation tasks: `automation_run` asks the Host's `schedule`
  service to deliver one run now without moving the scheduled occurrence and reports a pending execution as a conflict;
  `automation_delete` removes the Host task, the record and its whole delivery history on an explicit human request. Both
  are available from the Automations page (`Run now`, and `Delete` behind a confirmation dialog), through
  `POST /orchestrator/api/automations/:id/run` and `DELETE /orchestrator/api/automations/:id`, and in the main Session's
  tool list (six automation tools). A Host refusal to run or delete keeps the record and is reported; deleting an already
  missing Host task is fine.

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
