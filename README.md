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

## Overview

dsh-superagent-further is a self-hosted engineering agent that lives in the repositories and chats where your team already works. Install it as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/), register one or more projects, and it watches the places you ask for help: GitHub issues, pull requests, reviews and CI results, and — if you configure it — Feishu mentions and direct messages.

When someone the team allows asks for something, the agent decides whether the request is in scope under your rules, accepts it as a Request, works each Ticket in an isolated checkout, and answers in the original conversation — usually with a pull request you review and merge. Answers to questions and reviews come back in the same thread. A project Lead session keeps each project's context and can hand work to workers, escalate cross-project decisions to the Orchestrator, and wait for your recorded approval before architecture work moves ahead.

Use it to:

- turn an issue, review comment or chat request into a reviewed pull request;
- have an agent investigate, review or explain code and answer where you asked;
- keep several repositories moving from one bot and one panel;
- approve architecture work, settings changes and escalations from the panel;
- let automations follow standing instructions and surface the exceptions that need a person.

It is a fork of DeepSeek's SuperAgent research prototype. This README covers what it can do, how it works, how to install and run it, and where its limits are.

## Status at a glance

| Property | Detail |
| --- | --- |
| Runs on | Windows 10/11 natively (desktop app or `scripts\dsh-superagent-further.cmd`), Linux (WSL verified, CI), macOS (CI + smoke host) |
| Requires | Node.js `^22.19.0 || >=24`, pnpm `11.7.0`, git 2.32+, DeepSeek Harness `0.2.2-rc.1` (pinned in [006](docs/006-deployment.md)); no Python, no tmux |
| Checks | `pnpm check`: 92 spec files, **1531 passed / 5 skipped (1536)**, typecheck, build, a pack check of the published tarball and a check that the generated reference pages are current; check.yml green on six platform/Node combinations on every push |
| Release | `0.4.0` ([CHANGELOG](CHANGELOG.md)); a `v*` tag runs the checks, packs `dsh-superagent-further-0.4.0.tgz`, and publishes it |
| Live proof | real GitHub and Feishu requests end as merged pull requests; a project Lead executed as a hidden child Session; a cross-project Request produced two Tickets, two PRs and one `done` result |
| Project requests | a worker raises a durable `project_request` when its Ticket needs a decision, a new deliverable or another project's work; its project Lead must reply and disposes it, an accepted work request creates a Request and staged Tickets confined to the project, an architecture request waits for a person's recorded approval, an independent DSH Session can submit work and always receives an answer, a project automation delivery may raise one project request through its Lead, an installation automation delivery may create an installation Request from the main Session, and a Lead may escalate work outside its project for the Orchestrator to decide |
| State schema | 23 (`10 → 11 → … → 22 → 23` migrate in place; `scripts/verify-install` reports the schema read-only) |

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

## What more can it do?

The prototype proved the core loop for one repository, one POSIX host and one operator: a Source event becomes a Trigger, the Policy admits it, a Request becomes Tickets, and a worker reports where it came from. This fork keeps that loop and adds the abilities below. Each one is user-visible — something you can ask for, watch or operate — and the linked documents carry the internals.

**Work from more than one place.** GitHub issues, pull requests, review comments and CI results, plus Feishu mentions and direct messages, all become work. An independent DeepSeek Harness Session can hand over work with `superagent_submit` and always receives an answer, a Feishu conversation can receive a workspace document as a file, and a daily digest summarises what happened.

**Run several projects from one bot.** Each registered project brings its own clone, repository and base branch; GitHub polling is per project, a Ticket is confined to its project, and a finished worktree is reclaimed. One panel and one Policy cover every project, filtered per project where that helps.

**Give each project a Lead.** A persistent Session per project owns that project's context, receives and answers its workers' requests, creates the project's Tickets only by accepting those requests, starts an independent reviewer for a change, and escalates work outside the project to the Orchestrator. Architecture-level work waits for a person's recorded approval before implementation starts.

**Accept work the system discovers.** Workers, project Leads, installation automations and independent Sessions can raise durable requests. Every path records its origin, must be answered, is deduplicated, and cannot bypass Policy or admission.

**Know what "done" means.** Every Ticket carries a deliverable contract. A `change` Ticket gets a worktree and a branch and ends only through a followed pull request whose ready report names it. An `answer` Ticket reads the project's live checkout with write tools removed and ends as completed. Reports carry up to twenty verification checks, shown on the Ticket and counted in notices; a Lead can start an independent read-only reviewer whose blocked verdict keeps a merged change open. The panel distinguishes answered from delivered.

**Let it run without standing over it.** Installation and project automations deliver standing instructions to the right Session, and the panel can run or delete them. An approval inbox collects settings proposals, and a per-block restore undoes a change. An experimental Memory feature, off by default, keeps pinned facts and recent notes across work — carried into later requests only after you also turn on injection — and the language setting keeps human-facing text in the language you choose.

**See what needs a person.** The Overview gathers open Requests, escalations, automations needing attention, failed file deliveries and each project's Lead; a running assignment whose worker Session has gone idle past ten minutes becomes attention and wakes the Lead once; the Logs page filters Host logs by level and scope; health, outbox and reply-queue details stay visible; tickets show their verification evidence and review state; the Execution tab shows each worker's background jobs and last output.

**Operate it as a service.** A setup wizard, a service script for Windows, macOS and Linux, `verify-install`, a one-host guard and graceful shutdown make it usable unattended. Schema migrations upgrade in place, `scripts/archive-state.mjs` takes a consistent snapshot, and the [operations runbook](docs/013-operations-runbook.md) and [security policy](SECURITY.md) record the day-to-day path and the trust boundaries.

**Extend it without replumbing.** Sources (GitHub, Feishu, DeepSeek Harness Sessions), the label capability, Feishu file delivery and operational skills (triage, release, project requests) are first-class; the [tool reference](docs/reference/tools.md) and [settings reference](docs/reference/config.md) are generated from the code so they cannot drift.

**And it runs where you do.** Windows 10/11 natively, Linux and macOS; Node 22 and 24; CI on six platform/Node combinations, a real-host smoke test and an installable release for every version.

The prototype's invariants stay in place: the Engine is the only writer, and the agent acts only when a Source event, an accepted Request or an explicit request authorises it. [009 Roadmap](docs/009-roadmap.md) records when each ability landed and [011 Capabilities](docs/011-capabilities.md) records the decisions behind it.

## Product philosophy, extended

The original principle stands: **take as little human attention as possible, and give as much value as possible.**
Daily use sharpened seven things without adding a top-level concept:

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
   self-checks, log bounds, worktree reclamation, one-host rule, visible retry state and the exceptions it surfaces,
   not only by its agent loop. That is why this fork invests in `verify-install`, schemas, CI, smoke hosts, a release
   tarball, the Logs page, the Overview's waiting rows and the runbook in 013.
6. **Evidence over assertion.** An agent that says "done" is the cheapest sentence to write and the most expensive to
   trust, so the product asks for evidence at the seams: a change Ticket ends only through a followed pull request, its
   ready report carries the checks that verified it, an answer Ticket's report is the deliverable, and an independent
   reviewer can block a merge with a verdict recorded on the Ticket.
7. **The system must explain itself to the next agent.** Another agent will read the code, not the conversation that
   produced it. So decisions are written in numbered docs, tool references are generated from the code, the packing and
   layering rules are checked, and [CONTRIBUTING.md](CONTRIBUTING.md) states the same loop for a person, an ordinary
   coding agent, the Orchestrator, a Lead, a Worker and a Reviewer.

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
- [013 Operations runbook](docs/013-operations-runbook.md): daily checks, state backups, recovery and upgrades
- [014 Self-evolution](docs/014-self-evolution.md): the design for discovering superagent's own problems in
  flight and routing them to a self-fix Ticket or an upstream Issue
- [SECURITY.md](SECURITY.md): the trust boundaries and the vulnerability-reporting path
- [CONTRIBUTING.md](CONTRIBUTING.md): the loop, gates and role hand-offs for a person, an ordinary coding agent, an Orchestrator, a Lead, a Worker and a Reviewer
- [Tool reference](docs/reference/tools.md): generated from the tool factories the model sees
- [Settings reference](docs/reference/config.md): the generated JSON Schema of the settings blocks
- [AGENTS.md](AGENTS.md): instructions for coding agents working in this repository
- [docs/agents/domain.md](docs/agents/domain.md): the engineering-skills scaffolding used with coding agents

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full loop, the gates and the reporting template every role uses.

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

