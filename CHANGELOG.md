# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). While it is a research prototype, `0.x` versions may change
the settings schema and the state database; the upgrade steps in `docs/006-deployment.md` say how to migrate.

## [Unreleased]

### Added

- Project requests (schema 21): `request_create` lets a worker raise a durable project request when its Ticket needs a
  decision, a new deliverable or another project's work, and its completion report names the requests it leaves open
  in `requests`. Project requests bypass the admission gate and grant no wider authority than the Lead already owns.
  The project Lead answers through `lead_requests`, `lead_request_decide`, `lead_request_reply`,
  `lead_request_complete`, `lead_request_approval` and `lead_request_approve`; every disposition carries a non-empty
  reply delivered to the raising Session, an unanswered request is reminded twice and then recorded as needing
  attention, and an accepted work request creates the ordinary Request and its staged Tickets under a Lead Mandate
  confined to that project. A rejected or `needs-info` request records the answer and changes nothing else.

- The project-request report and approval flow: a root request is closed with one aggregate report on the Channels its
  chain started from, listing every Ticket, its pull-request outcome and every derived request; an architecture
  request first creates a design Ticket, sends the proposal to the root Thread, and creates the implementation Request
  and Tickets only after `lead_request_approve` records a person's approval written after the proposal. An explicit
  whitelisted @ mention or direct message now receives one notice when Eval ignores it, finds it unavailable or stops
  it. An independent DSH Session can submit work through the `session` Source kind and the global `superagent_submit`
  tool; every outcome is answered on that Session, and a completed Request reports back to it.

- A Ticket deliverable contract (schema 22): `deliverable` is `change` or `answer`. A change Ticket ends only through
  the pull requests it names or follows: its ready report without a pull request is refused with
  `changeNeedsPullRequest`, records the pull request it names, and it is prepared in its own branch. An answer Ticket
  reads the project's live checkout read-only — no branch, worktree, prepare command or write access — and its ready
  report ends it as `completed`, shown as Answered. The accept names the deliverable (`deliverable` defaults to
  `change`; only a change requires `worktree_name`). Migration to schema 22 records `change` for open Tickets and for
  ended Tickets with a followed pull request, and `answer` for any other ended Ticket.

- Lead-raised project requests from automation deliveries (docs/012 D11): a project-scope automation delivery is a
  standing instruction, not a Source Trigger, so the Lead may raise one work project request for its own project with
  `lead_request_create` (recording the `automation` id from the delivery marker) and decide it with
  `lead_request_decide`. Accepting a request without a root Trigger now creates the ordinary Request and its Tickets
  through `Tickets.createLead`, with empty Channels and a `dsh-superagent:lead:<project>` Mandate actor; a rootless
  architecture accept still refuses because the human approval needs the root Thread. The report-only rule permits
  exactly that project request and no other project write, and the panel's Lead row shows the pending count and how
  many came from automations.

- Installation-level self-bootstrap (docs/012 D12): `orchestrator_request_create` lets the main Session turn an
  installation automation delivery's findings into one rootless Request with one Ticket per registered delivery unit.
  The tool requires an existing `installation`-scope automation (project findings stay with their Lead), records the
  automation id as the Mandate's provenance (`basis.via = 'installation'`, actor `dsh-superagent:installation`), returns
  the open Request for a repeated raise, and creates no Channels; revalidation trusts the installation basis. The
  delivery's write budget remains the Request it creates.

- Lead escalation (docs/012 D13): `lead_request_escalate` lets a project Lead escalate work that belongs outside its
  project; `orchestrator_escalations` and `orchestrator_escalation_decide` let the Orchestrator answer with the
  mandatory reply and, on accept, create one installation-level Request under an escalation Mandate. Reject and
  needs-info create no work; the decision is recorded as a durable notice for the source project's Lead.

- Manual run and delete for installation- and project-scope automation tasks: `automation_run` asks the Host's `schedule`
  service to deliver one run now without moving the scheduled occurrence and reports a pending execution as a conflict;
  `automation_delete` removes the Host task, the record and its whole delivery history on an explicit human request. Both
  are available from the Automations page (`Run now`, and `Delete` behind a confirmation dialog), through
  `POST /orchestrator/api/automations/:id/run` and `DELETE /orchestrator/api/automations/:id`, and in the main Session's
  tool list (six automation tools). A Host refusal to run or delete keeps the record and is reported; deleting an already
  missing Host task is fine.

- GitHub Issue and pull request labels for the main Session: `orchestrator_label` adds or removes labels the repository
  already defines on the work a Trigger names, through the new `SourceKind.labels` contract and its GitHub adapter. It
  never creates, renames or deletes labels, and it changes nothing else about the Issue.

- Issue and pull request triage as a built-in rule, and Feishu delivery of a design decision document: the new
  `triage` rule classifies an Issue or pull request, suggests severity, priority and assignment, and applies only
  labels that already exist when the operator explicitly asks it to; `src/sources/feishu-file.ts` and the main
  Session's `orchestrator_send_file` tool deliver an existing file inside a registered project's workspace to a
  Feishu chat (the file's directory is the CLI working directory, and the idempotency key hashes the chat and file),
  so a manager who is away from the machine can review a decision document. The resolver refuses absolute, parent,
  dot and repeated-separator paths, directories and missing files.

### Changed

- The built-in accept rule set now has sixteen categories: `settings` (更改 SuperAgent 配置), `automation`
  (项目 dsh 自动化任务), `deps` (依赖与工具链升级), `pr-feedback` (审查意见修复), `design` (方案设计与架构决策) and
  `triage` (Issue/PR 分流) join the existing ten, and every built-in rule ships enabled instead of only `copy` and
  `visual`. A large or cross-project refactor first produces a staged plan and rollback points under `design`, and the
  cross-project part becomes a Request. Existing installations whose stored rules are still exactly the 0.3.0 ten-rule
  defaults, the earlier twelve-category defaults or the earlier fifteen-category defaults are upgraded to the all-enabled
  sixteen-rule set when settings are read; operator-edited, renamed, added or removed rules are preserved.

### Fixed
- Trigger IDs for GitHub Issues, pull requests, comments and CI are scoped by repository, so an Issue in one project whose number another project already used is no longer dropped as a duplicate by the intake; the deployment's repository keeps its stored number-only IDs.

- A GitHub repository stream could skip an item and then stay blind to it: the read saved the listing's ETag even when it
  took nothing in, and every later conditional read was answered 304. A stream now saves an ETag only when the read
  skipped no item, trusts it for at most ten minutes before one unconditional read confirms the list again, and the first
  start after this upgrade drops saved stream ETags once so a list that was skipped earlier is read in full again. This
  is how an Issue filed in the project's own repository was listed by the poller but never became a Trigger.


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
