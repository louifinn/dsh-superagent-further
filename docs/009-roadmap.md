# 009 Roadmap

This document turns the prototype into something a team can use every day. It records where the code stands after its first real runs, what must happen before an installation can be left running unattended, and in which order to do the rest. It builds on [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md); decisions recorded here supersede their open questions when they disagree.

## Where it stands

- The bundle runs natively on Windows 11, both inside the daily DeepSeek Harness application and through `scripts\dsh-superagent-further.cmd`. Linux is verified in WSL and covered by CI; macOS is covered by CI only.
- Two real Tickets ran end to end. A GitHub Issue mention produced PR #3 (branch `agent/add-agent-test-file-d7efd3d9a996`, commit `03a671f`, merged as `18969c9`); a Feishu `@DSH` message produced PR #4 (branch `agent/add-feishu-test-1d5fe7ab22c4`, commit `ae2f409`, merged as `67973d4`). Both were merged by the operator, and both Tickets ended `merged`.
- `pnpm check` is green: 108 spec files, 1782 passed and 5 skipped (1787) on Windows after the Memory page (search, project filter, order, paging), the Language setting, the sixteen all-enabled localized proactive rules (including dependency upgrades, review-feedback fixes, design decisions and Issue/PR triage), the GitHub label capability for triage, the Feishu file delivery for a remote manager reviewing a design document, the derived primary repository, the setup wizard, the rename migration test, the agent-safe configuration tiers and proposals (schema 18), per-block restore (schema 18), installation- and project-scope automation tasks with manual run and delete (schema 19), the bounded delivery history with panel-only notices (schema 20), the GitHub read-path repair that stops a skipped listing from staying hidden behind a saved ETag, Trigger IDs scoped by repository so equal Issue and PR numbers in different projects stay separate, the Ticket deliverable contract (schema 22) that ends answer work with its report and requires a followed pull request for change work, the explicit ticket end cause and the report-retirement grace that stops a report from cancelling its own turn (schema 23), the self-evolution Issue outlet with durable drafts, the three-state gate, the discovery Mandate basis and the Overview approvals (docs/014 phase 2, schema 24), the Lead-raised project request from a project automation delivery (docs/012 D11), the installation-level self-bootstrap request from an installation automation delivery (docs/012 D12), the Lead escalation to the Orchestrator for work outside its project (docs/012 D13), the panel log page and its scoped operational records (startup, lifecycle, outbox delivery and health transitions), durable rolling JSONL Host logs with rotation, retention and a configurable level, the Logs keyword search/copy/JSONL download/load-more and Ticket, Request and Assignment deep links, the operator audit scope and the archive-state default database fix, the aggregate "needs you" Overview, the packed-tarball check against a committed manifest, the generated tool and settings references, the in-process mount-surface test, and the seeded property tests for admission, Trigger identity, idempotent creation, schema migration and reconcile, the Ticket review gate with its reviewer preset, the report verification checks, the architecture layering check, the operations runbook with SECURITY.md, the state archive script, the self-evolution discovery prompt layer (docs/014 phase 1), the background-job completion delivery and stalled-assignment watchdog, the worker turn-end protocol and per-Ticket worktree rules, and the panel's worker-job and failed-file-delivery views, and the mandatory Orchestrator workspace with its fail-closed startup ([ADR 0003](adr/0003-workspace-identity.md)), and the deterministic operational incidents with durable records, fingerprint dedupe and content-addressed evidence bundles (schema 25, [ADR 0004](adr/0004-deterministic-incident-detection.md)), and the read-only incident diagnosis with its bounded budget and routing through the existing self-evolution outlets ([ADR 0005](adr/0005-read-only-incident-diagnosis.md)), and the stable supervisor split from a versioned domain runtime with its frozen host API, crash journal and drain contract ([ADR 0006](adr/0006-supervisor-and-versioned-runtime.md)), and the staged runtime update pipeline with its journaled swap, pre-swap database backup, crash recovery (pointer reconciliation plus database restore after a schema-bumping candidate) and confirmed rollback ([ADR 0007](adr/0007-runtime-update-pipeline.md)); Linux is green too, the process-script and Feishu failures found by the first real Linux run are fixed, and every push is checked on all six platform and Node combinations.
- `.github/workflows/check.yml` runs on every push to `main` and is green on all six platform and Node combinations; `smoke.yml` starts a real host on macOS.
- The installation runs inside the daily desktop profile. Two hosts cannot share one state directory, so the in-application instance and the service script are currently exclusive by hand, not by design.
- Multi-project work is live: registered projects are polled, each Ticket runs in its own project's worktree under a project Lead (schema 15 ends the Requests of old Tickets), and a cross-project Request (90df28d6…) produced two Tickets, two pull requests and one `done` state. The panel lists open Requests with their Tickets and the digest names each Request in flight.
- Project-level work is live (schema 21): a worker raises a durable `project_request` when a decision, a new deliverable or another project's work blocks its Ticket, and its project Lead must answer with a non-empty reply before the request can be disposed. An accepted work request creates the ordinary Request and its staged Tickets under a Lead Mandate confined to that project; an architecture request produces a design Ticket and needs a person's recorded approval on the root Thread before the implementation Request exists; an unanswered request is reminded twice, then marked as needing attention. A root request is closed with one aggregate report on the channel the chain started from, and an independent DSH Session can submit work through the `session` Source and always receives an answer; a project automation delivery may raise and decide one project request, an installation automation delivery may create an installation Request from the main Session, and a Lead may escalate work outside its project for the Orchestrator to decide (`docs/012-project-requests.md`).
- The deployment has one primary repository, derived from the first registered project rather than configured on the GitHub Source: schema 17 removes the Source's own `repository` setting from the stored settings and every saved revision, setup verifies push access to the first project's repository, and unqualified `github:<n>` Thread ids belong to it while every other project's ids are qualified `owner/name#<ref>`.
- An experimental memory layer, off by default, outlives Sessions: the main Session and each project Lead can write, search and forget memories (`memory_write`, `memory_search`, `memory_forget`), a runtime-context snapshot carries pinned and recent memories (appended after the cached history, so a write does not rewrite the system prompt), ended Tickets and Requests are remembered deterministically, and the panel's **Memory** page — labeled experimental — switches the mechanism, injection and automatic writing on or off, edits the limits live, and lists the stored memories as searchable, orderable cards that expand to every stored field and can be pinned or forgotten (schema 16).
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


## Sprint 30 checklist

Three operational skills now ship with the plugin so the main Session, a Lead and an Executor can run the documented workflows: issue and pull-request triage, release, and project requests. They load from the package, are registered for every Session, and a team cannot shadow them with a custom skill of the same name. Usage visibility was investigated and is deferred: the Host exposes its model catalog but no token or cost accounting, so the panel does not invent one.

- [x] Bundle `skills/dsh-superagent-further-triage|release|project-request/SKILL.md` and register them as built-in skills.
- [x] Reject a team skill whose name would shadow a built-in operational skill.
- [x] Test the bundle loader, the frontmatter, and composition from the package.
- [x] Document the skills in 007 and 011, and record usage visibility as a deferred item.

## Sprint 31 checklist

An escalation no longer needs the main Session to be answered: the Overview row carries the required reply and the three decisions over `POST escalations/:id/decide`. The route and the main Session's tool share `src/app/escalations.ts`, so the Lead receives the same `lead_message` notice either way. Accept from the panel starts one Ticket in the escalating project; work whose units belong elsewhere stays on the main Session's tool.

- [x] Add the shared decision path and the HTTP route with its reply and unit validation.
- [x] Decide an escalation from the Overview and empty its row.
- [x] Test the route's boundary rules and the panel flow.
- [x] Document the two surfaces here and in 005/007/011.

## Sprint 32 checklist

The distribution, reference and invariant gates now run in `pnpm check`: the packed tarball is checked against a committed manifest, the tool and settings references are generated from the code, and the loaded surface plus the core invariants are tested.

- [x] `scripts/check-pack.mjs` checks the npm tarball's file list against `scripts/pack-manifest.json`; `--update` rewrites the manifest after an intentional change.
- [x] `scripts/generate-tool-reference.mjs` generates `docs/reference/tools.md` and `docs/reference/config.md`, and `docs:check` fails when either is stale.
- [x] `tests/surface.spec.ts` asserts the loaded main Session, Lead and Executor tool sets, the bundled skills and the bundle's preset rows.
- [x] `tests/properties.spec.ts` covers admission, Trigger identity across repositories, idempotent creation, schema 22 migration and reconcile fixed points over seeded random inputs.
- [x] `pnpm check` runs typecheck, tests, build, pack:check and docs:check; docs, CHANGELOG and README counts updated.

## Sprint 34 checklist

A merged or closed pull request now reaches the project Lead, and the Lead relays the end to the worker Sessions that did the
work. The Orchestrator writes one durable Lead message per ended Ticket and the Lead uses a validated relay tool.

- [x] `LeadDispatch.pullEnded` writes and prompts one `lead_message` notice per ended Ticket, naming the PR, the Ticket and the worker Session(s).
- [x] `lead_notify_worker` relays to a worker or reviewer Session of the same project only; another project's Session is refused.
- [x] `tests/runtime.spec.ts` covers the merge notice and the relay, and `tests/surface.spec.ts` covers the Lead tool set.
- [x] docs/004, docs/007, docs/010 and CHANGELOG updated; `pnpm check` green.

## Sprint 33 checklist

A change Ticket can carry an independent review, the report of a worker can carry verification checks, and the codebase
now checks its own layering. The review gate lives in the core: a blocked verdict keeps a merged change Ticket open for a
person instead of ending it silently.

- [x] `tests/core-engine.spec.ts` covers the review gate, and `tests/surface.spec.ts` covers the reviewer preset and the Lead tool set.
- [x] Reports carry up to 20 verification checks, shown on the Ticket and counted in request notices.
- [x] `scripts/check-architecture.mjs` enforces the import direction and runs in `pnpm check`; `tests/architecture.spec.ts` covers its rules.
- [x] A reviewer preset ships with the bundle and `lead_review`/`lead_review_record` are Lead tools (docs/012 D14).
- [x] The operations runbook, SECURITY.md, the state archive script and the report-only coverage step ship with their docs and tests.

## Sprint 35 checklist

The worker-session reliability fixes from the 2026-11-11 incident: a background job that settles at the turn-end boundary still reaches the worker, a stalled assignment becomes visible in ten minutes, and a worker never ends a turn to wait for a wake.

- [x] The Executor watches each worker Session's jobs, persists settled snapshots on the Assignment, and wakes the worker through its Lead when a job settles while the assignment runs (Assignment.jobs, DshExecutor.jobsSnapshot).
- [x] The worker preset allows a 60-second default and 10-minute maximum job_output wait, so a gate can finish inside the turn.
- [x] prompts/work.md forbids ending a turn to wait for a wake and keeps one worktree and cwd per Ticket with absolute cross-worktree evidence.
- [x] The Runtime watchdog turns a waiting assignment idle past ten minutes into ticket attention and one durable Lead notice.
- [x] The panel's Execution tab shows each worker's background jobs with a last-output preview, and Overview shows failed file deliveries with their reason.
- [x] Covered by runtime, lead-dispatch, http and panel tests; pnpm check green.

## Sprint 36 checklist

Ending a Ticket became an explicit fact and a reporting worker is no longer cancelled by the report that ended its Ticket.
The ticket's record names its own teardown authority, and a Lead-hosted worker and a reviewer notify the Lead through
different DSH deliveries.

- [x] `Ticket.ended` carries `by` (`executor` or `human`), `cause` (`report`, `human`, `merge` or `eval`) and the outcome; `Executor.stop` receives the matching `ExecutorStopCause` (`TicketEndCause | 'retry'`) instead of inferring teardown authority from report timing. Schema 23 backfills every ended Ticket's cause; `tests/migration.spec.ts` and `tests/properties.spec.ts` cover it (M24, merge commit `8f903781`, parents `3cd2a47` + `841f81f`).
- [x] A report that ends an `answer` Ticket commits inside the report call and no longer cancels that call: retirement waits up to `RETIRE_GRACE_MS` (60 s) for the reporting turn to end, then disposes the activation and stops background work; a turn past the grace is cancelled as a `user` stop; external `human`/`merge`/`eval`/`retry` stops preempt at once. `tests/executor-retirement.spec.ts` covers both paths.
- [x] Worker activations use DSH delivery `caller` (the application's durable Lead messages are the single notification authority); reviewer activations use `parent`, so the reviewer's verdict reaches the Lead model and `lead_review_record`. Covered by the lead-dispatch and runtime tests.
- [x] Documentation records the contract: docs/003 and docs/010 describe retirement and the caller/parent split; docs/007 names `TicketEndBy`, `TicketEndCause` and the grace; `docs/adr/0001-ticket-end-authority.md` records the decision and its rejected alternatives; docs/014 plans `self_report` at schema 24; CHANGELOG has the M24 and documentation entries; `tests/docs.spec.ts` permits numbered docs to link `docs/adr/*.md`.
- [x] Verification: 92 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm test` (1533 passed, 5 skipped), `pnpm build`, `pnpm pack:check`, `pnpm docs:check`.

## Sprint 37 checklist

The plugin's Host log became an operational record: every part writes under its own scope into the same bounded
in-memory ring, the Runtime records the lifecycle and delivery facts an operator can read, and a health state change
is one warning that its recovery closes.

- [x] `src/app/logs.ts` exposes `captureScopes`; Runtime injects scoped captures into Sessions, Setup, Automations and the Outbox (docs/011 Part H).
- [x] Runtime records runtime ready, `trigger.received`, `ticket.created`, `ticket.ended` (by/cause/outcome), `request.ended`, `assignment.started/ended`, and outbox delivery and first failure without message bodies.
- [x] `HealthBoard` has an optional state-transition listener; Runtime logs one `warn` on entering error and one `info` on recovery under the claim's name, plus one startup summary of the claims that came up ready.
- [x] `tests/operational-log.spec.ts` covers scopes, levels, ordering, the 400-entry cap and retry de-duplication; docs/005, docs/013, docs/007 and docs/011 Part H name the real scopes.
- [x] Verification: 93 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm test` (1540 passed, 5 skipped), `pnpm build`, `pnpm pack:check`, `pnpm docs:check`.

## Sprint 38 checklist

The Host log outlives a restart. Every entry is also appended to rolling JSONL files under the state directory, pruned by
a configured retention, while the ring gains keyword search, structured data, redaction, folding and a minimum level. The
Executor, Sources and Runtime record their lifecycles as metadata under their own scopes, and the log level and retention
are Execution settings that apply immediately.

- [x] `src/app/log-files.ts` appends each entry to `<stateDir>/logs/YYYY-MM-DD.jsonl`; a file rotates to `.N` at 20 MiB, retention (1–30 days) prunes at startup and day rollover, and a 50 ms unref batch flush drains a bounded queue that counts drops. The directory is 0700, files are 0600 with `restrictToOwner`, the 8 KiB line cap drops data and shortens the message, and a failure (full disk, denied ACL) never throws or recurses: it drops the batch, counts it, and reports once through the `logs` health claim.
- [x] `src/app/logs.ts` keeps 2000 entries (200 by default), redacts credentials and environment values before the ring and the file, folds consecutive identical scope+message entries over 60 seconds with a repeat count, gates debug entries on the current level, and serves `GET logs` with level, scope, keyword search, a widened limit and structured `data`. `Runtime.shutdown` creates its 10 s bound before calling `close()` and clears the timer afterwards; `close()` accepts nothing from its first line, shares one promise across repeated calls and drains the last batch with asynchronous appends, so the bound governs a real wait while a synchronous disk stall inside the file-open path is not preempted.
- [x] The Executor records `assignment.launched`, `assignment.preempted` (cause, cancelled), `assignment.retiring`/`retired` (grace, cancelled), `turn.started`/`turn.ended` (reason, cancel cause, duration), `job.settled` (status, cause), `report.recorded` (state, outcome) and `agent.error` (name, code, turn, step); Sources log per-poll success at debug, a single-failure detail at debug (redacted) and recovery at info; Runtime logs `policy.changed` and `decision.recorded`. No entry carries a message body, tool argument/result, report summary, setting value, or model content.
- [x] Execution has `logLevel` (`info`/`debug`, default `info`) and `logRetentionDays` (1–30, default 7) as tier-C settings, with a Logs group on the Execution settings page; both apply on the next entry or prune without a restart, and `docs/reference/config.md` was regenerated.
- [x] `tests/log-files.spec.ts` and the extended `tests/operational-log.spec.ts` cover the sink, redaction, folding, level gating, every new scope, and the panel/route changes; the ring-only spec also loads and fails behavior-by-behavior on the 8dca227 tree, while the sink spec's module-missing failure is retained as its red evidence; docs/005, docs/007, docs/011 Part H, README, README.zh-CN and CHANGELOG are synchronized; `scripts/pack-manifest.json` was refreshed after the build.
- [x] Verification: 94 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm test` (1562 passed, 5 skipped), `pnpm build`, `pnpm pack:check`, `pnpm docs:check`. (M29)

### Sprint 38 completion (M30)

The operator-facing log surface and the follow-ups the Sprint 38 brief deferred to M30.

- [x] The Logs page searches with `q` over message, scope and data, copies the current filtered view and downloads it as a client-side JSONL Blob (one object per line, the file's fields), loads more rows in pages of 200 up to the 2000-entry ring, and shows the loaded count; Ticket, Request and Assignment views deep-link into it prefilled with `q=ticket=<id>`, `q=request=<id>` and `q=assignment=<id>`. The client route keeps the keyword; no server file route or new API route was added. `tests/panel-logs.spec.tsx` and `tests/navigation.spec.ts` cover each behaviour.
- [x] Human-triggered domain actions are audited through the existing ring and sink under the `audit` scope: settings save and restore, Ticket retry/stop, escalation decision and automation create/edit/run/delete record `info` entries with `actor=operator`, the action and ids, block and revision or counts. Automatic lifecycle entries and failed actions produce no audit entry, and setting values, replies, instructions and message content never appear; `tests/http.spec.ts` pins both directions.
- [x] `scripts/archive-state.mjs` archives `<stateDir>/orchestrator.sqlite` by default and accepts `--database <path>`; the usage text and SECURITY.md, docs/013 and CONTRIBUTING.md say `orchestrator.sqlite`. docs/013 documents that `<stateDir>/logs` is not in an archive-state snapshot, its rotation and 1–30 day retention, and the manual copy. `tests/archive-state.spec.ts` covers the default, the override and the refusals.
- [x] ADR-0002 records the durable JSONL decision, rotation/retention, the metadata-only and audit rules, the crash window, the single writer and why logs are not archived, with the rejected memory-only, database-table and full-body alternatives. docs/005, docs/006, docs/007, docs/011 Part H, docs/013, README and README.zh-CN are synchronized.
- [x] Verification (M30): 94 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm test` (1574 passed, 5 skipped), `pnpm build`, `pnpm pack:check`, `pnpm docs:check`.

### Sprint 39 completion (M31)

The Orchestrator workspace is mandatory, validated and set up fail-closed. The old main Session ran in the plugin's `stateDir`, which also holds the database, lock, logs and worker scratch, and DSH had no workspace for it; an upgrade cannot change a Session's cwd, so the migration creates a new master Session and keeps the old one as readable history.

- [x] The workspace is a first-class tier-A settings block (`{ path }`) with its own revision, validation through `Setup.verifyWorkspace`/`prepareWorkspace`, a canonical path persisted, and a restart when it changes. A missing or invalid workspace is `workspaceRequired`, `workspaceInvalid`, `workspaceNotEmpty`, `workspaceNotWritable` or `workspaceUnsafe` (place `execution`) and blocks startup. `src/app/workspace-root.ts` refuses the state directory and its scratch, DSH home/profile/session store, the package checkout, project workspaces, relative/UNC/root paths and symlinks; it creates an empty directory, writes `.dsh-superagent-workspace`, sets `0700` (owner ACL on Windows) and registers the DSH workspace under `dsh-superagent-further · <name>`. Covered by `tests/workspace-identity.spec.ts` and the extended runtime, http, policy and model-surface specs.
- [x] Setup resolves the workspace before projects, accounts and environment. A failed setup leaves the runtime `paused`/`setupPending` and creates no DSH workspace, no master Session and no Executor/Source start. Startup registers the workspace, retires the old master id best-effort (archive with `stopActivity`, legacy `stateDir` registration deleted, no Session deleted; a failure is logged as a warning and leaves the old Session and registration intact and readable), unarchives the returning workspace's own master before resolving it (a failed unarchive fails startup with `workspaceUnsafe`), ensures the master Session in the registered workspace, and publishes the new id in one `store.atomic` write; the order is idempotent across restarts.
- [x] The setup wizard makes the workspace its first step after the welcome: Skip step, Skip all and the primary button are inert until a valid workspace is saved, and the server refuses `PUT wizard` with `workspaceRequired`. Closing the dialog (button, Escape or backdrop) always works and records nothing: setup stays unfinished, the host stays paused at `workspaceRequired`, and the header **Setup wizard** entry reopens it. The Execution settings page shows a workspace card with the titled DSH workspace and its own history; the Overview and setup state surface the exact workspace problem. Covered by `tests/panel-setup-wizard.spec.tsx`, `tests/panel-execution.spec.tsx`, `tests/http.spec.ts` and the guard tests.
- [x] ADR-0003 records the decision and the rejected alternatives; docs/003, 005, 006, 007, 011 and 013, README, README.zh-CN and CHANGELOG are synchronized. No database schema change was needed.
- [x] Verification (M31): 95 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm test` (1599 passed, 5 skipped), `pnpm build`, `pnpm pack:check`, `pnpm docs:check`.

### Sprint 40 completion (M32)

The self-evolution outlet has a durable record and discovery provenance (docs/014 phase 2). The Issue route is one tool and one store-owned table; the in-jurisdiction route is an ordinary Request with a Mandate basis that no Source message had to admit.

- [x] Schema 24 adds the store-owned `self_report` table — `{ id, title, body, evidence, raised_by { session, ticket? }, target_repo, status: 'draft' | 'filed' | 'dismissed', issue_number?, filed_at?, created_at }` — created by the Store; `migrateTo24` is a documented no-backfill step, so a schema 23 database starts at 24 with an empty table and keeps its Tickets. `SelfReportRecords` implements `get`/`save`/`list(status?)` oldest-first, and `SelfReportRepository` is optional on `Repositories` for repositories opened before schema 24. Covered by `tests/migration.spec.ts` and `tests/properties.spec.ts`.
- [x] `src/core/self-reports.ts` holds the fixed `SELF_REPOSITORY = 'louifinn/dsh-superagent-further'`, the 120/8000 text limits, the disclosure, the content rules (Feishu chat, message, user, union and app identifiers; credentials; and Unicode-aware drive-letter, UNC and POSIX private paths, while URLs and repository-relative paths stay valid), the title/keyword dedupe helpers and the UTC-day/14-day filed windows. `src/app/self-reports.ts` raises a draft from the main Session or a Ticket's worker, files it through the existing `gh` command path only with labels the repository already has, links a remote open Issue or a filed report of the last 14 days instead of filing twice, keeps the finding a draft beyond three filed Issues per day, re-checks the exclusive jurisdiction rule when a person approves a draft (so a draft raised before the self repository was registered cannot file, though it can still be dismissed), and records audit plus a health failure. Covered by `tests/self-reports.spec.ts` and `tests/self-reports-app.spec.ts`.
- [x] The Eval settings gain the tier-B `selfReport` gate: `off` records nothing, `observe` (default) keeps a draft, `auto` files directly. `orchestrator_issue_create` enforces the jurisdiction rule (a registered self repository refuses and names the discovery route) and cannot create labels: its optional `labels` argument is applied only where the target repository already has them, none by default; `orchestrator_request_create` accepts `via: 'discovery'` mutually exclusive with `automation` and creates the Request with Mandate basis `{ via: 'discovery' }`, which `revalidate` trusts like installation. The Orchestrator prompt routes a self-finding through those two outlets, and both prompts still carry the jurisdiction passage. Covered by `tests/tools.spec.ts`, `tests/policy.spec.ts`, `tests/prompts.spec.ts`, `tests/surface.spec.ts` and `tests/model-surface.spec.ts` (budget 70,500).
- [x] Overview lists observe-mode drafts with title, target repository, evidence preview, age, the daily-cap hint and Approve and file / Dismiss actions through `POST self-reports/:id/approve` and `POST self-reports/:id/dismiss`; the audit log records both under the operator actor, and `auto` mode accumulates no rows. Covered by `tests/views.spec.ts`, `tests/http.spec.ts` (the real routes: success audits `self-report.approve` with the report id, Issue number and status and `self-report.dismiss`, while a filing failure, an unfiled outcome and an unknown id answer their status and record no audit), `tests/panel-overview.spec.tsx` (the buttons send those requests and the rows disappear) and `tests/panel-eval.spec.tsx`.
- [x] docs/002, 005, 006, 007, 009, 011 and 014, README, README.zh-CN and CHANGELOG are synchronized, and the regenerated `docs/reference/tools.md` and `docs/reference/config.md` carry the new tool, the `via` option and the `selfReport` setting. The live marked test Issue on `louifinn/dsh-superagent-further` remains the operator's acceptance step (docs/014 Phase 2); it is not opened or closed here.
- [x] Verification (M32): 97 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm test` (1632 passed, 5 skipped), `pnpm build`, `pnpm pack:check`, `pnpm docs:check`. Review-round fix evidence: with the outlet's source stashed, `tests/self-reports.spec.ts` fails at the first newly required form (the union Feishu id) and `tests/self-reports-app.spec.ts` fails on approving a draft after the self repository is registered (2 failed / 18 passed); with the approve route's audit call removed, `tests/http.spec.ts` fails on the missing `self-report.approve` entry (1 failed). Base-red evidence on 22361e9 remains 22 failed / 487 passed with the original source stashed.

### Sprint 41 completion (M33)

The host detects its own operational trouble deterministically and records it durably without a model call (ADR-0004). Six rules watch signals the Runtime already produces; a fingerprint dedupes repeats, a cooldown, daily budget (live-outage rules exempt), open cap and minimum severity bound the noise, and each new record writes a content-addressed evidence bundle under the workspace.

- [x] Schema 25 adds the Store-owned `incident` table — `{ id, fingerprint UNIQUE, rule, scope { project?, ticket?, request?, session? }, severity: 'low' | 'medium' | 'high' | 'critical', status: 'detected' | 'bundled' | 'diagnosed' | 'resolved' | 'dismissed', first_at, last_at, occurrences, title, detail, evidence_dir, diagnosis?, resolution?, updated_at }` — created by the Store; `migrateTo25` is a documented no-backfill step, so a schema 24 database starts at 25 with an empty table and keeps its data. Covered by `tests/migration.spec.ts` and `tests/properties.spec.ts`.
- [x] `src/core/incidents.ts` holds the severity, status and rule vocabularies, the scope shape, the fingerprint over the rule and normalized scope ids and detail, the `detected → bundled → diagnosed → resolved | dismissed` matrix with the reopen path, and the validation shared by the service, detectors and tests. `IncidentRepository` is optional on `Repositories`, so repositories opened before schema 25 still satisfy it. Covered by `tests/incidents.spec.ts`.
- [x] `src/app/incidents.ts` records and counts: an open record with the same fingerprint increments `occurrences` and `last_at` instead of duplicating, a resolved or dismissed record stays quiet for the one-hour cooldown measured from `last_at` and then reopens, the daily budget counts new records per UTC day of `first_at` (except the live-outage rules `health-error` and `stalled-assignment`, which bypass it), the open cap is 100 and the minimum severity is `high`; `recover` resolves a record whose condition cleared. Each first record writes `config.json`, `health.json`, `related.json` and a 30-minute `log-window.jsonl` from the ring and the durable files, hashes them into `manifest.json`, keeps the newest 20 bundles and those under 30 days, sets directories and files owner-only, and on failure deletes the partial bundle, sets the `incidents` health error and still saves the record. Covered by `tests/incidents.spec.ts` and `tests/incidents-runtime.spec.ts`.
- [x] `src/app/incident-detectors.ts` implements the deterministic rules — assignment-end bursts (4 in 10 minutes per project), `agent.error` (3/10), outbox delivery failures (3/30), consecutive `source poll` failures (3/10, recovered by `poll.recovered`), a health claim entering `error` (immediate) and the M21 watchdog's stalled Assignment (deduped to its existing request); `update-failures` is reserved for M36. The Runtime subscribes Engine `DomainEvents`, the `Logs` observer (debug entries the verbosity gate drops included), the health board's real transitions and the watchdog, and every detection failure is a warning log, never a failed pass. Covered by `tests/incidents.spec.ts`.
- [x] Tier-C `executor.incidents` (`enabled`, `autoDiagnose` reserved for M34, `dailyBudget` 2, `minimumSeverity` `high`) with controls under Execution settings; `GET incidents` (status, severity, scope ids, page window) and `GET incidents/<id>` (record plus evidence manifest) typed in `src/app/api.ts`; the Incidents tab lists, filters and opens records, Overview adds a "needs you" block while any is open, and both locales, docs/005, docs/011 and docs/013 are updated. Covered by `tests/panel-incidents.spec.tsx`, `tests/panel-overview.spec.tsx`, `tests/panel-panel.spec.tsx`, `tests/panel-settings.spec.tsx`, `tests/http.spec.ts` and `tests/policy.spec.ts`.
- [x] ADR-0004 records the decision and rejected alternatives; docs/006, 007, 009, 011 and 013, README, README.zh-CN and CHANGELOG are synchronized, and the regenerated `docs/reference/config.md` carries the `incidents` settings block. The live acceptance step remains the operator's, as with the earlier phases.
- [x] Verification (M33): 100 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm test` (1660 passed, 5 skipped), `pnpm build`, `pnpm pack:check`, `pnpm docs:check`. Red→green: on the unmodified base `tests/incidents.spec.ts` could not resolve `../src/core/incidents.ts`, `tests/incidents-runtime.spec.ts` failed 4/4, and the schema 24→25 migration and the properties chain failed; after implementation those files are 19/19, 4/4, 32/32, 7/7 and `tests/panel-incidents.spec.tsx` 4/4. The seeded-fault integration test drives one burst into exactly one incident (occurrences increment inside the cooldown) and a second capture after it, asserts the evidence bundle's manifest and files exist, a forced bundle failure sets the `incidents` health error without throwing, and no model call is made. Review-round fix evidence: with the evidence-bundle failure guard removed, `tests/incidents.spec.ts` fails on the no-workspace case with "The Orchestrator workspace is not selected" escaping `record()`; restored, the record stays `detected` with an empty `evidence_dir`. The Runtime closure no longer falls back to the state directory (ADR-0003), `GET incidents/<id>` reaches the missing-record 404 through `requireIncident`'s `incidentUnknown`, and the dead incident-doc references now point at ADR-0004 or the relevant 005/006/007/013 doc. Round 3: the ADR-0004 budget exemption is implemented — the two new tests in `tests/incidents.spec.ts` failed 2/2 on the pre-fix code (a `health-error` and a `stalled-assignment` record were dropped once the daily budget was spent), and pass 19/19 once `incidentBudgetExempt` lets only those two rules skip the budget while an ordinary rule is still dropped; the stale schema 24 rows in docs/007 now name schema 25 and the premature manual resolve/reopen claim says what this release actually exposes.

### Sprint 42 completion (M34)

The host diagnoses an operational incident read-only, within a bounded budget, and routes the conclusion through the self-evolution outlets it already has, so a fix can become a Request (or a self-report) but never an automatic change (ADR-0005). A diagnosis cannot mutate: the diagnostician preset carries only `agent-instructions`, `time-context` and a `tool-fs` mounted `write: false`/`edit: false`, and the child Session is put on the `read-only` permission preset where the host exposes one.

- [x] `cordis.patch.yml` gains `dsh-superagent-further-diagnostician-preset` for the agent preset `dsh-superagent-further-diagnostician` (order 95, Chinese name and description, not selectable by hand) and `src/app/sessions.ts` exports `DIAGNOSTICIAN_PRESET`; `tests/bundle-patch.spec.ts` pins the row and the exact plugin inventory (no shell, job, search, skill, compaction, delegation, scheduling, goal, plan, manager, web, todo, question or present tool).
- [x] `src/app/diagnosis.ts` gates auto-diagnosis on `autoDiagnose`, `high`/`critical` at or above `minimumSeverity` and a `detected`/`bundled` status, spends a durable per-UTC-day budget (`executor.incidents.diagnoseDailyBudget`, integer 0–24, default 2; the counter is a Store kv record updated inside one `atomic` and survives a restart; every attempt counts), and holds an in-memory single-flight. It dispatches through the host `subagents` service (`spawn`, `delivery: 'caller'`, `maxDepth: 1`, the main Session parent, the selected Orchestrator workspace as cwd, `diag-<incidentId>-<suffix>`), bounds start and result together to 10 minutes, aborts a start that overruns and disposes a late activation exactly once, and degrades to a `diagnosis` warn log plus the `incidents` health error while leaving the record as it was. A completion re-reads the record and saves only the diagnosis through a compare-and-swap `UPDATE ... WHERE id=? AND status=? AND updated_at=?`; if the operator dismissed or resolved it, or a repeat detection counted it, in the meantime the save is refused as `stale` with one `diagnosis` warning and no health error, so the newer state wins. Detection itself starts no model call. An unparseable answer is kept as a low-confidence diagnosis with target `none`.
- [x] Routing runs once per incident and only when the current record is still `diagnosed` with a non-empty parsed diagnosis, through `incident.resolution`: a registered project (or a `self`/unregistered finding when the self repository is registered) becomes a discovery Request through `engine.raiseDiscoveryRequest` and the Lead's Ticket flow, a self finding without a registered self project goes to `SelfReports.raise` with its three-state gate and jurisdiction refusal, and an operational or none conclusion creates no Request and no Issue. A route is single-flight per record while it awaits the work item (`concurrent`, HTTP 409) and settlement is a compare-and-swap on the status and `updated_at` captured at route start; a dismissal, recovery or repeat that lands meanwhile makes it `conflict` (HTTP 409), keeps the newer record and reason, and names but never records or deletes any work already created. A failed automatic route leaves the resolution empty so the operator can retry with `confirm: true`; reopening keeps the old diagnosis text but clears the resolution, so that stale text cannot route; a dismissal requires a reason. Human actions audit metadata only (`incident.diagnose`, `incident.dismiss`, `incident.route`) plus the created resolution token, and the diagnose response carries it too.
- [x] `src/app/incidents.ts` exposes the parsed diagnosis on `GET incidents/<id>`, a `dismiss(id, reason)` transition and the filtered `count` behind a list page; `src/app/http.ts` adds the same-origin `POST incidents/:id/diagnose|dismiss|route` routes with 400/404/409 codes and the diagnose audit carrying the created resolution; `src/app/tools/main.ts` registers `orchestrator_incident` (`list|get|diagnose|dismiss|route`) with typed refusals and the filtered list total; `src/app/api.ts` types the new routes; `src/app/runtime.ts` filters diagnosis signals from both the log and the event ingestion paths; the Incidents detail gains Diagnose / Create fix / Dismiss buttons with pending and error states, a localized dismissal reason and links to the created Request or the highlighted Overview draft row, Overview keeps the "needs you" row, and Execution settings gain the diagnosis budget; both locales are updated.
- [x] ADR-0005 records the decision and rejected alternatives; docs/005, 006, 007, 009, 011, 013 and 014, README, README.zh-CN and CHANGELOG are synchronized, and the regenerated `docs/reference/config.md` carries `executor.incidents.diagnoseDailyBudget` while the schema stays 25.
- [x] Verification (M34): 102 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm test` (1700 passed, 5 skipped), `pnpm build`, `pnpm pack:check`, `pnpm docs:check`. Red→green on the unmodified base: `tests/diagnosis.spec.ts` could not resolve `../src/app/diagnosis.ts`, `tests/diagnosis-runtime.spec.ts` failed every test with `ZodError: unrecognized_keys "diagnoseDailyBudget"`, and the new preset row was missing while the import of `DIAGNOSTICIAN_PRESET` was undefined (3 failed files, 7 failed / 2 passed). After implementation `tests/diagnosis.spec.ts` is 18/18, `tests/diagnosis-runtime.spec.ts` 5/5, `tests/bundle-patch.spec.ts` 4/4 and `tests/panel-incidents.spec.tsx` 7/7; detection dispatches nothing synchronously, the same-origin actions audit no diagnosis prose, and the budget and single-flight are pinned across a restart. Round 2 (review fixes): with the ten touched production files (diagnosis.ts, incidents.ts, core/incidents.ts, http.ts, runtime.ts, tools/main.ts, client/overview.tsx, route.ts, incidents.tsx, locales.ts) reverted to edfae49, the new and strengthened regression tests fail 11/57 across `tests/diagnosis.spec.ts` (start overrun not aborted/disposed, dismissal and repeat-count completions not refused, event path not filtered, reopened record route not refused), `tests/diagnosis-runtime.spec.ts` (diagnose audit without the created resolution, tool route on a reopened record, page-length total), `tests/incidents.spec.ts` (missing compare-and-swap and filtered count) and `tests/panel-incidents.spec.tsx` (raw English dismissal, bare Overview link); restored, the same five focused files pass 80/80. Round 3 (review R21 fixes): on b056755 the new tests fail 3/33 (the unregistered project target fell back to a jurisdiction-refused self-report, a second overlapping route hung for the whole test timeout instead of being refused as `concurrent`, and a dismissal during a slow resolve was overwritten by `self-report:sr-1`); restored, the two focused files pass 33/33, and the run above is the whole suite.

### Sprint 43 completion (M35)

The stable supervisor and the versioned domain runtime are now separate processes-in-one: DeepSeek Harness loads `src/index.ts`, which starts `Supervisor`; the supervisor owns the state-directory lock, one process-wide `Logs` ring and `LogFileSink`, configuration validation, version resolution, the crash journal and the drain controller, and it loads a runtime through the frozen `RuntimeHost` API v1. It exposes readiness through `configured()`, `setupProblem()` and `versionStatus()`; health stays the runtime's own `HealthBoard`. The runtime source keeps only type imports from `@deepseek-ai/*`; the live Cordis context (the frozen service channel) and the injected values arrive through the host. ADR-0006 records the contract and the rejected alternatives.

- [x] `src/runtime-host.ts` freezes `hostApi: 1`: the live Cordis context as the DSH service channel, injected DSH values (`Service`, `freezeMessage`, `MessageId`, `ReasoningEffortId`, `scopeParentOf`, schemastery), machine, restart callback, logger, lifetime signal, log ring and sink, state-directory lock release and the ordered `DrainReport`. `src/runtime-entry.ts` exports `createRuntime(host)` returning `{ ready, drain(reason, signal?), dispose() }`.
- [x] `src/app/runtime.ts` takes the host, registers the Cordis `orchestrator` service itself, and drains in the fixed order intake → cancel (a `user` stop with inboxes kept) → a bounded in-flight wait (`DRAIN_IN_FLIGHT_MS`, 10 s; an expired phase is `failed`, later phases still run) → dispose → flush the log sink → close the Store → release the state lock. Only intake/cancel/in-flight may be skipped by an abort signal; dispose, logs, store and lock always run. `completed` is true only when every phase is `done`, and a supervisor that never started reports an incomplete drain while still flushing and releasing. A second drain returns the first report.
- [x] `src/supervisor/versions.ts`, `loader.ts` and `journal.ts` resolve and verify `current.json` (host API, safe relative entry inside `<stateDir>/runtime/<version>/`, SHA-256, schema), fall back to the previous verified version and then to the packaged `lib/runtime-entry.js`, and journal every phase at `<stateDir>/runtime/journal.json` with fsync and rename. The packaged candidate requires the built `lib/runtime-manifest.json` and entry; a source checkout without `pnpm build` logs that discovery failure and still starts a verified deployed version, and only when nothing can start does the error name `pnpm build`. Readiness is bounded (`READY_TIMEOUT_MS`, 30 s) and a hanging runtime is disposed within `DISPOSE_MS` (10 s) and falls back. The supervisor bounds its own log flush (`FLUSH_LOGS_MS`, 10 s) and state-directory lock release (`LOCK_RELEASE_MS`, 10 s), warning and continuing on expiry. Recovery prefers the recorded current, then the previous verified version, then the packaged runtime, and never attempts a schema downgrade.
- [x] `tsdown.config.ts` builds the third ESM entry as a self-contained `lib/runtime-entry.js` (zod bundled, no `@deepseek-ai` runtime import) plus `lib/runtime-manifest.json`; `scripts/check-runtime-bundle.mjs` asserts the invariants and is part of `pnpm check`.
- [x] `tests/supervisor.spec.ts` covers version resolution and every rejection, packaged-manifest failures, loader failures, host-contract freezing through the context channel, the bounded readiness and log-close timeouts with a hanging failed-runtime dispose, the bounded state-directory lock release, one process-wide log ring kept across a failed candidate, a packaged-discovery failure that still starts a verified deployed version, an empty supervisor drain that reports incomplete while releasing, journal recovery (including a failed drain), version swapping and drain idempotence; `tests/runtime.spec.ts` covers the bounded in-flight wait, the incomplete report after an abort, and an abort before the store phase that still closes the Store and releases the lock; `tests/fixtures/host.ts` builds the host for the existing runtime suites, which stay green. Both the supervisor and runtime specs inject a packaged runtime, so they need no built `lib/`, and `pnpm check` builds before it tests.
- [x] ADR-0006 is added; docs/003, 005, 006, 007, 009, 011 and 013, README, README.zh-CN, CHANGELOG and the pack manifest are synchronized. No schema change: schema 25 stays.
- [x] Verification (M35): 103 spec files; `pnpm check` exit 0 from a clean checkout with `lib/` removed — `pnpm typecheck`, `pnpm architecture:check`, `pnpm build`, `pnpm test` (1735 passed, 5 skipped), `pnpm runtime:check`, `pnpm pack:check`, `pnpm docs:check`. `tests/supervisor.spec.ts` is 32/32 and `tests/runtime.spec.ts` 110/110; `lib/runtime-entry.js` is 1,104,852 bytes (SHA-256 `94eafdda1b66a416f498272c764d5ce830a94c3a4e9973cc60e1874aa31bfc86`) and carries host API 1 and schema 25. Red→green evidence: on base e414329 the new spec's imports (`src/supervisor/supervisor.ts`, `src/runtime-entry.ts`), the host contract and `scripts/check-runtime-bundle.mjs` do not exist (`git ls-tree -r e414329` over those paths is empty), so the new spec and the bundle gate are red until this change; the docs tables also failed the docs spec until the new modules and the spec were listed, and now pass with them. Round 2 (review fixes): with production reverted to 261aaab, the new and strengthened tests fail 5/27 in `tests/supervisor.spec.ts` (packaged-runtime manifest errors were not named, `journal.fail` recorded `rollback`, a hanging `ready` took the 30 s timeout instead of the test's 25 ms bound, and a stuck `LogFileSink.close()` was never bounded) and 2/110 in `tests/runtime.spec.ts` (the in-flight wait ignored its bound and an aborted drain still reported complete); restored, the two focused files pass 27/27 and 110/110, and the full `pnpm check` is green. Round 3 (R24): with the tree at tip 1bb731b and `lib/` moved aside, `pnpm exec vitest run tests/runtime.spec.ts tests/supervisor.spec.ts` is 1 failed | 136 passed — `tests/runtime.spec.ts:1641` rejects with `The packaged runtime manifest ... does not exist; run pnpm build ...` instead of `Unsupported orchestrator database version 99`, which is the clean-checkout defect; with the round-3 tests restored and `lib/` still absent the same command is 142/142 (32 supervisor, 110 runtime), proving the packaged seam, and `rm -rf lib && pnpm check` then passes end to end with the build regenerating `lib/` before the tests.
### Sprint 44 completion (M36)

The approved control-plane plan closes with a supported update path: an operator stages a built runtime, the running supervisor swaps to it behind a crash journal and a database backup, and a failed swap or a deliberate rollback returns to the previous verified version without restarting DeepSeek Harness. ADR-0007 records the decision; the operator steps are in docs/006 and docs/013.

- [x] `scripts/stage-runtime.mjs` validates a built `lib/runtime-entry.js` and `lib/runtime-manifest.json` and copies them into `<stateDir>/runtime/<version>/` through a temporary directory and one atomic rename, adding `builtAt` and `node`; it is idempotent for the same bundle and refuses a different one under the same version. `scripts/deploy-runtime.mjs` adds `stage|apply|status|watch|rollback`, one exclusively created `{api:1,id,action,version?,at,by:'operator'}` request under `<stateDir>/updates/` (`wx` + fsync, so a racing writer is refused), strict flag parsing and refusals for a downgrade, a missing or unverified version, a pending request, a claimed request and an already-running version. `pnpm deploy` wraps it, and the new scripts are listed in docs/006 and docs/013.
- [x] `src/supervisor/update-state.ts` owns the strict request parser, the atomic claim by rename to `request.processing.json`, the append-only bounded `runtime/history.jsonl`, the descriptor and pointer writers (including byte-for-byte pointer restore), the SQLite `VACUUM INTO` backup and its WAL-safe restoring copy (copy → fsync → verify → complete-copy marker → remove `-wal`/`-shm` → rename, with `recoverInterruptedRestore` finishing a complete marker or discarding a partial one at boot), the staged descriptor read and `updateSnapshot` (current/previous, journal, pending request, rollback eligibility, deploy commands, recent history, database schema). `src/supervisor/update.ts` runs the journaled `prepare → stage → backup → drain → swap → load → init → commit` state machine on an unref'd 2 s poll, single-flights one request, keeps the state-directory lock, drains the old runtime with reason `update`, and emits `update.staged/applied/rolledback/failed` ring lines. A failure after the backup or swap disposes the candidate with a bound, restores the database backup (only after the copy is verified and published as `<db>.restoring`, then removes the stale `-wal`/`-shm`), restores both pointers and reloads the previous (else packaged) runtime; the journal records `fail('rollback')`, the history an outcome, and nothing is rethrown into the DSH fiber. A crash leaves a running journal and a claim; the next start reconciles both pointers to the journal's recorded baseline before resolving a version (so a candidate written by the swap but never loaded or committed cannot be adopted by the boot after the recovery), finishes an interrupted restore from its complete marker (or discards a partial copy) before reading the schema, clears the claim, appends an `interrupted` entry and never re-runs the swap. `stop()` and an update are mutually safe and idempotent, and `Supervisor.updateStatus()`/`history()` expose the read-only projection.
- [x] `src/app/updates.ts` adds the panel-facing status/attention/rollback service; `src/app/api.ts` types `GET updates` and `POST updates/rollback`; `src/app/http.ts` serves them same-origin (the rollback requires `confirm:'ROLLBACK'`, audits `updates.rollback`, writes one request, answers 409 while pending, claimed or busy, and offers no upload or code-body route); `src/app/runtime.ts` wires the service and the Overview attention. The client adds `src/client/updates.tsx`, the Updates tab between Incidents and Logs, the Overview's pending/failed update link, and both locales. `src/app/incident-detectors.ts` implements the live `update-failures` rule: one record per failed journal phase, recovered by a later success line (`update.applied` or a healed `update.rolledback`).
- [x] `scripts/drill.mjs` runs 16 scenarios against a throwaway state directory — stage+apply the built runtime, rollback round-trip, a simulated crash at each of the eight journaled apply phases (prepare, stage, backup, drain, swap, load, init, commit) with a second boot that must serve the reconciled pointer, a corrupt staged entry, a pending-request storm, a schema downgrade, a failed-init rollback and a schema-bumping crash that must restore the pre-swap database and serve the baseline — and writes `.artifacts/drills/<timestamp>.json` with pass/fail per scenario, exiting non-zero on failure. docs/013 documents the deploy/drill runbook and marks `dsh-tower enable-dev-hmr` / the `cordis.patch.yml` `id: hmr` entry as development-only; production uses the staged swap and a client bundle change still needs a page refresh.
- [x] ADR-0007 is added and ADR-0006 updated (`previous.json` is written by the update path; the `update` operation and `backup` phase); docs/003, 005, 006, 007, 009, 011, 013, README, README.zh-CN and CHANGELOG are synchronized. No schema change: schema 25 stays, `RuntimeHost` stays at API 1, and no dependency is added.
- [x] Verification (M36): 108 spec files; `pnpm check` exit 0 — `pnpm typecheck`, `pnpm architecture:check`, `pnpm build`, `pnpm test` (1775 passed, 5 skipped), `pnpm runtime:check`, `pnpm pack:check`, `pnpm docs:check`. `tests/update.spec.ts` is 20/20 (apply phases, rollback, failed-init restore, downgrade refusal, two-boot crash recovery at `swap` and `init` with pointer reconciliation, a schema-bumping crash that restores the journaled database backup with no restore for a committed journal, a missing backup that fails closed in both journal modes, the WAL-mode variants of the restore — a missing backup whose committed migration stays in the WAL so a second boot still refuses, a successful restore, a complete-marker finish and a partial-copy discard — a truncated backup refused before any sidecar is removed, a committed journal that lost only its history append, the packaged runtime never recorded in `previous.json`, a backup while another connection holds WAL open, real-runtime `drain('update')` and restart, malformed request, stop during drain), `tests/update-surface.spec.ts` 5/5 (including exclusive request creation and a lost create race), `tests/deploy.spec.ts` 9/9, `tests/drill.spec.ts` 1/1 with the 16-scenario report green, `tests/panel-updates.spec.tsx` 4/4, and the extended `tests/http.spec.ts` 20/20 and `tests/incidents.spec.ts` 21/21. A real `pnpm drill` against the built tree reports `{ok:true, counts:{passed:16,failed:0,total:16}}` and `.artifacts/drills/2026-11-11T14-55-27-713Z.json`. `lib/runtime-entry.js` is 1,128,446 bytes (SHA-256 `1cc9b826385a3b1de9d698de16d5700ecaabaf694af25c4418c82f16c83b84ad`), host API 1, schema 25. Red→green evidence on base c448d42 with only the five new specs copied in: `tests/update.spec.ts`, `tests/update-surface.spec.ts`, `tests/deploy.spec.ts` and `tests/drill.spec.ts` cannot resolve `src/supervisor/update-state.ts`, `src/app/updates.ts`, `scripts/deploy-runtime.mjs` and `scripts/drill.mjs`, and `tests/panel-updates.spec.tsx` fails its four tests because the base panel has no Updates tab, the update locale keys are undefined and the Overview has no update attention (5 failed files, 4 failed tests). After the change the same five specs are 24/24; the docs tables failed until the new modules and specs were listed, the locale spec until `updateHostApi` had a Chinese value, and the client/panel specs until their fixtures and tab arrays knew the Updates page. Red→green evidence (R26, review fix): with production `src/supervisor/supervisor.ts` at tip 0d6ddc5 (only that one file reverted, every test and document kept), `pnpm exec vitest run tests/update.spec.ts -t crash` is 2 failed | 8 skipped — both new crash tests read `current.json` as the uncommitted `2.0.0` instead of the recovered `1.0.0`, with no `update.pointers-reconciled` ring line; restored, the same file is 10/10 and the full `pnpm check` is green with the counts above. Red→green evidence (R27, review fix): with production `src/supervisor/supervisor.ts` and `src/supervisor/update.ts` at tip e737091 (only those two files reverted, every test and document kept), `pnpm exec vitest run tests/update.spec.ts` is 4 failed | 11 passed (15) — the schema-bump test dies with `no candidate runtime could be resolved` (the migrated schema 26 database admits no startable runtime), the missing-backup test lacks the `update.database-restore-skipped phase=init` ring line, the committed-history test reads `undefined` because the allowed update history entry was overwritten at startup, and the packaged-baseline test finds `previous.json` holding `{version:'packaged',entry:'packaged.js',…}`; restored, the same file is 15/15 and the full `pnpm check` is green with the counts above. Red→green evidence (R28, review fix): with production `src/supervisor/update-state.ts` and `src/supervisor/supervisor.ts` reverted to tip bcbee2f (only those two files reverted, every test and document kept), `pnpm exec vitest run tests/update.spec.ts` is 4 failed | 16 passed (20) — the WAL missing-backup test loses the `-wal` (`expected false to be true` on `existsSync(orchestrator.sqlite-wal)` after the refused restore, while the main file still reads schema 25, so the second boot would have started the baseline), the complete-marker test dies with `no candidate runtime could be resolved` instead of finishing the restore, the partial-copy test leaves `orchestrator.sqlite.restoring.tmp` on disk, and the truncated backup does not throw, replacing the database before the sidecars are validated; restored, the same file is 20/20 and the full `pnpm check` is green with the counts above.