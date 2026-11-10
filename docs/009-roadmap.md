# 009 Roadmap

This document turns the prototype into something a team can use every day. It records where the code stands after its first real runs, what must happen before an installation can be left running unattended, and in which order to do the rest. It builds on [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md); decisions recorded here supersede their open questions when they disagree.

## Where it stands

- The bundle runs natively on Windows 11, both inside the daily DeepSeek Harness application and through `scripts\dsh-superagent-further.cmd`. Linux is verified in WSL and covered by CI; macOS is covered by CI only.
- Two real Tickets ran end to end. A GitHub Issue mention produced PR #3 (branch `agent/add-agent-test-file-d7efd3d9a996`, commit `03a671f`, merged as `18969c9`); a Feishu `@DSH` message produced PR #4 (branch `agent/add-feishu-test-1d5fe7ab22c4`, commit `ae2f409`, merged as `67973d4`). Both were merged by the operator, and both Tickets ended `merged`.
- `pnpm check` is green: 1493 passed and 5 skipped (1498) on Windows after the Memory page (search, project filter, order, paging), the Language setting, the sixteen all-enabled localized proactive rules (including dependency upgrades, review-feedback fixes, design decisions and Issue/PR triage), the GitHub label capability for triage, the Feishu file delivery for a remote manager reviewing a design document, the derived primary repository, the setup wizard, the rename migration test, the agent-safe configuration tiers and proposals (schema 18), per-block restore (schema 18), installation- and project-scope automation tasks with manual run and delete (schema 19), the bounded delivery history with panel-only notices (schema 20), the GitHub read-path repair that stops a skipped listing from staying hidden behind a saved ETag, Trigger IDs scoped by repository so equal Issue and PR numbers in different projects stay separate, the Ticket deliverable contract (schema 22) that ends answer work with its report and requires a followed pull request for change work, the Lead-raised project request from a project automation delivery (docs/012 D11), the installation-level self-bootstrap request from an installation automation delivery (docs/012 D12), and the Lead escalation to the Orchestrator for work outside its project (docs/012 D13); Linux is green too, the process-script and Feishu failures found by the first real Linux run are fixed, and every push is checked on all six platform and Node combinations.
- `.github/workflows/check.yml` runs on every push to `main` and is green on all six platform and Node combinations; `smoke.yml` starts a real host on macOS.
- The installation runs inside the daily desktop profile. Two hosts cannot share one state directory, so the in-application instance and the service script are currently exclusive by hand, not by design.
- Multi-project work is live: registered projects are polled, each Ticket runs in its own project's worktree under a project Lead (schema 15 ends the Requests of old Tickets), and a cross-project Request (90df28d6…) produced two Tickets, two pull requests and one `done` state. The panel lists open Requests with their Tickets and the digest names each Request in flight.
- Project-level work is live (schema 21): a worker raises a durable `project_request` when a decision, a new deliverable or another project's work blocks its Ticket, and its project Lead must answer with a non-empty reply before the request can be disposed. An accepted work request creates the ordinary Request and its staged Tickets under a Lead Mandate confined to that project; an architecture request produces a design Ticket and needs a person's recorded approval on the root Thread before the implementation Request exists; an unanswered request is reminded twice, then marked as needing attention. A root request is closed with one aggregate report on the channel the chain started from, and an independent DSH Session can submit work through the `session` Source and always receives an answer; a project automation delivery may raise and decide one project request, an installation automation delivery may create an installation Request from the main Session, and a Lead may escalate work outside its project for the Orchestrator to decide (`docs/012-project-requests.md`).
- The deployment has one primary repository, derived from the first registered project rather than configured on the GitHub Source: schema 17 removes the Source's own `repository` setting from the stored settings and every saved revision, setup verifies push access to the first project's repository, and unqualified `github:<n>` Thread ids belong to it while every other project's ids are qualified `owner/name#<ref>`.
- A memory layer outlives Sessions: the main Session and each project Lead can write, search and forget memories (`memory_write`, `memory_search`, `memory_forget`), a runtime-context snapshot carries pinned and recent memories (appended after the cached history, so a write does not rewrite the system prompt), ended Tickets and Requests are remembered deterministically, and the panel's **Memory** page switches injection and automatic writing on or off, edits the limits live, and lists the stored memories as searchable, orderable cards that expand to every stored field and can be pinned or forgotten (schema 16).
- The operator's default language is a language settings block (Settings → Language): free text, panel-only, revisioned with the other blocks, and carried to every decorated Session in the runtime-context snapshot, so a save applies to the next model request without a restart; the prompts say a Feishu or GitHub reply follows the message it answers and repository artifacts keep the repository's language.
- Agent-safe configuration is complete through Part A P3 (schema 18): settings paths are tiered A/B/C, a tool may save tier-A fields with the person's reason, a tier-B change becomes a stored `settings_proposal` that the panel lists with a per-field diff and applies or rejects, and the panel can restore any retained revision of a block. One proposal per block is pending, it expires after seven days, and only the panel's Apply calls the normal save path, which records the proposal, actor and reason in the history.
- The proactive rules are Chinese named and worded: sixteen categories cover copy, visual, defect, feature, docs/config/scripts, tests and CI, refactor/performance, research and reports, review, read-only investigation Q&A, SuperAgent settings changes, project automation tasks, dependency and toolchain upgrades, review-feedback fixes, design/architecture decisions, and Issue/PR triage; every category ships enabled. An existing installation keeps its operator edits, while an untouched English `copy`/`visual` pair, an untouched 0.3.0 ten-rule set, an untouched twelve-category set or an untouched fifteen-category set is replaced by the all-enabled sixteen-rule set when the settings are read. A review, read-only, design request or triage can finish ready with its findings, evidence, decision document or label suggestion, without a file change, branch or pull request.
- Accounts, Policy, the worker environment and the state database are provisioned: repository `louifinn/Napkid-Derivate`, agent `louibot`, Feishu bot `DSH`. Credentials are broader than they should be, and one Feishu permission was missing until the operator granted it.
- Every registration identity is `dsh-superagent-further` since 0.3.0: package and bundle name, component and preset ids, skill names and directories, web-client bundle id and locale namespace. `scripts/migrate-rename.mjs` moves an existing profile and its Session headers to the new ids while keeping the `stateDir`, the database, the `DSH_SUPERAGENT_*` variables, the Source kinds and the stored Thread/Ticket ids; 006 records the steps.

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
- [x] Runtime context: every decorated Session (Orchestrator, project Lead, worker) registers the `dsh-superagent-further-language` runtime-context contribution, whose text is rebuilt from the settings for each model request, so a save applies without a restart or a plugin reload; covered by `tests/runtime.spec.ts`.
- [x] Prompt rules: the Orchestrator, Lead and worker prompts and the replies guide describe the default language, the reply-follows-the-message rule for Feishu and GitHub, and that pull request bodies, commit messages, code comments and files keep the repository's language; structured fields are unchanged; covered by `tests/prompts.spec.ts`.
- [x] Live proof: with the default language set to `English (US)` on the running host, the operator wrote a Chinese request (Issue #23 in `louifinn/project-check`); the Orchestrator acknowledgement and the worker's PR-ready reply were both Chinese, while the worker's report summary and the PR body/commit stayed English, and the Ticket ended `merged`; the default was then restored to `简体中文` through the same block (`context_delivery: "injected"`, no restart).

## Sprint 9 checklist

Localized proactive rules, so the operator, the admission decisions and the panel all use the same Chinese wording.

- [x] Built-in rules: twelve categories (`copy` 文案纠错, `visual` 视觉修正, `bugfix` 缺陷修复, `feature` 功能实现, `docs` 文档/配置/脚本, `tests` 测试与 CI 修复, `refactor` 重构/性能, `research` 调研与报告, `review` 审查（全仓或局部变更）, `qa` 只读调研问答, `settings` 更改 SuperAgent 配置, `automation` 项目 dsh 自动化任务) have stable ids, Chinese names and instructions, and one acceptance boundary: clear intent plus an objectively checkable goal, scope pinned with one in-Ticket question when details are open, and no scope expansion. Review and read-only work ends with a report, not a pull request. All categories ship enabled; the operator can switch any of them off in the panel. Covered by `tests/policy.spec.ts`, `tests/prompts.spec.ts` and `tests/runtime.spec.ts`.
- [x] Migration of installed rules: an untouched English `copy`/`visual` pair becomes the whole Chinese set; only individually untouched built-ins are translated, and operator edits, disabled states, custom rules and an empty list are preserved; the upgrade happens when settings are read, with no schema bump. `upgradeRules` in `src/policy.ts`, covered by `tests/policy.spec.ts` and `tests/migration.spec.ts`.
- [x] Review and read-only path: the worker and admission prompts let a review, research or read-only answer finish ready with its findings and evidence, and name the requested deliverable as the assessment's implementation request; the Ticket completes with a report and the main Session can deliver it as the result. Covered by `tests/prompts.spec.ts` and `tests/runtime.spec.ts`.
- [x] Panel: the Eval rule editor and the Policy history render the Chinese rule names, instructions and change wording unchanged. Covered by `tests/panel-eval.spec.tsx`.
- [x] Deferred categories completed on 2026-11-09: 更改 SuperAgent 配置 uses the controlled settings proposal (proposal, panel approval, rollback, audit) and 项目 dsh 自动化任务 uses the automation tools (explicit human request, project report-only deliveries, run/delete). Both have their own Chinese rules, and the whole twelve-category set ships enabled. Documented in [002 Authorization](002-authorization.md) and the capabilities document.

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

## Sprint 10 checklist

The setup wizard is how a fresh install reaches its first Ticket without editing settings files. It ends with `pnpm check` green.

- [x] First-run state: `GET state` carries `wizard` `{firstRun, skipped}`, where `firstRun` holds while no project is registered and no `setup-wizard` record exists, and `PUT wizard` stores `{at, skipped}` in the Store's key-value area; covered by `tests/http.spec.ts`.
- [x] Wizard dialog: welcome, the first project with the Execution fields, the GitHub account check, the optional Feishu Source, the default language and a summary; every step can be skipped or revisited, each save writes its settings block with the current revision, and a restart says so; covered by `tests/panel-setup-wizard.spec.tsx`.
- [x] Entry and memory: the wizard opens by itself on a first run once per browser session, the header **Setup wizard** reopens it afterwards, and the server's record — not the browser — decides across sessions; covered by `tests/panel-setup-wizard.spec.tsx`.
- [x] Docs: [005 Panel](005-panel.md) describes the dialog, [006 Deployment](006-deployment.md) the first start, and [007 Architecture](007-architecture.md) lists both modules and the panel test.

## Sprint 11 checklist

The primary repository is derived instead of configured, so one project list is the only source of truth for the repository the unqualified Thread ids name. It ends with `pnpm check` green.

- [x] Retired setting: schema 17 removes the GitHub Source's own `repository` setting from the stored settings and every saved revision, and a Source started from an old configuration drops it; covered by `tests/migration.spec.ts` and `tests/sources.spec.ts`.
- [x] Derived primary repository: setup takes the first registered project's repository as the deployment's primary repository, checks push access to it, and asks again when the first project changes; covered by `tests/settings.spec.ts`.
- [x] Thread ids and polling: the primary repository keeps the plain `github:<n>` Thread id, every other project's ids are qualified `owner/name#<ref>`, and every registered project is polled; covered by `tests/sources.spec.ts`.
- [x] Panel: the Source card lists the watched repositories and marks the primary one, and has no repository field; covered by `tests/panel-source.spec.tsx`.
- [x] Docs: [001 Domain model](001-domain.md), [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md) describe the derived primary repository, and [005 Panel](005-panel.md) the Source card.

## Sprint 12 checklist

The bundle's registration identities now read `dsh-superagent-further`, and an existing installation can move to them without losing its state. It ends with `pnpm check` green on Windows and the migration exercised on a copy.

- [x] Rename: `package.json` and the bundle name, the main and watch component ids, the worker/router/lead preset ids and their display names, both Source component names, both skill directories and `SKILL.md` names, the web client's module id and locale namespace, the checked-in script names, and every README, SETUP, docs and example reference.
- [x] Migration: `scripts/migrate-rename.mjs` renames the profile's dependency and `dsh.profile.bundles` entry, rewrites the bundle rows in the profile's `cordis.patch.yml`, and rewrites the `agentPreset` in Session logs with `.pre-0.3.0.bak` copies; [006 Deployment](006-deployment.md) gives the steps, the required backups and the rollback path.
- [x] Preserved data and operator interfaces: the `stateDir` database and worktrees, `DSH_SUPERAGENT_*` variables and prepare commands, the `github` and `feishu` Source kinds, stored Thread/Ticket/Request ids, the persisted message source kind `dsh-superagent` and the GitHub comment marker, and the old worker-shim marker, which the host accepts and replaces on the next start.
- [x] No compatibility aliases in code: the old registration ids are not registered alongside the new ones; the only old literals left are stored wire formats, historical changelog entries and the prototype attribution.
- [x] Tests and docs: the suite's expectations, fixtures, service-script and bundle-patch checks follow the new ids; README counts, state schema and primary-repository wording, the panel's Memory and Language documentation, and the glossary's Gate/Admission split are current.

## Sprint 13 checklist

The approved capability proposal's Part A P1 lands agent-safe configuration without a schema change: the Agent may save only the fields that do not change authority, cost, environment or credentials, and every such save carries the operator's reason into the settings history. It ends with `pnpm check` green.

- [x] Field tiers: `fieldTier(block, path)` in `src/policy.ts` classifies each changed path as A (direct), B (needs the operator's confirmation) or C (panel only), following the table in `docs/011-capabilities.md`.
- [x] Tool limit: `orchestrator_settings_save` requires a `reason` (1–280 characters), saves only tier-A fields, refuses a B field with `approvalRequired` and a C field with its existing `panelOnly…` code, and writes nothing on a refusal; covered by `tests/settings.spec.ts`, `tests/tools.spec.ts` and `tests/runtime.spec.ts`.
- [x] Audit: a tool-origin save records the Session as `actor` and the person's `reason` on the settings revision, and the panel history shows both; covered by `tests/settings.spec.ts`.
- [x] Panel and API unchanged: `PUT settings/<block>` and `POST executor/pause` still save with origin `panel`, without a reason, and tier-A changes still apply hot; the schema stays 17 because no table was added; covered by `tests/http.spec.ts` and `tests/settings.spec.ts`.
- [x] Docs: `docs/011-capabilities.md` records the survey and this implementation status, [006 Deployment](006-deployment.md) gives the operator the tier table, and [007 Architecture](007-architecture.md) lists the changed modules and tests. The proposal's P2 proposals remain unimplemented at this point (they land in Sprint 14), and P3 restore is still unimplemented; both are recorded there.

## Sprint 14 checklist

The approved capability proposal's Part A P2 lands the proposal record and the panel confirmation surface (schema 18): a tool proposes a tier-B change with the operator's reason, and only the panel can apply or reject it.

- [x] Proposal record: schema 18 adds `settings_proposal` (`id`, `block`, `base_revision`, `value`, `diff`, `reason`, `actor`, `status`, `created_at`, `expires_at`, `decided_at`, `decided_by`, `applied_revision`, `error`) with `Proposals` accessors in `src/app/store.ts` and `migrateTo18` in `src/app/migration.ts`; one pending proposal per block, seven-day expiry and supersede are enforced in `Settings.propose`.
- [x] Propose tool: `orchestrator_settings_propose` accepts only blocks whose change includes a tier-B path, requires the person's `reason` (1–280 characters), refuses tier-A-only and tier-C changes, and returns `{proposal_id, block, base_revision, expires_at, diff}`; `orchestrator_read settings/proposals` lists pending proposals with diffs. Covered by `tests/tools.spec.ts` and `tests/settings.spec.ts`.
- [x] HTTP and panel save path: `GET settings/proposals`, `POST settings/proposals/<id>/apply` and `POST settings/proposals/<id>/reject` sit behind `sameOrigin`; Apply re-checks the base revision and calls the normal panel save with the proposal's actor, reason and id, and a failed apply keeps the proposal pending with its error. Covered by `tests/http.spec.ts`, `tests/settings.spec.ts` and `tests/tools.spec.ts`.
- [x] Panel and history: the Settings page lists pending proposals with a per-field old → new diff, Apply/Reject buttons and a pending count; a history row names the proposal, actor and reason; zh/en strings are in `src/client/locales.ts`. Covered by `tests/panel-settings.spec.tsx`.
- [x] Migration and docs: a schema 17 database opens at 18 with an empty `settings_proposal` table; [006 Deployment](006-deployment.md), [007 Architecture](007-architecture.md) and `docs/011-capabilities.md` describe the flow. Covered by `tests/migration.spec.ts` and `tests/docs.spec.ts`.
- [x] `pnpm check` green, including the new proposal tests.

## Sprint 15 checklist

The approved capability proposal's Part B P1 lands installation-scope automation tasks (schema 19): the Host's schedule service owns the clock and delivery, while the plugin owns the record, the four main-Session tools, the delivery envelope and reconciliation. It ends with `pnpm check` green.

- [x] Record: schema 19 adds the `automation` table (`id`, `scope`, `project`, `host`, `target_session`, `title`, `instruction`, `rrule`, `dsh_task`, `dsh_updated_at`, `host_status`, `next_at`, `enabled`, `created_at`, `updated_at`, `revision`, `last_delivery_at`, `last_error`, `orphaned`, `audit`) with `AutomationRecords` accessors in `src/app/store.ts` and `migrateTo19` in `src/app/migration.ts`; schema 18 was already consumed by `settings_proposal`, so the automation table takes 19.
- [x] Tools: `automation_create`, `automation_list`, `automation_view` and `automation_edit` exist for the main Session only, are registered only when the Host `schedule` service exists, target the installation main Session, and at that point had no run or delete tool (Sprint 19 adds `automation_run` and `automation_delete`); titles are ≤120 characters, instructions ≤4000, at most 20 installation tasks, and `rrule` passes to the Host unchanged. Covered by `tests/automations.spec.ts`, `tests/tools.spec.ts` and `tests/runtime.spec.ts`.
- [x] Delivery: the stored prompt begins with `[AUTOMATION auto-… · installation]`, and the `dsh-superagent-further-automation` runtime-context contribution (order 320) tells the main Session how to read it and that it changes no settings, Policy or Sources. Covered by `tests/automations.spec.ts` and `tests/runtime.spec.ts`.
- [x] Failure handling: create writes the Host task first and compensates by deleting it when the row write fails; enable/disable maps to the Host `active` patch; an edit uses `expectedUpdatedAt` and reports a conflict instead of overwriting; startup reconciliation marks missing, ended, removed-project and drifted records without recreating or adopting a Host task. Covered by `tests/automations.spec.ts`.
- [x] Tests and docs: `tests/automations.spec.ts`, plus the runtime-context, tool-absence and schema-19 migration cases; [006 Deployment](006-deployment.md), [007 Architecture](007-architecture.md) and `docs/011-capabilities.md` describe the operator flow, the modules and the remaining P2/P3 work. Covered by `tests/docs.spec.ts`.
- [x] `pnpm check` green, including the new automation tests.

## Sprint 16 checklist

The approved capability proposal's Part A P3 lands per-block restore from a saved settings revision and the pending-proposal reminder, with no schema change. A restore goes through the panel save path and records the revision it read in the same settings history that serves as the audit; the panel is the only restore and approval surface, and no Feishu or other IM notification is sent. It ends with `pnpm check` green.

- [x] Restore service: `Settings.restore(block, revision, audit?)` reads the block's value from `Store.settingsVersion(revision)` and calls the ordinary `save(..., 'panel', { ...audit, restore: { block, from: revision } })`; the new revision and its `policyHistory` row record `restoredFrom`. A revision or block value that is not retained throws `SettingsRevisionNotFound` (404), and a restore whose value already matches throws `SettingsConflict` (409), so a successful restore always writes a new revision. Covered by `tests/settings.spec.ts`.
- [x] Guards: a restored setup field checks accounts and restarts exactly as a manual panel save; tier-C fields are allowed because the origin is panel; the tool origin cannot restore and the history is the only audit record. Covered by `tests/settings.spec.ts`.
- [x] HTTP: `POST settings/<block>/restore` with `{revision, reason?}` sits behind the same-origin check and returns the new block revision, `restarting` and `restoredFrom`; an invalid block or revision answers 400, an unknown source 404, an unretained revision 404 and a no-op 409. `src/app/api.ts` types the route. Covered by `tests/http.spec.ts`.
- [x] Panel: each history row for a listed block offers Restore after a confirmation naming the block and revision; after it the panel reloads settings and history, shows the restored-from revision, and hides Restore for the current row and for blocks it cannot save. The pending-proposal count is shown on every settings group, with no other reminder channel. Covered by `tests/panel-settings.spec.tsx`.
- [x] Tests and docs: restore round-trip, tier-C panel restore, setup-field restart, 404/409, the HTTP route, the panel confirmation and badge; [006 Deployment](006-deployment.md), [007 Architecture](007-architecture.md) and `docs/011-capabilities.md` describe the operator flow, the modules and the remaining Part B P2/P3 work. Covered by `tests/docs.spec.ts`.
- [x] `pnpm check` green, including the new restore and badge tests.

## Sprint 17 checklist

The approved capability proposal's Part B P2 lands project-scope automation tasks and the Automations panel page, with no schema change. A project task targets its registered project's Lead Session and is report-only by decision B-D2; the panel and the same-origin API share the service path, and a profile without the Host `schedule` service reports it rather than failing. It ends with `pnpm check` green.

- [x] Project scope: a row is `installation` (target the main Session) or `project` (target `lead-<projectId>`); creating a project task validates the registered project and calls `Sessions.ensureLead(project.id, project.workspace, `Lead · <name>`)` before the Host task, so the target exists; an unknown project is refused, and the 20-task/title/instruction limits cover both scopes. Covered by `tests/automations.spec.ts`.
- [x] Report-only: a project task's prompt begins `[AUTOMATION auto-… · project <projectId>]` and prefixes the instruction with the rule that the Lead inspects and reports only, does not modify the repository, Settings, Tickets or Policy, and states what the Orchestrator should do; installation tasks are unchanged, and the row records the scope without a second toggle. Covered by `tests/automations.spec.ts` and `tests/tools.spec.ts`.
- [x] Service and tools: `Automations` creates, lists, views and edits both scopes, keeps the Host-first compensation order, does not re-target an existing task, and reconciles removed projects, wrong Lead targets, missing/ended Host tasks and drift by the recorded project id; `automation_create/list/view/edit` accept an optional `project` and were the only four automation tools at that point. Covered by `tests/automations.spec.ts` and `tests/tools.spec.ts`.
- [x] HTTP and panel: `GET automations`, `POST automations` and `PUT automations/:id` sit behind the same-origin check with typed bodies and 400/404/409/503 outcomes; the new Automations page lists scope, project, human-readable schedule, enabled switch, created/last delivery and orphan warnings, creates a task from the registered projects, edits without re-target and shows the service-missing state, with no delete or run action then (Sprint 19 adds both). Covered by `tests/http.spec.ts` and `tests/panel-tasks.spec.tsx`.
- [x] Tests and docs: project Lead targets, unknown projects, the report-only envelope, list/view/edit, reconciliation, HTTP routes and the panel page; [006 Deployment](006-deployment.md), [007 Architecture](007-architecture.md) and `docs/011-capabilities.md` describe the operator flow, the modules and the remaining Part B P3 work. Covered by `tests/docs.spec.ts`.
- [x] `pnpm check` green, including the new automation and panel tests.

## Sprint 18 checklist

The approved capability proposal's Part B P3 adds per-task delivery history and panel-only notices for orphaned or failed automation tasks, on schema 20. Delivery stays at-least-once with missed occurrences collapsing to the latest, and the optional `automation_run` stays out of this sprint; the operator later approved run and delete, and Sprint 19 implements them.

- [x] Schema: `SCHEMA_VERSION` is 20; the Store creates `automation_delivery` (`id`, `automation`, `at`, `kind`, `scheduled_at`, `delivered_at`, `message_id`, `error`) and `migrateTo20` keeps its place in the sequence; `AutomationDeliveries` records, lists and deletes a task's rows, and `saveWithHistory` writes the record and its entries in one savepoint. Each task keeps its newest 50 rows. Covered by `tests/automations.spec.ts` and `tests/migration.spec.ts`.
- [x] Recording: startup reconciliation and the page's `refresh` record a `delivered`, `error` or `orphaned` transition at most once; `delivered` entries are backfilled from the Host `history` and the catalog's `lastDelivery`, deduplicated by the delivered time, and fall back to the catalog when the Host history cannot be read. `refresh` updates the observed delivery, next occurrence and status without bumping the record revision or writing an audit entry. Covered by `tests/automations.spec.ts`.
- [x] HTTP and panel: `GET automations` items carry `history` and the body carries `attention`; the Automations page shows an attention section with that count, the orphan or error reason on each row, and an expandable newest-first delivery history per task with Chinese and English locales, still with no run, delete or re-target action. Covered by `tests/http.spec.ts`, `tests/panel-tasks.spec.tsx` and `tests/locales.spec.ts`.
- [x] Notices: panel-only, per decision B-D5; no Feishu, GitHub or other IM message is sent for a delivery, failure or orphan, and the page states the at-least-once and missed-collapse behavior next to the history. Covered by `tests/panel-tasks.spec.tsx`.
- [x] Optional run (superseded): this sprint left `automation_run` and `automation_delete` out because no operator decision had approved them; the operator approved both later and Sprint 19 implements them (six tools, five routes). Covered by `tests/tools.spec.ts` and `tests/docs.spec.ts`.
- [x] Tests and docs: delivery recording and pruning, refresh, `GET automations` history and attention, the panel attention section, row reason and history, locales; [006 Deployment](006-deployment.md), [007 Architecture](007-architecture.md) and `docs/011-capabilities.md` describe the stored history, the notices and the run and delete actions added later in Sprint 19. Covered by `tests/docs.spec.ts`.
- [x] `pnpm check` green, including the new delivery-history, refresh, HTTP and panel tests.

## Sprint 19 checklist

The operator approved a manual run and a delete action for automation tasks on 2026-11-09, superseding the optional-run note above. Both work at installation and project scope, the panel remains the only management surface, no IM notice is sent, and no schema change is needed: deleting a record removes its delivery rows through the existing store cascade. It ends with `pnpm check` green.

- [x] Service: `Automations.run(id, actor)` asks the Host to deliver one run now with `schedule.run({id})` without consuming or moving the scheduled occurrence; a Host `schedule_execution_pending` becomes `AutomationRunRefusedError` (409), `schedule_not_found` orphans the record and refuses, an admitted run bumps the revision and audit with kind `ran` and records an observed delivery. `Automations.remove(id, actor)` removes the Host task first (`removeHost`, an already missing task is fine), then deletes the record and its delivery history; a Host refusal keeps the record. Covered by `tests/automations.spec.ts`.
- [x] Tools: `automation_run` and `automation_delete` extend the main-Session surface to six tools and keep the explicit-human-request wording; the run tool delivers once now, the delete tool removes the Host task, record and history. Covered by `tests/automations.spec.ts` and `tests/runtime.spec.ts`.
- [x] HTTP: `POST automations/:id/run` answers `{ran: true, automation}` or 409 for a pending execution, 404 for a Host-missing task and 503 without the schedule service; `DELETE automations/:id` answers `{id, deleted: true}` or 404 for an unknown record. `src/app/api.ts` types both routes. Covered by `tests/http.spec.ts`.
- [x] Panel: each row offers Run and Delete; Delete asks for confirmation in a dialog, and both actions reload the page and show a notice or the failure reason. zh/en strings are in `src/client/locales.ts`. Covered by `tests/panel-tasks.spec.tsx`.
- [x] Tests and docs: run success/pending/not-found/no-task, delete success/Host failure/unknown, HTTP and panel states; [006 Deployment](006-deployment.md), [007 Architecture](007-architecture.md) and `docs/011-capabilities.md` describe the approved run/delete behavior. Covered by `tests/docs.spec.ts`.
- [x] `pnpm check` green, including the new run/delete tests.

## Sprint 20 checklist

The operator approved two follow-ups on 2026-11-09: three more proactive rule categories (dependency and toolchain upgrades, review-feedback fixes, and design/architecture decisions) and the missing GitHub label capability that a triage rule needs. Both keep the panel as the only management surface, add no schema step, and end with `pnpm check` green.

- [x] Rules: `deps` (stated dependency or toolchain upgrades; tests and CI stay green; major, replacement, native-extension or security-driven upgrades become a design proposal), `pr-feedback` (only a named reviewer's points on the agent's own pull request, replied to point by point, never merged by the agent) and `design` (a decision document for a large refactor or a cross-project architecture decision; implementation follows in later ordinary Tickets, a cross-project part as a Request). `DEFAULT_RULES` now has fifteen all-enabled categories; `refactor` states that a large refactor first produces a staged plan and rollback points. `upgradeRules` recognizes a third untouched snapshot, the earlier twelve-category set, and upgrades it whole while preserving operator edits. Covered by `tests/policy.spec.ts` and `tests/migration.spec.ts`.
- [x] Source contract: `SourceKind.labels?` applies a `SourceLabelChange` and returns a `SourceLabelResult`; kinds without it cannot be triaged. `Runtime.label(triggerId, change)` resolves the Trigger and the installed kind. Covered by `tests/github-labels.spec.ts` and `tests/tools.spec.ts`.
- [x] GitHub implementation: `src/sources/github-labels.ts` targets the Trigger's Issue or pull request (its project repository or the primary one), requires every added label to exist in that repository and every removed label to be on the target, refuses a label in both directions and more than ten per direction, and applies the change through `Commands.apiWrite` without creating, renaming or deleting labels. Covered by `tests/github-labels.spec.ts`.
- [x] Tool: the main Session's `orchestrator_label { trigger_id, add?, remove? }` is the only tool-side entry, for an explicit human request to label or triage; it changes nothing else about the work. Covered by `tests/tools.spec.ts` and `tests/model-surface.spec.ts`.
- [x] Docs: [002 Authorization](002-authorization.md) lists all fifteen categories, the three new ones, the staged-refactor boundary and the three migration snapshots; [005 Panel](005-panel.md) and [007 Architecture](007-architecture.md) describe the enabled set, the `labels` contract and its runtime path; `docs/011-capabilities.md` records Part C with its limits. Covered by `tests/docs.spec.ts`.
- [x] `pnpm check` green, including the new rule-migration and label tests.

## Sprint 21 checklist

The operator asked on 2026-11-09 for a triage rule and for design decision documents to reach a remote manager through Feishu. Both keep the panel as the only management surface, add no schema step, and end with `pnpm check` green.

- [x] Rules: `triage` (Issue/PR triage: category, severity or priority, assignment suggestion; labels only through `orchestrator_label` on an explicit request and only labels that already exist; no code change, close, merge or fix promise) joins the set, and `design` mentions `orchestrator_send_file` for a decision document a remote manager reviews. `DEFAULT_RULES` has sixteen all-enabled categories; `upgradeRules` recognizes the earlier fifteen-category snapshot and upgrades it whole while preserving operator edits. Covered by `tests/policy.spec.ts`.
- [x] Workspace files: `src/app/files.ts` resolves a path only inside a registered project's workspace; absolute, parent, dot and repeated-separator paths, directories and missing files are refused. Covered by `tests/files.spec.ts`.
- [x] Source contract and Feishu adapter: `SourceKind.sendFile` and `src/sources/feishu-file.ts` send an existing workspace file to a chat through `im +messages-send --file` with the file's directory as the working directory and an optional idempotency key. Covered by `tests/feishu-file.spec.ts`.
- [x] Runtime and tool: `Runtime.sendFile({ triggerId?, chatId?, project, path })` resolves exactly one chat and the file, and the main Session's `orchestrator_send_file` tool is the only tool-side entry, for an explicit human request or a deliverable a Ticket asks for. Covered by `tests/tools.spec.ts` and `tests/model-surface.spec.ts`.
- [x] Docs: [002 Authorization](002-authorization.md) lists all sixteen categories, the triage boundary and the design rule's Feishu path; [005 Panel](005-panel.md) and [007 Architecture](007-architecture.md) describe the enabled set, the `sendFile` contract and its runtime/tool path; `docs/011-capabilities.md` records Part D with its limits. Covered by `tests/docs.spec.ts`.
- [x] `pnpm check` green, including the new file, Feishu delivery and triage tests.

## Sprint 22 checklist

The operator asked on 2026-11-10 for project-level Requests raised by workers and disposed by a project Lead, for a
mandatory Lead reply that is never ignored, for architecture work to run through a human approval gate, for a DSH
Session outside the SuperAgent setup to submit a Request and always receive a reply, and for an explicit whitelisted
mention or direct message to always be answered. The design spec is `docs/012-project-requests.md` (D1–D10); the Tower
mission chain M13–M18 implemented it in order, each mission merging only after its tests and `pnpm check` passed, and the
tower runs the six-combination CI and the live smoke after the chain.

- [x] Schema 21: the `project_request` record, its store repository, migration and unit tests; no tools yet.
- [x] Worker and Lead tools: `request_create` and report `requests`, the Lead disposition and reply tools, and the
  mandatory-reply enforcement at the Lead activation boundary, with prompts and tests.
- [x] Aggregate origin-channel report when a root project Request and all its derived work end; explicit (whitelisted
  mention or direct message) Triggers always receive a reply, whatever the decision.
- [x] Architecture flow: design Ticket, human approval gate on the root channel, approval record and the
  implementation Request only after approval.
- [x] External DSH Session bridge through a `session` Source kind and a submission tool, with the always-reply and
  completion-report contract.
- [x] Docs, CHANGELOG and README counts updated and `pnpm check` green; the six-combination CI and live smoke remain the
  tower's post-merge gate.

## Sprint 23 checklist

On 2026-11-10 an Issue filed in the project's own remote repository produced no response. The operator approved repairing
the GitHub read path and its saved state and switching `eval.mode` from `observe` to `auto`.

- [x] A stream's ETag is saved only by a read that took in every listed item; a skipped item forces the next read in full.
- [x] A conditional read is trusted for at most ten minutes; after that one unconditional read confirms the list again.
- [x] A one-time repair drops saved stream ETags on the first start after the upgrade, so a skipped list is read again.
- [x] Tests cover the skip, the stale revalidation, the recent conditional read and the one-time repair.
- [x] Docs, CHANGELOG and README counts updated; `pnpm check` green.

## Sprint 24 checklist

On 2026-11-10 the operator asked for the project's own Issue #1 to be fixed: every Ticket must name a deliverable
contract instead of leaving answer-only work to pay for a branch it can never merge, and leaving change work to end as
`completed` without a pull request.

- [x] Schema 22 and migration: every Ticket carries `deliverable: 'change' | 'answer'`; open Tickets and ended Tickets
  with a followed pull request migrate as `change`, any other ended Ticket as `answer`.
- [x] An accept names the deliverable (default `change`) and only a change requires `worktree_name`.
- [x] A change Ticket ends only through the pull requests it names or follows; a ready report without a pull request is
  refused with `changeNeedsPullRequest` and records the pull request it names.
- [x] An answer Ticket reads the project's live checkout read-only: no branch, worktree, prepare command, write tool or
  mutable permission preset; its ready report ends it as `completed`.
- [x] The panel and result notices show an ended answer Ticket as **Answered**.
- [x] Tests cover the contract, the refusals and the migration; docs, CHANGELOG and README counts updated and
  `pnpm check` green.

## Sprint 25 checklist

On 2026-11-10 the operator approved A′: a project automation delivery is a standing instruction that cannot create a
Source Trigger, so its inspection may raise and decide one project request for its own project instead of leaving the
work it found unactionable.

- [x] `lead_request_create` raises a project-scope work request, records the `automation` id from the delivery marker,
  and returns the open request instead of a second one for the same title in one Lead Session; the Lead disposes it
  with the mandatory reply.
- [x] A rootless work accept creates the ordinary Request and its Tickets through `Tickets.createLead`, with empty
  Channels, an empty Trigger id set and a `dsh-superagent:lead:<project>` Mandate actor; a rootless architecture
  accept still refuses because the human approval needs the root Thread.
- [x] The report-only rule permits exactly that project request and no other project write.
- [x] The panel's Lead row shows pending project requests and how many came from automations.
- [x] Tests cover the raise, the accept, the dedupe and the report-only text; docs, CHANGELOG and README counts
  updated and `pnpm check` green.

## Sprint 26 checklist

On 2026-11-10 the operator approved P1 of the installation self-bootstrap: an installation automation delivery can turn
its findings into one installation-level Request, which no Session could do before.

- [x] `orchestrator_request_create` creates one Request with one Ticket per delivery unit from an installation
  automation delivery's findings, recording the automation id.
- [x] The named automation must exist and be installation-scope; every unit names a registered project; a repeated raise
  with the same title and automation returns the open Request.
- [x] The Request has no Channels and an installation Mandate (`basis.via = 'installation'`, actor
  `dsh-superagent:installation`) that revalidation trusts; architecture work keeps its root-Thread approval.
- [x] Tests cover the Request, the units, the dedupe and the refusals; docs, CHANGELOG and README counts updated and
  `pnpm check` green.

## Sprint 27 checklist

On 2026-11-10 the operator approved P2: a project Lead can escalate work outside its project to the Orchestrator, which
decides it with the mandatory reply and notifies the Lead.

- [x] `lead_request_escalate` records an `escalation` request; the Lead's own decide, reply and complete commands refuse
  it, and a repeated title in the same Session returns the open request.
- [x] `orchestrator_escalations` lists open escalations; `orchestrator_escalation_decide` records the reply and, on
  accept, one installation-level Request with one Ticket per registered delivery unit under an escalation Mandate;
  reject and needs-info create no work.
- [x] The decision is written as a durable `lead_message` notice and delivered to the source project's Lead; the
  original root request keeps its own aggregate report.
- [x] Tests cover the raise, the Lead refusal, the accept and the reject; docs, CHANGELOG and README counts updated and
  `pnpm check` green.


## Sprint 28 checklist

On 2026-11-10 the operator approved P0-1: the plugin's own log is observable from the panel, without a second
on-disk artefact.

- [x] `src/app/logs.ts` keeps a bounded in-memory ring of the Host log, formatting printf arguments at capture time;
  the Host logger still receives the raw arguments and nothing is written to disk.
- [x] `GET logs` serves level-filtered (all, warning and error, error only) and scope-filtered entries; the panel's
  Logs tab shows them newest last with the empty and unmatched states.
- [x] Tests cover the ring and its filters, the route, and the page; docs, CHANGELOG and README counts updated and
  `pnpm check` green.

## Sprint 29 checklist

On 2026-11-10 the operator approved P0-2: one "needs you" view on the Overview, instead of a separate page per kind of
waiting work.

- [x] The Overview lists open escalations awaiting the Orchestrator (title, source project, instruction preview and
  raised time) and automation records that are orphaned or carry a delivery error, linking to the Automations page.
- [x] The view is read-only: escalations are still decided from the main Session, and their approval actions remain a
  later slice; no new route was added.
- [x] Tests cover the view fields and the panel sections; docs, CHANGELOG and README counts updated and `pnpm check`
  green.
