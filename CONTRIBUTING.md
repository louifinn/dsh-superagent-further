# Contributing

This repository is the DSH SuperAgent bundle: a proactive orchestrator that listens to GitHub and Feishu, decides under a
Policy, and runs each accepted request as a Ticket in its own DSH Session. Everyone who changes it — a person, an ordinary
coding agent, or a SuperAgent member — follows the same checks; only the entry point and the reporting channel differ.

Read [AGENTS.md](AGENTS.md) first, then [007 Architecture](docs/007-architecture.md) for the module map,
[009 Roadmap](docs/009-roadmap.md) for what is done, and the reference pages under [docs/reference](docs/reference/).
Behavior decisions live in the numbered docs; generated pages must never be edited by hand.

## The working loop

1. **Understand before changing.** Read the module's doc section and its tests. The generated references
   (`docs/reference/tools.md`, `config.md`) and the module/test tables in [007](docs/007-architecture.md) are the map.
2. **Decide first when behavior changes.** A behavior change needs a line in the owning numbered doc (for example
   `docs/012-project-requests.md` for request flows, `docs/011-capabilities.md` for new capabilities) and a roadmap
   checklist entry. A bug fix that restores documented behavior needs no new design doc.
3. **One change, one reason.** Keep commits scoped. Do not mix a refactor, a behavior change, and a dependency bump in one
   review. The repository prefers small modules with deep interfaces over broad rewrites.
4. **Test at the seam that owns the rule.** Core invariants go in `tests/core-engine.spec.ts` or a property test; a Source
   in `tests/sources.spec.ts`; tools in `tests/tools.spec.ts` plus `tests/surface.spec.ts` when the tool set changes;
   panel behavior in the `panel-*.spec.tsx` files; migrations in `tests/migration.spec.ts`.
5. **Run the gates and show evidence.** Report the command you ran and its result; never claim a check you did not run.

## Gates

`pnpm check` is the single gate and runs, in order: `typecheck`, `architecture:check`, the Vitest suite, the build,
`pack:check` and `docs:check`. It must be green before a push.

- **Node 22 is the floor.** The suite and the generated-reference script run under Node 22's type stripping: do not use
  syntax it cannot strip (for example `await using`) in a file the reference generator imports. Use explicit
  `try/finally` and `Symbol.asyncDispose`. Verify with `npx node@22` when in doubt.
- **Layering.** `scripts/check-architecture.mjs` enforces the direction: `src/core` never imports the layers above it,
  `src/client` never imports the server beyond `src/app/api.ts` (type-only imports exempt), and `src` never imports
  development tooling. Put shared contracts in `src/core` or a neutral module, not sideways.
- **Docs tables.** `tests/docs.spec.ts` requires a row for every `src` module and every test file in
  [007](docs/007-architecture.md), numbered documents link only to earlier numbers, every local link resolves, and docs
  are numbered consecutively. Adding a file means adding its row.
- **Generated pages.** After a tool, settings or schema change run `pnpm docs:generate` and commit the result;
  `docs:check` fails on drift. Never hand-edit `docs/reference/*`.
- **Packaging.** `pack:check` compares the npm tarball with `scripts/pack-manifest.json`. After an intentional packaging
  or build-output change run `pnpm build && node scripts/check-pack.mjs --update`.
- **Schema.** A schema change bumps `SCHEMA_VERSION` in `src/app/store.ts`, adds `migrateToNN` in
  `src/app/migration.ts` inside the same transaction, adds a migration test, updates the chain in [007](docs/007-architecture.md)
  and 006, and never loses a field it does not own.
- **Coverage** is reported but not gated: `pnpm test:coverage` writes a summary under `.artifacts/coverage`.

When you change the test count or schema, update the numbers in `README.md`, `README.zh-CN.md` and
`docs/009-roadmap.md` in the same change. Add a CHANGELOG entry under `## [Unreleased]`. Documentation-only pushes skip
CI (`paths-ignore`), so run `pnpm vitest run tests/docs.spec.ts` locally before pushing them.

## Commits and review

- Write the subject as the change, in the imperative: “Give every Ticket a deliverable contract (schema 22)”.
- The body says why, what boundary moved, and which checks ran. Reference the issue (`Fixes #1`) when there is one.
- A pull request should be reviewable on its diff alone: doc rows, tests and counts belong in it.
- Do not rewrite a pushed branch, force-push `main`, or commit secrets, tokens, real workspace screenshots, or state
  databases. The privacy rule from the first release applies: screenshots show private project names.

## Ordinary coding agents

You are contributing to a normal repository. Use the working loop above, run the gates, and report with evidence. You
are **not** a SuperAgent role and must not assume its authority:

- Do not call SuperAgent tools to create work for other projects. If work belongs to the orchestrator's queue, hand it in
  with the global `superagent_submit` tool (the `session` Source): the main Session applies Policy and admission and always
  replies to your Session. State the workspace, the title and the instruction; do not invent a project.
- Do not read or copy the Host's state directory, credentials or sessions; keep to the repository.
- Read-only by default: do not change `state.sqlite`, policy, settings or another person's Ticket. If a change needs the
  operator's confirmation, put it in a proposal or a pull request, not in the state.

## SuperAgent members

SuperAgent members are agents working under the orchestrator's rules. The same gates apply; their reporting channel is
the Ticket, the Lead, or the panel, not a chat reply.

### Orchestrator (main Session)

You decide what work exists, not just what it looks like.

- **Admission is the boundary.** Accept only through the Policy's enabled rules and admission table; record inferred
  candidates instead of acting on them unless `eval.mode` is `auto`. Never hand-create a Ticket outside an accept.
- **Requests are promises.** Every decision carries a non-empty reply; escalations must be decided with a reply; an
  explicit whitelisted request is answered even when ignored. Use `orchestrator_request_create` only for work found in an
  installation automation delivery, and `orchestrator_escalation_decide` for work a Lead escalates.
- **Never touch the repository.** You have no shell and must not ask for one; delegate through Tickets. Settings, Policy,
  proposals and installations are panel-confirmed. Architecture work needs a person's approval on the root Thread.
- **Report evidence.** Request results aggregate through the origin channel; every decision and escalation reply is
  visible in the panel and the logs. Cite what you verified, not what you expected.

### Lead

You own one project's queue.

- **Reply to everything.** `lead_request_decide` and `lead_request_reply` must be non-empty; after two reminders a pending
  request becomes `needs-attention` and the panel shows it. Never silently drop a worker report.
- **Respect the deliverable contract.** An answer Ticket ends with its report; a change Ticket ends only through a
  followed pull request. Do not accept one as the other; do not declare change work done because a branch exists.
- **Gate reviews.** Start a reviewer with `lead_review` on a change Ticket's pull request and record the verdict with
  `lead_review_record`. A blocked verdict keeps the Ticket open when its pull request merges; only a person or a later
  clean review clears it.
- **Stick to your project.** Cross-project or installation-level work goes to the Orchestrator with
  `lead_request_escalate`; project requests cover only your project's units. Budgets: one request per (project, session,
  title) while open, at most eight units.
- **Automation deliveries are report-only.** You may raise and decide the project request an inspection found, and nothing
  else: no repository change, no Settings, Source, Ticket or Policy edits.

### Worker (Executor)

You do the Ticket's work.

- **Read the contract first.** A change Ticket runs in its own worktree and needs a pull request; a ready report names the
  pull request and cites verification checks. An answer Ticket reads the project's live checkout with write tools removed
  and a read-only profile — never try to write, commit or open a pull request there.
- **Report with evidence.** Use `orchestrator_report` and carry up to twenty `checks` (name, command, exit code,
  evidence) for the work you verify. A blocked/needs-info report says what prevents the work; it is not a retry.
- **Raise rather than expand.** New work you discover goes through `request_create` with a title, instruction and
  evidence; the Lead decides it. Do not create Tickets yourself and do not edit the repository outside your Ticket.
- **Never merge or close.** Push the branch and open the pull request; a person or the project's Thread closes it. Do not
  change Policy, Settings, Sources, Tickets or memory.

### Reviewer

You are a fresh, read-only pair of eyes.

- Read the Ticket, its pull request, the report and its checks; judge the implementation against the documented
  behavior, not personal style.
- Report one verdict — `clean` or `blocked` — with concrete findings; a blocked verdict states what must change. Do not
  edit the checkout, push, merge or change any Ticket field except the review itself.

## Reporting template

Use the same shape from every role, so a person can verify without asking:

- **Changed:** files and the boundary that moved.
- **Why:** the issue or decision doc, and the behavior it protects.
- **Evidence:** each command with its exit code or each check with name and command; note what could not be run.
- **Docs and counts:** which numbered docs, CHANGELOG and README counts changed.
- **Open questions / risks:** what a reviewer should look at, and what is deliberately deferred.
