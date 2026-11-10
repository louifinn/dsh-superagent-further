# dsh-superagent-further

[![check](https://github.com/louifinn/dsh-superagent-further/actions/workflows/check.yml/badge.svg)](https://github.com/louifinn/dsh-superagent-further/actions/workflows/check.yml)
[![smoke](https://github.com/louifinn/dsh-superagent-further/actions/workflows/smoke.yml/badge.svg)](https://github.com/louifinn/dsh-superagent-further/actions/workflows/smoke.yml)

[English](README.md) | [简体中文](README.zh-CN.md)

> **This is a fork, not an official DeepSeek product.** It is built on
> [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), the research
> prototype published with *Exploring Super-agent Design: Towards a More Autonomous Agent System*. The prototype
> is research code: a single repository, a single host, POSIX-only deployment, and no CI. This fork
> (`louifinn/dsh-superagent-further`) keeps its design and turns it into software a team can run every day:
> several projects, a project-level orchestrator layer, native Windows, installable releases, and checks that
> run on all three platforms. It remains operator tooling, not a managed service: read
> [the philosophy](docs/000-philosophy.md) and [the deployment guide](docs/006-deployment.md) before you leave
> it running unattended.

dsh-superagent-further is a proactive coding agent for the repositories your team works in, packaged as a bundle for
[DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When a
person the team allowed asks it for work, it opens a Request and the Tickets that deliver it, works each Ticket
in its own Session and checkout, and answers in the original conversation — usually with a pull request a person
merges. A web panel lists only what waits for a person.

The principle it is engineered around: **take as little human attention as possible, and give as much value as
possible.** Every message, setting, panel row and document has to earn the attention it costs. That principle is
unchanged from the prototype; this fork extends it to the project layer, operations and distribution (see
[What this fork changes](#what-this-fork-changes-relative-to-the-prototype) and
[Product philosophy, extended](#product-philosophy-extended)).

## Status at a glance

| | |
| --- | --- |
| Runs on | Windows 10/11 natively (desktop app or `scripts\dsh-superagent-further.cmd`), Linux (WSL verified, CI), macOS (CI + smoke host) |
| Requires | Node.js `^22.19.0 || >=24`, pnpm `11.7.0`, git 2.32+, DeepSeek Harness `0.2.2-rc.1` (pinned in [006](docs/006-deployment.md)); no Python, no tmux |
| Checks | `pnpm check`: 89 spec files, **1507 passed / 5 skipped (1512)**, typecheck, build, a pack check of the published tarball and a check that the generated reference pages are current; check.yml green on six platform/Node combinations on every push |
| Release | `0.3.0` ([CHANGELOG](CHANGELOG.md)); a `v*` tag runs the checks, packs `dsh-superagent-further-0.3.0.tgz`, and publishes it |
| Live proof | real GitHub and Feishu requests end as merged pull requests; a project Lead executed as a hidden child Session; a cross-project Request produced two Tickets, two PRs and one `done` result |
| Project requests | a worker raises a durable `project_request` when its Ticket needs a decision, a new deliverable or another project's work; its project Lead must reply and disposes it, an accepted work request creates a Request and staged Tickets confined to the project, an architecture request waits for a person's recorded approval, an independent DSH Session can submit work and always receives an answer, a project automation delivery may raise one project request through its Lead, an installation automation delivery may create an installation Request from the main Session, and a Lead may escalate work outside its project for the Orchestrator to decide |
| State schema | 22 (`10 → 11 → … → 21 → 22` migrate in place; `scripts/verify-install` reports the schema read-only) |

## What it does

1. **Listens.** A Source reads GitHub (Issue and PR conversations, reviews, mentions, CI results) and, if
   configured, Feishu (an `@DSH` mention in a listed group, a direct message, history backfill, and a daily
   digest). Sources report their state, the next attempt, and their last failure.
2. **Decides.** An event becomes a Trigger only when it addresses the agent and comes from a person the team
   allowed. The main Session evaluates a Trigger as data, never as instructions; acceptance needs an explicit
   request or a written rule the team configured.
3. **Accepts.** Accepted work becomes a **Request** — the human ask — and one or more **Tickets**, one per
   delivery unit and per project. The Request carries the acknowledgement and the final result; each Ticket
   carries its deliverable contract, Lead and executor, plus its checkout and pull request when the work is a
   change. A Ticket that no registered project can own is refused
   at acceptance with a pointer to **Execution → Projects**.
4. **Executes.** A `change` Ticket gets a worktree from its project's local clone; an `answer` Ticket reads that
   live clone read-only. Both run as a hidden subagent of the project's **Lead** Session. Inputs, status requests
   and reports pass through the Lead, and a person may also talk to the Lead directly.
5. **Delivers.** For a `change` Ticket the worker opens a pull request and reports it; a person reviews and merges,
   the Source observes the merge, the Ticket ends `merged`, and the Request reports one result. For an `answer`
   Ticket the ready report is the deliverable and ends the Ticket as `completed`. Failures stay visible: health, the
   reply queue, the outbox and the log all name what is stuck and what the operator can do next.

## Quick start

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent-further with me.

It asks one short question at a time, shows the plan once, and installs and configures everything. The manual
reference — Accounts, Projects, Execution, Sources, hosting, upgrading and troubleshooting — is
[docs/006-deployment.md](docs/006-deployment.md). In short:

1. Install DeepSeek Harness `0.2.2-rc.1` and this bundle into a profile, from a checkout or from a release
   tarball: `dsh plugin --profile superagent add "link:<checkout>"` or
   `dsh plugin --profile superagent add "file:<tarball>"`.
2. Write the profile's `cordis.patch.yml` with a loopback `webserver` port, the `stateDir`, and the Feishu plugin
   when you use it.
3. Register **Projects** in the panel: id, absolute path of a local clone, `owner/name` repository, optional base
   branch. A project is required to start; onboarding refuses without one.
4. Start the host (`scripts\dsh-superagent-further.cmd start` on Windows, `scripts/dsh-superagent-further start` elsewhere),
   open the panel URL from the log, and sign in with the token.
5. Run `scripts/verify-install` (`.cmd` on Windows): it checks the DSH version, the profile, the patch, the API,
   the owner of the state lock and the database schema, and exits `0` only when the installation is ready.
6. Configure the **GitHub** and **Feishu** Sources with the CLI wrappers from 006, put allowed accounts in
   **Policy**, and send one test message.

## The project layer

The prototype had one main Session that started one root worker Session per Ticket. With several projects that
makes the session list grow with work and leaves project-level labour in the total Orchestrator. This fork adds one
level:

```text
Orchestrator (main Session, `orchestrator-<hash>`)
└── Lead per project (persistent Session, `lead-<projectId>`)          visible in the session list
    └── executors as hidden subagents (durable DSH Sessions, `worker-<ticketId>`)
```

- The **Orchestrator** keeps Sources, Eval, admission, Policy and cross-project priority. It creates cross-project
  Requests and Tickets and dispatches Tickets to Leads; a project's Lead disposes its own project requests and never
  takes cross-project work.
- A **Lead** owns one project: its context, its Session and the executors that run as its children. It carries the
  project's clone, repository and base branch in its prompt, receives each dispatched Ticket, and exposes
  `lead_status` plus the project-request tools. It answers the requests its workers raise with mandatory replies,
  creates the project's Tickets only by accepting those requests, carries architecture work through a person's
  approval, and never changes Policy or settings. A person can open it from the panel and write to it directly;
  that is the project's highest-priority human input.
- Executors are subagents of their Lead. They keep their own Session, checkout and worker preset, but they do not
  appear in the ordinary session list; the Lead is their parent, reports settle through it, and input reaches them
  through it instead of prompting a Session the Lead owns. Sessions are recovered after a restart and children are
  adopted or the Ticket is redispatched.

Communication is durable sqlite records; effects only deliver them. There is no second message bus and no shared
task board, because the Engine is the only writer of domain state. Two hosts cannot share one state directory: the
in-application instance and the service script refuse each other with a message naming the lock owner and the one
command that switches. Inside the daily desktop application the worker environment is applied process-wide, which
is documented in 006 because it changes `PATH` and `GIT_CONFIG_GLOBAL` for every Session in that app.

## Projects and cross-project requests

A **Project** is a record — `{id, name, workspace, repository, branch}` — stored in the Execution settings. Adding
one does three things: the GitHub Source starts polling its repository (Thread ids for non-deployment repositories
are qualified as `owner/name#<number>`, so repositories never collide), Tickets for it get their own worktree under
`<stateDir>/work/<project>/`, and the panel, digest and Lead rows can name it. Repositories the agent cannot read are
reported in the Source health instead of failing the poll round.

A request that spans projects is still **one commitment to one person**. Its acceptance may name delivery units; the
Orchestrator creates one Request and one Ticket per unit (each with one project), plus simple `after` edges between
Tickets. Tickets without unmet dependencies start immediately; both serial and parallel deliveries fall out of the
edges. The Request produces the single acknowledgement, the single final result listing the pull requests, and the
single `done` / `partial` / `stopped` state; the daily digest names Requests in flight. One Ticket still gets one
executor: parallelism between projects is expressed by several Tickets, not by several executors inside one Ticket.
That direction was settled on 2026-11-08 and the analysis for a later segmented fan-out is kept in
[010](docs/010-project-orchestrator.md) as a future option, not as pending work.

## What this fork changes relative to the prototype

The prototype is a faithful research artifact for one repository, one POSIX host and a single human operator. This
fork keeps its domain model and philosophy; it changes what daily use demands: platforms, several projects, an
execution hierarchy, operations, evidence and distribution. The diff against the prototype's only commit
(`8c32a9d`) is **232 files, +21,672 / −1,604** at the current head (the first release on this line was `0.2.0`), and
the local history started from a byte-identical import, so every change below was made by this fork.

| Area | Prototype | This fork | Why |
| --- | --- | --- | --- |
| Platforms | macOS/Linux, POSIX shell script with Python, `tmux`, `fcntl`, `ps` | Windows-native Node service script; Windows batch/CLI handling, `pwsh` shell, `icacls` state ACLs; Linux and macOS kept | The operator's daily machine is Windows; a second dependency set is attention the tool does not earn |
| Scale | One repository, one host, one state dir | Many projects polled by one Source, per-project checkouts and Leads, per-project concurrency; one host at a time enforced | Teams work in several repositories; a second profile or a second agent would be more concepts and more noise |
| Execution | Root worker Session per Ticket | Orchestrator → persistent Lead per project → hidden executor subagents, adoption after restart | Cleaner Session list, project context that persists, and a total Orchestrator free of project labour |
| Cross-project work | One accepted request = one Ticket, one directory | Request above Tickets, one Ticket per delivery unit, `after` edges, one acknowledgement/result/done | A single Ticket cannot legitimately span projects; the person still made one request |
| Deliverable contract | A Ticket was implicitly one delivery: a ready report ended it as completed whether or not a pull request existed | Each Ticket carries `deliverable: change` or `answer`; `change` gets a branch and worktree and ends only through a followed pull request (its ready report names the PR), `answer` reads the project's live checkout read-only and ends as `completed` | Answer-only work should not pay for a branch it can never merge, and a change that never opened a PR must not report success |
| Agent-raised work | Work entered only from a Source event accepted under the person's Policy | Workers, project Leads, installation automations and independent DSH Sessions can raise work as durable requests; every path records its origin, must reply, and cannot bypass Policy or admission | The agent must be able to start work it discovers without turning its own report into authority |
| State | Exact schema only, no forward migration | Stepwise migrations `10 → 11 → … → 22`, read-only schema check, upgrade and rollback steps | State must survive upgrades if it is to be left running |
| Documentation | Numbered design docs only (000–008) | Adds [009 Roadmap](docs/009-roadmap.md), [010 Project-level orchestrator](docs/010-project-orchestrator.md), [011 Capabilities](docs/011-capabilities.md), [012 Project requests](docs/012-project-requests.md), this README, `AGENTS.md`, and engineering-skills scaffolding under [docs/agents](docs/agents/domain.md) | The fork's decisions and their reasons must be readable without the interview that produced them |
| Operations | Start/stop via POSIX `ps`/`tmux`, no self-check | Node service script with CIM discovery, graceful `POST /orchestrator/api/shutdown`, `verify-install`, `switch-project`, worktree reclaim and `clean-worktrees`, bounded logs | Unattended use needs visible, scriptable operations on every platform |
| Observability | One health word per component | `nextAt` for polling Sources, consecutive failure counts, reply queue with oldest wait and next attempt, waiting-Ticket action and age, Request rows, group daily digest | "Every failure visible" means an operator can see the trend, not only the state |
| Trust | Trigger-field trust left as an open question | Trusted vs untrusted fields documented and pinned by `tests/trust.spec.ts`; bodies cannot change roles, tools, Policy or strength; owner-only state ACLs; batch-argument guard | Prompt injection and shared-machine data are real once a second person or project exists |
| Engineering | No CI, no release, no changelog; tests assumed POSIX | `check.yml` (3 OS × Node 22/24), `smoke.yml` (real macOS host), `release.yml` (tagged tarball), `.gitattributes`, semver/CHANGELOG, reproducible `verify-install` | Platform regressions and unverifiable installs are exactly the failures a daily tool cannot afford |

### Platforms and deployment

Every POSIX assumption was replaced with an explicit, tested platform path rather than a shim:

- **Paths** — one platform rule (`src/infra/paths.ts`) feeds the schemas; `stateDir` and project workspaces are
  absolute on both families, and the test that used to assume `/` now runs a Windows branch with real `C:\` paths.
- **The service script** — `scripts/dsh-superagent-further` is a dependency-free Node program, with a `.cmd` launcher. It
  discovers the host through `Get-CimInstance Win32_Process` on Windows (fallback `ps` on POSIX), starts it detached
  with its output in the log, and stops it through the shutdown route with a `taskkill` tree fallback. It no longer
  needs Python, tmux or `fcntl`; it locks with an exclusive file and a dead-PID takeover.
- **Batch-file CLIs** — `gh.cmd`, `lark-cli.cmd` and wrapper `.cmd` files cannot be started by `spawn`/`execFile`
  with an argument array on Windows. A single invocation module (`src/infra/batch.ts`) builds a `cmd.exe /d /s /c`
  command line with `windowsVerbatimArguments`, refuses an argument that names a variable in the child's
  environment or contains a line break, and passes multi-line bodies over stdin instead of the command line.
- **Worker environment** — POSIX extension-less `#!/bin/sh` shims became `<name>.cmd` shims that strip the shim
  directory from `PATH`, and credential-helper comparison is realpath/case-aware. `git -c -z --show-origin` parsing
  ended a false "git too old" result.
- **Shell tools** — the main Session gets `pwsh` on Windows and `bash` elsewhere; executors' prepare command does
  the same. A `POST /orchestrator/api/shutdown` route was added because Windows cannot deliver a graceful signal to a
  detached host.
- **State permissions** — POSIX modes stay 0700/0600; on Windows an inherited-ACL-free `icacls` grant gives only the
  operator's account access.
- **Verification** — Linux is exercised in WSL and on CI, macOS on CI plus a real `smoke.yml` host, and Windows
  locally and on CI, including batch/ACL tests that only run there. `scripts/verify-install` checks the installation
  in either host mode and exits `0/1/2` for ready / broken / waiting for setup.

### The project model and the Source

The prototype's GitHub Source addressed one `repository` and one worker directory. This fork makes the project a
first-class record on the management surface and derives the Source's work from it. One poll round reads
notifications once and filters them to the watched set, then reads every project repository's streams and default
branch CI, then the PRs of open Tickets and subscribed Threads. Thread identity keeps the prototype's numeric form for
the primary repository and qualifies other repositories, so stored Threads and Tickets need no rename. A project
repository the agent cannot read is tolerated and reported, rather than failing the round. The panel Source card lists
every watched repository and updates when projects change — the second defect the operator reported when opening the
project layer.

### The Project Lead

The Lead is the fork's main architectural addition, and it is deliberately a **layer**, not a new domain concept: the
domain still has Sources, Threads, Triggers, Tickets, Assignments, Reports and Attentions. A Lead is a durable Session
bound to one project, with (1) its own prompt section carrying the project's clone, repository and base branch,
(2) the preset tools it uses to reach and message its child executors — an executor's input is delivered
through it, not by prompting a Session it owns — (3) `lead_status` and the project-request tools
(`lead_requests`, `lead_request_create`, `lead_request_decide`, `lead_request_reply`, `lead_request_complete`,
`lead_request_approval`, `lead_request_approve`, `lead_request_escalate`), (4) dispatch records in `lead_message`,
schema 13, and
(5) no way to change Policy or settings.
Accepted work reaches it as a dispatched Ticket; the worker is its hidden child. A worker raises a project request
when its Ticket needs a decision, a new deliverable or another project's work, and the Lead must answer it. The panel
shows one row per project (Lead Session, running executors, waiting messages) and opens the Lead when a person clicks
it. Lead-hosted input and report routing were the P3 work; removing the root worker path was P4, finished on
2026-11-08, so onboarding now requires a project and there is one execution path. Project requests and their
approval flow are Part E of [011](docs/011-capabilities.md), specified in [012](docs/012-project-requests.md).

### Requests above Tickets

The prototype's Ticket is the unit of authorized work and one delivery. It stays that way. A Request is the accepted
human ask that may need several deliveries: it holds the Ticket ids, the single acknowledgement and the single final
result. The Orchestrator creates cross-project Tickets; a Lead creates a project's Tickets only by accepting one of
its workers' project requests, and every such Ticket is confined to that project. Dependencies are simple
`after` edges, not a workflow engine, because the philosophy does not add a concept for a business need that an
attribute plus a prompt can express. The live proof: one GitHub request created Request `90df28d6…` with two Tickets
in `louifinn/project-check` and `louifinn/Napkid-Derivate`; PR #18 and PR #12 merged at `00:09Z`, and the Request
ended `done` at `00:10:25Z`, reporting both pull requests once.

A project request is the upward path for a worker. It is a durable record, not a Ticket or a Trigger, so it bypasses
the admission gate and the Policy; accepting it creates an ordinary Request and its staged Tickets under a Mandate
whose basis is `lead`, with explicit strength and the project as its boundary. Rejecting or asking for more
information records the reply and changes nothing else. An unanswered request is reminded twice and then recorded as
needing attention, and the Lead closes a root request with one aggregate report on the channel the chain started
from. Architecture requests take one extra step: a design Ticket produces a proposal, a person approves it on the
root Thread, and only then does the implementation Request exist. An independent DSH Session can also submit work
through the `session` Source and always receives an answer. Automation deliveries extend the same upwards path: the
main Session turns an installation automation delivery into an installation Request (`orchestrator_request_create`),
and a Lead escalates work outside its project for the Orchestrator to decide (`lead_request_escalate` →
`orchestrator_escalations` → `orchestrator_escalation_decide`), whose reply goes back to the Lead and whose acceptance
creates the installation Request with `escalation` provenance.

### Operations, state and recovery

- **Migrations** — schemas 11–22 reshape records, fill Ticket projects, add Lead messages, add Requests, end
  Requests of already-ended Tickets, add the cross-Session memory table, remove the retired GitHub `repository`
  setting, add the settings-proposal, automation, automation-delivery and project-request tables, and write every
  Ticket's deliverable contract (`change` for open Tickets and for an ended Ticket with a followed pull request,
  `answer` otherwise). Each step runs in the opening
  transaction; `OLDEST_SCHEMA` and `verify-install` make an out-of-date or
  too-new database visible instead of mysterious.
- **One host** — the state lock message names the other host, its state directory and the switch command; an
  orchestrator Session held by a live DeepSeek Harness process is explained instead of retried forever. The in-app
  host applies the worker environment process-wide, which 006 states plainly because it changes who `gh` is in every
  Session of that application.
- **Checkouts** — a `change` Ticket gets a worktree and an `agent/` branch from its project clone; an `answer` Ticket
  reads the project's live clone under a read-only permission preset and opens no branch. Finished worktrees are
  reclaimed after `worktreeKeepDays` (default 7) by the host every six hours, and `scripts/clean-worktrees` previews
  or applies the same rule for an operator. Disk growth is a failure mode, so it is automated.
- **Retries** — the outbox retries with backoff and exposes attempts, the reply queue shows the oldest wait and the
  next attempt, and a source reports when it will poll again. A silent retry loop is treated as a bug.
- **Upgrade and rollback** — five documented steps, a backup of `orchestrator.sqlite` with `-wal`/`-shm`, and a
  rollback that restores it and re-runs `verify-install`; the daily path needs no backup unless the schema advanced.

### Trust, safety and the worker environment

The prototype left "which Trigger fields are trusted" as an open question. This fork answers it and pins the answer:
source, thread, actor id, `human`, `addressed`, channel, time, URL, the receiving scope and declared routing metadata
are trusted; message text, titles, bodies, comments, files, images, names and quoted links are not. No untrusted field
can change a role, tool list, Policy, allow list or request strength. `tests/trust.spec.ts` checks both halves and the
prompt statements; prompt-injection text cannot widen the allow list. On the machine side, the state database and
directory are owner-only, the agent runs under its own GitHub and Feishu credentials, and the worker environment is
scoped and documented. Credentials are still broader than ideal *by the operator's explicit decision* (a classic
`louibot` token and the current Feishu secret); 006 records where each lives and how to rotate it. Start with a short
allow list and a test repository, as the responsibility section of the philosophy asks.

### Engineering and distribution

`pnpm check` is the single check: typecheck, 89 spec files, a tsdown build, `scripts/check-pack.mjs` over the tarball npm
would publish, and `docs:check` over the generated reference. CI runs it on Ubuntu, macOS and
Windows with Node 22 and 24 (six combinations), `smoke.yml` starts a real host on macOS, and `release.yml` packs the
bundle and attaches it to a GitHub release. The suite is 1512 tests; it drives real timers and SQLite, so timeouts are
30 s per test and hook, and ten consecutive runs next to a concurrent Linux suite are part of the evidence behind the
fork. The docs are tested too: [tests/docs.spec.ts](tests/docs.spec.ts) enforces numbered-document order and that 007
lists every source file and spec; `tests/surface.spec.ts` asserts the mounted tool, skill and preset surface, and
`tests/properties.spec.ts` drives the gate, identity and migration invariants from seeded generators. The reference
pages under [docs/reference](docs/reference/tools.md) are generated from the code by `pnpm docs:generate` and compared
by `pnpm docs:check`, so they cannot drift. The bundle keeps its config shape and CLI-facing behaviour; 0.3.0 renamed the package
and every registration id to `dsh-superagent-further`, so an existing profile follows the migration steps in 006.
Additions are additive settings and panel rows, with a `CHANGELOG` and semver.

### What did not change

The domain model and vocabulary (Source, Thread, Trigger, admission, Ticket, Assignment, Report, Attention, Mandate,
Policy), the Engine as the only writer with effects/relay/notice delivery, prompt composition and the numbered
documents 000–008, the `dsh-superagent-further` bundle layout, and the operator-facing promise that the agent acts only when
asked or allowed and speaks only when someone must act. A migration from a prototype installation keeps its Tickets,
Threads, decisions and ended state; upgrade steps are in 006.

## Product philosophy, extended

The original principle stands: **take as little human attention as possible, and give as much value as possible.**
Daily use sharpened five things without adding a top-level concept:

1. **The project is the unit of delegation.** The prototype required one installation per repository. A team's work is
   organised by project, so a project became a record with a local clone, a repository and a base branch — and the
   Lead made it the unit a persistent Session owns.
2. **A Lead is a boundary of context, not a new kind of work.** The Orchestrator should not carry project labour, and
   an executor should not have to know the department. One persistent Session per project gives the first a place to
   delegate to and the second a parent with context, while the domain keeps only its existing concepts.
3. **The Request is the promise to the person.** People make requests, not Tickets. When one request needs several
   deliveries, the Request keeps one acknowledgement, one result and one done state — otherwise the person must
   assemble the outcome from internal rows, which is attention the tool created.
4. **Refuse instead of guess.** With several projects, silently choosing a repository is worse than refusing: an
   unowned request is refused at acceptance and points at **Execution → Projects**, and onboarding requires a project.
   The prototype's implicit single-repository fallback was a convenience that no longer has one correct answer.
5. **Operations are part of the product.** A tool left running for weeks is judged by its migrations, upgrades,
   self-checks, log bounds, worktree reclamation, one-host rule and visible retry state, not only by its agent loop.
   That is why this fork invests in `verify-install`, schemas, CI, smoke hosts and a release tarball.

Deliberately *not* added: a second durable bus or shared board (sqlite records plus effects already deliver, and a
second source of truth costs attention), a workflow engine for dependencies (simple `after` edges are an attribute),
several executors inside one Ticket (settled 2026-11-08 — one Ticket, one executor; cross-project parallelism is
several Tickets), and a new page for every new concept (the overview lists Requests, Leads and waiting Tickets; a
healthy state takes no space).

## Architecture at a glance

```text
src/
  sources/          GitHub, Feishu and session adapters: poll, intake, threads, triggers, channels, digest
  app/              runtime, management API, panel views, settings, setup, store, migrations, Lead records,
                    project requests, Request notices, worktree reclaim
  core/             domain model and Engine: admission, tickets, assignments, reports, decisions, effects
  executor/         DshExecutor: launches, deliveries, slots, Lead dispatch, work/dispatch preparation
  infra/            worker environment, shims, command execution, paths, ACLs, batch-file CLIs
  client/           the web panel (React) with zh/en text
scripts/            dsh-superagent-further(.cmd), verify-install(.cmd), switch-project, clean-worktrees(.cmd)
prompts/            the agent prompts, including the Lead's
docs/               numbered design documents, roadmap, orchestrator, and engineering-skills notes
```

A request's data path is: Source → Trigger (with its trusted metadata) → admission and Eval → Decision → Request and
Tickets → dispatch to a Lead → executor subagent → pull request → merge observed by the Source → Ticket ended →
Request result and notices. The Engine writes the records; effects deliver acknowledgements, replies, notices and
state changes; the panel reads projections and never writes domain state.

## Documentation

Read the numbered documents in order; each builds only on the ones before it. The README is the overview; the
manual for a running installation is 006.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): accounts, projects, hosting, upgrades, troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Roadmap](docs/009-roadmap.md): from research prototype to daily use, and what the fork has landed
- [010 Project-level orchestrator](docs/010-project-orchestrator.md): the Orchestrator → Lead → Worker design and its
  decisions
- [011 Capabilities](docs/011-capabilities.md): the decision record for labels, file delivery, project requests,
  installation self-bootstrap and Lead escalation
- [012 Project requests](docs/012-project-requests.md): the design of project requests, escalations and installation work
- [Tool reference](docs/reference/tools.md): generated from the tool factories the model sees
- [Settings reference](docs/reference/config.md): the generated JSON Schema of the settings blocks
- [AGENTS.md](AGENTS.md): instructions for coding agents working in this repository
- [docs/agents/domain.md](docs/agents/domain.md): the engineering-skills scaffolding used with coding agents

## Development

```bash
pnpm install --frozen-lockfile
pnpm check        # typecheck + tests + build
```

- Node.js 22.19+ or 24+, pnpm 11.7.0 (the `packageManager` field). The state database and tests use `node:sqlite`.
- CI (`.github/workflows/check.yml`) runs the same command on Linux, macOS and Windows with Node 22 and 24, so the
  Windows-only paths (batch-file CLIs, ACLs, the service script) run on every push. `.github/workflows/smoke.yml`
  starts a real host on macOS; `.github/workflows/release.yml` runs on a `v*` tag.
- Linux can be exercised in WSL with Node 22 and pnpm 11.7.0; CI runs it on every push. On Windows, the service
  script is `scripts\dsh-superagent-further.cmd` and the panel token is in the newest `.artifacts/dsh-superagent-further-*.log`.
- Adding a Source is documented in [008](docs/008-cookbook.md); a new source file and spec must be added to the tables
  in 007, because `tests/docs.spec.ts` enforces it.
- Documentation-only changes skip `check.yml` and `smoke.yml` (`paths-ignore`), so run
  `pnpm vitest run tests/docs.spec.ts` locally before pushing docs.

## Known limits and next steps

- **macOS has CI and a smoke host, but no hand-run of the visible panel.** The release check in 006 keeps that step
  for a person; screenshots are captured at release time and are deliberately not committed, because they show the
  operator's real workspace and account names.
- **One host per state directory.** The in-app host and the service script are mutually exclusive; the guard names the
  other host and 006 documents the switch. A second profile (or `scripts/switch-project`) is the current way to have
  two projects hosted separately.
- **Credentials are broader than ideal by operator decision** (classic `louibot` token, current Feishu secret). The
  upgrade path to a fine-grained token limited to the test repositories is recorded in 006 and 009 but not enforced.
- **A project is now required to start.** A fresh installation reports `projectUnset` until one is registered, and
  an accepted request that no project can own is refused — by design, with a pointer to the page.
- **One executor per Ticket.** Multi-executor fan-out inside a Ticket stays a future option; cross-project and
  multi-deliverable work is handled by Requests with several Tickets instead.
- **The 5 skipped tests on Windows are POSIX-only branches** (the deployment setup fake shell, POSIX file modes,
  and the POSIX store check) with no Windows equivalent; their Windows counterparts run in their place, and each
  skip is a commented `skipIf`, not a deleted test.
- The long-term order of remaining work, with acceptance criteria and evidence, is [009 Roadmap](docs/009-roadmap.md).

## License

[MIT](LICENSE). This fork keeps the prototype's license and attribution: the original design and code come from
DeepSeek's `dsh-superagent-prototype`; the changes described above are maintained in
`louifinn/dsh-superagent-further`.
