# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). While it is a research prototype, `0.x` versions may change
the settings schema and the state database; the upgrade steps in `docs/006-deployment.md` say how to migrate.

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
