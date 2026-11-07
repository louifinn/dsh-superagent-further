# 009 Roadmap

This document turns the prototype into something a team can use every day. It records where the code stands after its first real runs, what must happen before an installation can be left running unattended, and in which order to do the rest. It builds on [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md); decisions recorded here supersede their open questions when they disagree.

## Where it stands

- The bundle runs natively on Windows 11, both inside the daily DeepSeek Harness application and through `scripts\dsh-superagent.cmd`. Linux is verified in WSL and covered by CI; macOS is covered by CI only.
- Two real Tickets ran end to end. A GitHub Issue mention produced PR #3 (branch `agent/add-agent-test-file-d7efd3d9a996`, commit `03a671f`, merged as `18969c9`); a Feishu `@DSH` message produced PR #4 (branch `agent/add-feishu-test-1d5fe7ab22c4`, commit `ae2f409`, merged as `67973d4`). Both were merged by the operator, and both Tickets ended `merged`.
- `pnpm check` is green: 1218 passed and 5 skipped on Windows, 1208 passed and 12 skipped on Linux. The process-script and Feishu failures found by the first real Linux run are fixed. Later work brings the suite to 1273 passed and 5 skipped (1278) on Windows, and every push is checked on all six platform and Node combinations.
- `.github/workflows/check.yml` is committed but has never run: the repository has no remote yet.
- The installation runs inside the daily desktop profile. Two hosts cannot share one state directory, so the in-application instance and the service script are currently exclusive by hand, not by design.
- Accounts, Policy, the worker environment and the state database are provisioned: repository `louifinn/Napkid-Derivate`, agent `louibot`, Feishu bot `DSH`. Credentials are broader than they should be, and one Feishu permission was missing until the operator granted it.

## Principles

- **Safety before reach.** The agent acts when asked or when a written rule allows it. Every new capability must state what it will not do.
- **Every failure visible.** A silent retry loop is a bug. Health, the outbox and the log must explain what is stuck and what the operator can do.
- **One clear path.** Prefer one supported way to install, host and upgrade over two half-supported ones. A second path is a documented exception with a test.
- **Prove it on a real run.** Mocked tests are necessary, not sufficient: each milestone ends with the real Sources, the real CLIs and the real repository.

## P0 — make the installation safe to keep running

The Sprint 1 scope. Everything here blocks leaving the agent unattended.

| # | Item | Why now | Done when |
| - | ---- | ------- | --------- |
| 1 | Credential convergence | The agent token is a classic PAT with `admin:org` and `delete_repo`; the Feishu app secret sits in a plain `.env`. One leak is a whole-account loss. | Narrowing the credentials is the operator's call; on 2026-11-07 the operator chose to keep the current classic token and Feishu secret. The installation side is done: `.env` is gitignored and a section in 006 says where each secret lives and how to rotate it. |
| 2 | Remote and CI | The workflow exists but nothing has ever run it, so platform regressions are invisible. | `origin` is `louifinn/dsh-superagent-further`, `main` is pushed, and `check.yml` is green on all six platform and Node combinations. Any CI-only failure is fixed, not skipped. |
| 3 | One host at a time | Two hosts sharing a state directory collide on the file lock, and an in-application host applies the worker environment to every Session in that app. | Starting the service while the application hosts the orchestrator (or the reverse) fails with a message naming the other host, the lock owner and the one command that switches; 006 documents the switch and the environment consequence; the panel shows the same explanation. |
| 4 | Version alignment and self-check | The guide pinned a DSH version older than the one the machine runs, and an install has no single command that proves it works. | 006 pins the version this fork is tested against (`0.2.2-rc.1`); `scripts/verify-install` checks the DSH version, that the plugin is active, that `/orchestrator/api/state` answers ready, who holds the state lock and whether the panel token was issued; the script passes in both host modes. |

## P1 — stability and day-to-day ergonomics

| # | Item | Why | Done when |
| - | ---- | --- | --------- |
| 5 | Test stability under load | One loaded run produced six failures that never reproduced alone. | The cause is identified and fixed, or the affected specs are isolated; ten consecutive full runs are green, including one run next to a concurrent WSL suite. |
| 6 | Upgrade and migration | State survives upgrades but its schema has no migration step, and a DSH upgrade can break a pinned install. | `stateDir` migration from an old database is tested; 006 describes stop, update, build, start and verify with rollback; `pnpm check` covers the migration. |
| 7 | Observability | Health answers "ready" or "error" with one sentence. Operators need the trend. | Health reports the last failure and the next retry for each Source, outbox retry counts and ages, and Ticket age by stage; logs rotate and keep a bounded history. |
| 8 | Ticket loop ergonomics | A Ticket parked at `person` waits silently, and a stale PR or a failed worker has no visible retry path. | The panel lists waiting Tickets with age and the expected human action, a failed worker can be retried without a new trigger, stale PRs are marked, and a daily digest can be enabled. |

## P2 — capability and distribution

| # | Item | Why | Done when |
| - | ---- | --- | --------- |
| 9 | Trigger trust and prompt injection | 007 leaves the trusted Trigger fields open; Source text is data but nothing enforces that end to end. | The trusted fields are documented and tested, Source bodies cannot change role, tools or Policy, and regression tests cover injection attempts in issue bodies, comments and Feishu messages. |
| 10 | Several repositories or projects | One state directory serves one repository, which blocks a second project. | Either a Source-level repository list with per-repository worker directories, or a documented one-profile-per-project mode with a switching script and a test. |
| 11 | Release engineering | Installation depends on a development checkout and `link:`. | Semver and a CHANGELOG exist; a packed tarball installs with `dsh plugin --profile <name> add <file>`; the install steps in 006 use it; a release is tagged and CI-tested. |
| 12 | Feishu breadth | Only a listed group mention is proven; direct messages, unlisted chats, attachments and several chats are untested. | Each of those paths has a test and a documented behaviour, with history backfill paging and rate limits stated. |
| 13 | Platform and experience | macOS has no real run; the panel has not been seen rendered on a clean machine; the UI text is English-only. | A macOS checklist is executed once by hand; panel screenshots are part of the release check; the panel and the replies are reviewed for untranslated strings. |

## Sprint 2 checklist

The P1 scope.

- [x] Timeouts sized for a loaded machine: `vitest.config.ts` allows 30 s per test, and the abort test proves preemption
  through the child's own lifetime instead of a stopwatch. Ten consecutive full runs were green, one next to a concurrent
  WSL suite.
- [x] Upgrade and migration: `scripts/verify-install` reads the state database read-only and fails when it is newer than
  the checkout; 006 lists the upgrade steps and the rollback; `tests/migration.spec.ts` covers schema 10 to 12, including
  filling in the project of Tickets accepted before projects existed.
- [x] Observability: a polling Source reports when it next checks and, while it keeps failing, the consecutive count and
  the last error; the overview reports outbox waiting and failing counts, the oldest wait and the next attempt; the panel
  shows each Ticket's stage age; each host keeps a bounded log history.
- [x] Ticket loop ergonomics, except the daily digest: a waiting Ticket says which action it needs, and after a day it
  carries a warning with the number of days it has waited (for a Ticket awaiting review that is how long its pull request
  has waited); a failed or blocked worker is retried from the same row without a new trigger.
- [x] Daily digest: the Feishu Source posts one chat-level summary a day (digestChat, at digestHour local) of the
  Tickets that wait for a person, what each needs, how long it has waited, and how many are working; a quiet day still
  says nothing waits, a failed send shows on the Source's digest health entry and retries within the hour, and a
  restart does not send it twice. Live run on 2026-11-07 posted the digest to the "Agents" group as the bot DSH.

## Sprint 3 checklist

The P2 scope, in the order this session takes it.

- [x] Trigger trust and prompt injection: 007 documents which Trigger fields are trusted and which are not, the
  `runtime/admission`, `runtime/work` and `skill/github` parts state the untrusted-data rule, and `tests/trust.spec.ts`
  pins the gates down: a body that claims to be an explicit request, a human, or an administrator changes no decision,
  and no prompt in either role contains it verbatim.
- [x] Several repositories or projects: one profile per project (its own state directory, Sources and panel port),
  documented in 006, with `scripts/switch-project` stopping the service-hosted other projects before it starts the named
  one and a test (`tests/switch-project.spec.ts`) covering the switch, the refusals and the port it cannot know; verified
  live with two profiles on this machine.
- [x] Release engineering: 0.2.0 with a CHANGELOG in Keep a Changelog form; pnpm pack produces a tarball that installs
  with dsh plugin --profile <name> add "file:<tarball>" (verified on this machine, no checkout needed); 006 documented
  both install forms; .github/workflows/release.yml runs the checks on a `v*` tag, verifies the tarball contents and
  creates the GitHub release with it.
- [x] Feishu breadth: direct messages (their own row and `direct_messages_not_allowed`), unlisted chats (`otherChats`
  `@ only` as the `other` row), several listed chats at once, and attachments (an image key is readable by the
  assessment, a file key is not downloaded) each have a test; 006 now states what the Source receives, how history
  backfill pages and keeps a cursor on failure, and how Feishu rate-limit and permission errors surface on `history`.
- [x] Platform and experience: `.github/workflows/smoke.yml` starts a real host on macOS on every push (profile,
  start, panel sign-in, orchestrator API, `verify-install` exit 2, stop) with `.github/scripts/smoke.sh`; the untranslated
  strings pass is a test (`tests/locales.spec.ts`: only names and placeholders may stay in English); the panel screenshots
  for the 0.2.0 build are committed in 005 and attached to the v0.2.0 release (taken with Playwright's Chromium, since
  the system Chrome cannot start headless here); 006 keeps the visible-rendering and real-account steps for a release.
  strings.
## Sprint 4 checklist

One installation, several projects. Sprint 3's "several repositories" item used one profile per project; the management
surface now replaces that workaround with a project list inside the Execution settings.

- [x] Register projects: each has an ID, a name, an absolute local workspace, an `owner/name` remote repository and an
  optional base branch; the panel edits them in Execution, and a tool-originated save cannot change them
  (`tests/projects.spec.ts`, `tests/settings.spec.ts`).
- [x] Sources poll every project: the GitHub Source checks its own repository and every registered project's repository in
  one round, accepted notifications are filtered to those repositories, each repository keeps its own streams,
  default-branch CI and read positions, and an Issue or PR from another project's repository gets a Thread id qualified as
  `github:<owner>/<name>#<ref>` (the deployment's repository keeps the legacy numeric ids), so equal numbers in two
  repositories cannot collide (`tests/sources.spec.ts`).
- [x] Tickets belong to a project: a Trigger's repository selects the registered project, the Ticket records it, the
  Executor creates the checkout from that project's local clone (`git worktree add -b agent/<name>` under
  `stateDir/work/<project>/<name>` unless a prepare command is configured), and the worker environment names the project,
  workspace and repository (`DSH_SUPERAGENT_PROJECT`, `DSH_SUPERAGENT_PROJECT_WORKSPACE`, `DSH_SUPERAGENT_GITHUB_REPOSITORY`).
- [x] The panel and the digest show the project: the overview filters waiting Tickets by project and every Ticket line
  names it; the Triggers list filters Threads by the project their repository names and shows it on the row; the daily
  digest groups waiting Tickets under their project names (Tickets without one last). A schema 11 database fills in the
  project of Tickets accepted before projects existed (`tests/migration.spec.ts`, `tests/views.spec.ts`).
- [x] Feishu routing: one group manages all projects. A Feishu message names no repository, so the main Session's card
  lists the registered projects and the acceptance may name one (the message may name a project id itself); the Executor
  refuses an unknown project and refuses one that differs from a GitHub Trigger's own repository, and the Ticket then
  checks out in that project's workspace (`tests/runtime.spec.ts`).
## Sprint 5 checklist

The project layer is designed in `docs/010-project-orchestrator.md`. This is the implementation order; each item ends with tests, `pnpm check`, CI green on all six combinations, and a live run on this machine.

- [ ] P1 Foundation: Lead agent preset and prompt section, `LeadMessages` records with idempotent delivery, the `Sessions`
  Lead branch (ensure, decoration, disposal, reserved ids), recovery scaffolding, and project-aware interfaces — no
  entry-point change. (Built: preset, prompt, records, schema 13 and the Session branch; the live round-trip follows P2.)
- [ ] P2 Execution path: an executor runs as a Lead subagent under `executor.orchestration = 'lead'`, reports settle through
  the Lead, interrupt and stop work, adoption after a restart, per-project concurrency.
- [ ] P3 Entry points and panel: the Orchestrator dispatches accepted Tickets to the Lead, notices and replies route through
  it, the panel shows the Lead row and the settings, docs 001/003/004/006/007 are updated, and the default flips.
- [ ] P4 Cleanup: remove the root-worker path, simplify Sessions/DshExecutor/panel links, and decide the deferred
  one-Ticket-to-many-executors question.

## Sprint 1 checklist

- [x] Credentials stay as the operator decided on 2026-11-07 (classic `louibot` token, current Feishu app secret); 006
  records where each secret lives and how to rotate it.
- [x] `origin` added, `main` pushed, `check.yml` green on Linux, macOS and Windows with Node 22 and 24.
- [x] One-host switching documented and enforced by a clear failure message from both hosts.
- [x] 006 pins the tested DSH version, states that a service can also pin its own launcher (`DSH_SUPERAGENT_DSH`, 006 "A pinned DSH installation"); `scripts/verify-install` exists and passes in application mode and in service mode.
- [x] `pnpm check` green on Windows, and both real end-to-end paths still run after the changes.

## Open questions

- Do changes land on the fork only, or are they offered upstream as a pull request once CI runs?
- Is the operator's OS account sufficient isolation for a worker, or should 006 require a dedicated OS user by default?
- Should a second host be refused outright, or allowed with an explicit `--force` that takes over the lock?
- Which actions may end a Ticket without a person: opening a PR is one, merging is not. Should that list be configurable per Source?

## Non-goals

- Hosting several tenants, or serving more than one operator account.
- Forges other than GitHub, and chat products other than Feishu.
- Running the service as a Windows service or a system daemon.
- A visual redesign of the panel.

