# 009 Roadmap

This document turns the prototype into something a team can use every day. It records where the code stands after its first real runs, what must happen before an installation can be left running unattended, and in which order to do the rest. It builds on [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md); decisions recorded here supersede their open questions when they disagree.

## Where it stands

- The bundle runs natively on Windows 11, both inside the daily DeepSeek Harness application and through `scripts\dsh-superagent.cmd`. Linux is verified in WSL and covered by CI; macOS is covered by CI only.
- Two real Tickets ran end to end. A GitHub Issue mention produced PR #3 (branch `agent/add-agent-test-file-d7efd3d9a996`, commit `03a671f`, merged as `18969c9`); a Feishu `@DSH` message produced PR #4 (branch `agent/add-feishu-test-1d5fe7ab22c4`, commit `ae2f409`, merged as `67973d4`). Both were merged by the operator, and both Tickets ended `merged`.
- `pnpm check` is green: 1335 passed and 5 skipped (1340) on Windows after the Language setting (search, project filter, order, paging) and the localized, expanded proactive rules; Linux is green too, the process-script and Feishu failures found by the first real Linux run are fixed, and every push is checked on all six platform and Node combinations.
- `.github/workflows/check.yml` runs on every push to `main` and is green on all six platform and Node combinations; `smoke.yml` starts a real host on macOS.
- The installation runs inside the daily desktop profile. Two hosts cannot share one state directory, so the in-application instance and the service script are currently exclusive by hand, not by design.
- Multi-project work is live: registered projects are polled, each Ticket runs in its own project's worktree under a project Lead (schema 15 ends the Requests of old Tickets), and a cross-project Request (90df28d6…) produced two Tickets, two pull requests and one `done` state. The panel lists open Requests with their Tickets and the digest names each Request in flight.
- A memory layer outlives Sessions: the main Session and each project Lead can write, search and forget memories (`memory_write`, `memory_search`, `memory_forget`), a runtime-context snapshot carries pinned and recent memories (appended after the cached history, so a write does not rewrite the system prompt), ended Tickets and Requests are remembered deterministically, and the panel's **Memory** page switches injection and automatic writing on or off, edits the limits live, and lists the stored memories as searchable, orderable cards that expand to every stored field and can be pinned or forgotten (schema 16).
- The operator's default language is a language settings block (Settings → Language): free text, panel-only, revisioned with the other blocks, and carried to every decorated Session in the runtime-context snapshot, so a save applies to the next model request without a restart; the prompts say a Feishu or GitHub reply follows the message it answers and repository artifacts keep the repository's language.
- The proactive rules are Chinese named and worded: ten categories cover copy, visual, defect, feature, docs/config/scripts, tests and CI, refactor/performance, research and reports, review, and read-only investigation Q&A. An existing installation keeps its operator edits, while an untouched English `copy`/`visual` pair is localized when the settings are read. A review or read-only request can finish ready with its findings and evidence, without a file change, branch or pull request.
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

- [x] P1 Foundation: Lead agent preset and prompt section, `LeadMessages` records with idempotent delivery, the `Sessions`
  Lead branch (ensure, decoration, disposal, reserved ids), recovery scaffolding, and project-aware interfaces — no
  entry-point change. (Built: preset, prompt, records, schema 13, the Session branch, and the live Lead round-trip in P2.)
- [x] P2 Execution path: an executor runs as a Lead subagent for a Project Ticket, reports settle through
  the Lead, interrupt and stop work, adoption after a restart, per-project concurrency. (Landed: the
  activation request and tracking, the Lead-hosted launch path, disposal on stop and shutdown, Lead-steered input
  delivery across a restart, the merged-PR end, and the project-aware `WorkerSlots` (per-project `projectWorkers` beside the global `maxWorkers`); the host-level fake-subagent test and the recovery-adoption test pass.)
- [x] P3 Entry points and panel: the Orchestrator dispatches accepted Tickets to the Lead (the panel Lead row landed, with its payload and Project Leads section, a Lead Session now carries the read-only `lead_status` tool, and a lead-mode launch records its dispatch as a delivered assignment message), input and status requests reach a Lead-hosted child through its Lead, and both real entry points are proven end to end through a Lead (GitHub Issue #9 → PR #10 merged, Feishu message → PR #11 merged, each with the Lead visible and the executor a hidden child); docs 001/003/004/006/007 are updated.
- [x] P4 Cleanup: the `executor.orchestration` switch is removed; a Project Ticket always runs under its
  Lead, an acceptance no registered project can own is refused with a pointer to **Execution → Projects**
  (the operator's decision: one path, no implicit fallback). (Landed: the Lead-only execution path, the
  host test harness migrated to Lead-hosted executors, `tests/model-surface.spec.ts` driving the Lead
  harness, and onboarding that requires a project — the bootstrap root path is gone; CI green on `1e92d5a`.)

## Sprint 6 checklist

The Request bundle is designed in `docs/010-project-orchestrator.md` (P5, approved 2026-11-08). Each item ends with tests, `pnpm check`, CI green on all six combinations, and a live run on this machine. It runs after P4.

- [x] Request records: schema 14 adds a Request (the accepted human ask) with its Mandate, Decision, Channels and Tickets; a Ticket gains `requestId` and `after` edges; the migration backfills one Request per existing Ticket so history keeps its identity. Covered by `tests/migration.spec.ts` and `tests/core-engine.spec.ts`.
- [x] Automatic split at acceptance: one accept creates one Request and 1..N ordinary Tickets, one per delivery unit, chosen by the main Session from the request text and the registered projects; a Feishu acceptance may name several projects; each Ticket still has one project, checkout, Lead and pull request. The accept carries `deliverables` (`project`, `title`, `after` indexes) from the assessment tool or the route tool; `Tickets.create` writes one Ticket per unit (the first keeps the Decision ticket id, later ones `key('ticket', decisionId, index)`) and only the first carries the acknowledgement.
- [x] Dependency dispatch: the Orchestrator dispatches a Ticket to its project's Lead only once the Tickets it waits on have ended; serial and parallel both fall out of `after`; a failed prerequisite stops the Tickets behind it and asks one question. `dispatchRequest` starts ready Tickets from `Tickets.create` and after every `ticket.ended`, and ends the Request `done`/`partial`/`stopped`; `tests/core-engine.spec.ts` covers the split, the serial start and both Request endings.
- [x] One acknowledgement, one result, one done: the acknowledgement is sent once at acceptance; the Request ends when all its Tickets end (`done`/`partial`/`stopped`) and `src/app/request-notices.ts` sends one result notice per non-GitHub Channel listing every Ticket and its pull request. The overview lists each open Request with its Tickets behind a toggle (a Ticket chip opens it), and the daily digest names each Request in flight with its Ticket count; `tests/panel-overview.spec.tsx`, `tests/views.spec.ts` and `tests/feishu-digest.spec.ts` cover them.
- [x] Live proof: the operator's GitHub request `90df28d6…` spanned `louifinn/project-check` and `louifinn/Napkid-Derivate` and produced two Tickets (`f1c13ebd…` project-check, `a2b31e18…` derivate), PR #18 and PR #12, both merged at 00:09Z on 2026-11-08, with the Request ended `done` at 00:10:25Z; a Feishu request naming one project still works unchanged.
## Sprint 7 checklist

The memory layer answers the real problem found in long Sessions: the conversation is compressed, but what was learned and decided should not have to be rediscovered. It ends with tests, `pnpm check`, CI green on all six combinations, and a live run on this machine. Scope decision (2026-11-08): the installation-wide scope and an ended Request's summary belong to the Orchestrator; a project Lead writes and reads only its own project, so a Request summary never reaches a Lead.

- [x] Store: schema 16 `memory` table with scopes (installation, project, ticket), kinds (fact, decision, preference, lesson), tags, source, pinning, expiry and content deduplication; `src/memory.ts` and `src/app/memories.ts`, covered by `tests/memories.spec.ts`.
- [x] Tools: `memory_write`, `memory_search` (keyword in text or tags, scoped, pinned first) and `memory_forget` for the main Session (whole installation) and each project Lead (its own project only); `src/app/tools/memory.ts`, covered by `tests/memories.spec.ts` and `tests/leads.spec.ts`.
- [x] Snapshot: the pinned and most recent memories travel in the runtime-context snapshot (rebuilt per model request within a 1,200-character budget) instead of the system prompt, so a write does not rewrite the prompt; covered by `tests/memories.spec.ts` and `tests/runtime.spec.ts`.
- [x] Deterministic recall of work: ending a Ticket or a Request stores a memory derived from the record, with no model call; covered by `tests/runtime.spec.ts`.
- [x] Panel: a Memory page with the master switch, the injection and automatic-write switches (saving on click, effective on the next model request without a restart), the snapshot limits and retention, and the stored memories as expandable cards: a keyword box searches text and tags, the order combo box switches newest/oldest/kind/project with pinned rows first, a project combo box filters the list, the rows are paged twenty at a time with the visible range under them, each card pins or unpins and forgets on the spot, and expanding shows the whole text, tags, source, expiry and id. The behavior is the `memory` settings block, so every change is revisioned and appears in the tab's history; covered by `tests/memories.spec.ts`, `tests/settings.spec.ts`, `tests/http.spec.ts` and `tests/panel-memory.spec.tsx`.
- [x] Scope: a project Lead's memory tools and snapshot are limited to its project; the installation-wide scope, including an ended Request's summary, is Orchestrator-only (decided 2026-11-08, covered by `tests/memories.spec.ts` and `tests/leads.spec.ts`).

## Sprint 8 checklist

- [x] Settings block: the `language` block is free text with example hints, panel-only (a tool-originated change is refused), revisioned like the other blocks and listed in the tab's history; covered by `tests/settings.spec.ts` and `tests/panel-settings.spec.tsx`.
- [x] Runtime context: every decorated Session (Orchestrator, project Lead, worker) registers the `dsh-superagent-language` runtime-context contribution, whose text is rebuilt from the settings for each model request, so a save applies without a restart or a plugin reload; covered by `tests/runtime.spec.ts`.
- [x] Prompt rules: the Orchestrator, Lead and worker prompts and the replies guide describe the default language, the reply-follows-the-message rule for Feishu and GitHub, and that pull request bodies, commit messages, code comments and files keep the repository's language; structured fields are unchanged; covered by `tests/prompts.spec.ts`.
- [x] Live proof: with the default language set to `English (US)` on the running host, the operator wrote a Chinese request (Issue #23 in `louifinn/project-check`); the Orchestrator acknowledgement and the worker's PR-ready reply were both Chinese, while the worker's report summary and the PR body/commit stayed English, and the Ticket ended `merged`; the default was then restored to `简体中文` through the same block (`context_delivery: "injected"`, no restart).

## Sprint 9 checklist

Localized proactive rules, so the operator, the admission decisions and the panel all use the same Chinese wording.

- [x] Built-in rules: ten categories (`copy` 文案纠错, `visual` 视觉修正, `bugfix` 缺陷修复, `feature` 功能实现, `docs` 文档/配置/脚本, `tests` 测试与 CI 修复, `refactor` 重构/性能, `research` 调研与报告, `review` 审查（全仓或局部变更）, `qa` 只读调研问答) have stable ids, Chinese names and instructions, and one acceptance boundary: clear intent plus an objectively checkable goal, scope pinned with one in-Ticket question when details are open, and no scope expansion. Review and read-only work ends with a report, not a pull request. The two original rules keep their enabled state; the eight new categories ship disabled and are enabled per deployment in the panel. Covered by `tests/policy.spec.ts`, `tests/prompts.spec.ts` and `tests/runtime.spec.ts`.
- [x] Migration of installed rules: an untouched English `copy`/`visual` pair becomes the whole Chinese set; only individually untouched built-ins are translated, and operator edits, disabled states, custom rules and an empty list are preserved; the upgrade happens when settings are read, with no schema bump. `upgradeRules` in `src/policy.ts`, covered by `tests/policy.spec.ts` and `tests/migration.spec.ts`.
- [x] Review and read-only path: the worker and admission prompts let a review, research or read-only answer finish ready with its findings and evidence, and name the requested deliverable as the assessment's implementation request; the Ticket completes with a report and the main Session can deliver it as the result. Covered by `tests/prompts.spec.ts` and `tests/runtime.spec.ts`.
- [x] Panel: the Eval rule editor and the Policy history render the Chinese rule names, instructions and change wording unchanged. Covered by `tests/panel-eval.spec.tsx`.
- [ ] Deferred categories: 更改 SuperAgent 配置 needs a controlled way to write and roll back deployment settings, and 项目 dsh 自动化任务 needs the M4 capability survey to settle its safety boundary. They are documented in [002 Authorization](002-authorization.md) but are not active rules.

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

