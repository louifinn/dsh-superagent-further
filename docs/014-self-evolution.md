# 014 — Self-evolution: discovering superagent's own problems in flight

Status: **proposed** (2026-11-10). The operator asked for this mechanism and confirmed the three requirement
decisions below on the root Feishu Thread; this document is submitted for approval. Implementation follows
the phases here only after that approval.

## Why

While superagent runs its ordinary work — Tickets, reviews, routing, panel operations — its Sessions regularly
notice problems of superagent itself: a defect in the code, a prompt that misleads, a panel gap, a doc that
drifted, a deployment friction. Today those observations are lost, because every path into work starts from a
Source message or an automation delivery. The operator's request (2026-11-10, translated):

> Can superagent, while running, proactively discover problems of the superagent project, and choose by itself
> between submitting an issue to the remote repository (louifinn/dsh-superagent-further) when the project is not
> under superagent's management, and raising a request that becomes a Ticket when it is — for example my own
> development environment? I think this is a self-evolution mechanism worth implementing.

The operator confirmed the requirements on 2026-11-10:

| # | Decision |
| --- | --- |
| 1 | **Routing criterion.** The repository the problem belongs to is registered under **Execution → Projects** → raise a request that becomes a Ticket and fix it here; not registered → the bot account files a GitHub issue on that repository. |
| 2 | **Discovery sources.** In-flight discovery is the default; scheduled self-inspection is also implemented, behind a switch, off by default. |
| 3 | **Scope.** superagent itself only — code, prompts, panel, docs and this deployment — not arbitrary projects. |

With decision 3 the outbound target is fixed: superagent's own repository. On this installation that repository
is registered as a project, so every in-scope finding takes the Ticket route; on an installation installed from
a release tarball it is not registered, and the issue route is the only outlet. Both regimes ship in one design.

## What the research found

- **The intake side is already proactive; the outbound side is not.** Sixteen rule categories plus the accept
  mode (`off`/`observe`/`auto`, [002](002-authorization.md)) govern what *enters* as work. Nothing gates an
  action the agent itself initiates outward.
- **The request chain already covers the Ticket route.** A worker raises `request_create` for its own project
  and its Lead disposes it ([012](012-project-requests.md) D1–D5); a worker on another project's Ticket reports
  to its Lead, which escalates with `lead_request_escalate` (D13 — the tool requires no automation provenance);
  an installation automation delivery raises `orchestrator_request_create` (D12). The main Session's own
  discoveries are the gap: that tool requires an automation id.
- **No issue-creation write path exists.** GitHub writes are comments
  (`src/sources/github-channel.ts`) and labels (`orchestrator_label`); there is no tool that creates an Issue.
- **Filing an Issue never loops back into a Ticket.** The GitHub Source drops Issues and PRs the agent account
  itself opened (`src/sources/github.ts` `readNotified`, the `sameName` check), so the two outlets cannot
  interfere.
- **The clock for self-inspection exists.** Installation-scope automations (schema 19/20) deliver standing
  instructions to the main Session with manual run (`automation_run`), delete and reconciliation already built.

## Design

```
discovery (in flight | scheduled self-inspection)
   │  target = superagent itself, concrete and checkable
   ├─ self repository registered here (development installation)
   │     └─ Ticket outlet: project request → Lead decides → Ticket → PR → a person merges
   └─ self repository not registered (release installation)
         └─ Issue outlet: the Orchestrator files a GitHub issue on the self repository
```

One sentence: **discovery lives in the prompts, the Ticket outlet reuses the existing request chain, the Issue
outlet is one new tool with its own observe/auto gate and audit record, and scheduled self-inspection is one
switch over the existing automation machinery.**

### D1. The discovery layer (prompts, no code)

The worker, Lead and Orchestrator prompt sections gain a short 「self-evolution」 passage:

- **What counts.** A concrete, checkable problem of superagent itself met while doing other work: a code
  defect, a misleading prompt, a panel defect, a doc that drifted, a deployment friction. Subjective style
  opinions and feature wishes are not findings; wishes stay with people.
- **Record, do not fix.** A finding never widens the current Ticket's scope, consistent with the existing
  no-scope-expansion rule.
- **Route per role.** A worker on a Ticket of the self project uses `request_create` directly; a worker on
  another project's Ticket reports to its Lead, which escalates; the main Session uses the discovery
  provenance (D2) or the Issue outlet (D3); a finding about this installation's operational state — a failing
  Source, credentials, a stuck outbox — goes to the existing "needs you" surfaces, not into this mechanism.
- Scheduled self-inspection, when on, uses the same routing vocabulary.

### D2. The Ticket outlet (reuse plus one provenance)

Same-project and cross-project findings work today through `request_create` and escalation. One change:
`orchestrator_request_create` accepts `via: 'discovery'` — no automation id — so the main Session can act on
its own findings. The Mandate basis `{ via: 'discovery' }` is trusted by revalidation like the installation
basis, because no Source message admitted the work. Delivery units must still name registered projects, and
the self-inspection automation keeps recording its automation id for audit.

### D3. The Issue outlet: `orchestrator_issue_create` (new tool)

One chokepoint on the main Session, for installations where the self repository is not a registered project.

- **Fixed target.** The constant `SELF_REPOSITORY = 'louifinn/dsh-superagent-further'` in code, not a setting;
  a fork of this fork changes the constant.
- **Jurisdiction refusal.** When the self repository *is* registered here, the tool refuses and names the
  Ticket outlet — the routing rule is enforced by the tool, not left to prompt discipline.
- **A three-state gate** beside the accept mode on the Eval settings: `off` records nothing; `observe`
  (default) records a draft and files nothing; `auto` files directly within the limits. This mirrors how the
  intake side starts narrow.
- **Deduplication.** Before filing, search the target repository's open Issues (title and keyword) and this
  installation's filed self reports from the last 14 days; a hit links instead of filing again.
- **Rate limit.** At most three filed Issues per installation per day; beyond that the finding stays a draft
  and the panel says so.
- **Content rules.** The body follows the repository's language and conventions, opens with the automated-agent
  disclosure, states evidence, reproduction and the running version, and carries no Feishu content, credentials
  or private local paths. Labels only ones that already exist, none by default.
- **Audit record.** Schema 23 adds `self_report`:
  `{ id, title, body, evidence, raised_by { session, ticket? }, target_repo, status: 'draft' | 'filed' | 'dismissed', issue_number?, filed_at?, created_at }`.
  Drafts are what a person approves; the filed history is the remote repository itself, so no history page is
  built. This is the design's only new domain record: an outward, approvable, deduplicated artefact fits
  neither `project_request` (an inward ask of a Lead) nor the Outbox (a delivery receipt).

### D4. Scheduled self-inspection (a switch, default off, over automations)

- A settings switch, default off, shown on the Automations page as a built-in row.
- On: ensure one built-in installation automation — weekly, Monday 09:00 local by default, editable like any
  task — whose instruction is a fixed template: inspect Source health, outbox failures, host-log errors,
  long-waiting Tickets and requests, the self repository's CI when it is registered, and undisposed
  `self_report` drafts; route what it finds through D1 — code and doc problems through the D12 request (with
  the automation id) or the Issue outlet, operational state through the existing "needs you" surfaces.
- Off: remove the built-in task through the existing `Automations.remove` path; reconciliation covers drift.
- The acceptance run uses the existing `automation_run` for one real inspection.

### D5. Panel

The Overview's "needs you" view gains a compact group of observe-mode drafts — title, target repository,
evidence preview, age — each with **approve filing** and **dismiss** actions. In `auto` mode nothing
accumulates, and no other surface is added.

## Non-goals

- Discovering or routing problems of projects other than superagent itself (decision 3).
- Any human-free merge: a self-fix Ticket still ends through a pull request a person merges.
- A second message bus or task board; the Engine stays the only writer of domain state.
- A history page for filed Issues; the target repository is that history.

## Security and noise

| Risk | Mitigation |
| --- | --- |
| A hallucinated problem is filed publicly | `observe` by default; the disposing Lead or Orchestrator must answer; the body requires evidence and reproduction; the daily cap |
| Private content leaks into a public Issue | Hard content rules: no Feishu content, credentials or private local paths; the body keeps the repository's language |
| Duplicate Issues or Tickets | Open-Issue search plus the 14-day filed-record window; project requests and escalations keep their existing idempotence |
| A flood of low-value self-fix Tickets | Findings are recorded silently, never messaged; the Lead merges duplicates when disposing; the prompt asks for concrete, checkable findings only |
| The two outlets double-file the same problem | The jurisdiction check is exclusive: one installation, one self repository, one outlet |
| Authority creep | The Issue tool only creates Issues — it never closes, edits or merges; self-fixes still end in a person's merge; the gate is a revisioned setting |

## Phases

Each phase ends with `pnpm check` green, the six-combination CI green and a live run, per the repository's
gates. Documentation lands with its phase, not in a batch at the end.

- **Phase 1 — discovery layer (prompts only, no code).** The three prompt sections and the skill text;
  `tests/prompts.spec.ts` pins them. Live proof: one real Ticket records one real superagent finding in flight
  and it becomes a self-fix Ticket through the existing `request_create` or escalation path.
- **Phase 2 — the Issue outlet and the discovery provenance.** Schema 23 `self_report`, the
  `orchestrator_issue_create` tool (jurisdiction refusal, gate, dedup, rate limit, content rules), the
  discovery provenance on `orchestrator_request_create`, the Eval self-report mode, the Overview draft rows.
  Live proof: a real draft in `observe`, approved and filed as a marked test Issue on
  `louifinn/dsh-superagent-further`, then closed; the jurisdiction refusal covered by tests.
- **Phase 3 — scheduled self-inspection.** The switch, the built-in automation's ensure/remove/reconcile and
  the instruction template. Live proof: toggling works and one `automation_run` inspection routes its findings
  correctly.
- **Phase 4 — documentation sweep.** Updates to [002](002-authorization.md), [004](004-prompts.md),
  [005](005-panel.md), [006](006-deployment.md) and [007](007-architecture.md) for what shipped, with the
  CHANGELOG and README counts.

## Decision points submitted with this document

These carry the recommended defaults; the operator confirms or changes them with the approval:

| # | Point | Recommendation |
| --- | --- | --- |
| 1 | Default self-report mode | `observe`; the operator switches to `auto` after reviewing drafts |
| 2 | File a public Issue for a finding already self-fixed here | No — the pull request is the public record; filing both doubles the trail |
| 3 | Default self-inspection schedule | Weekly, Monday 09:00 local, editable |
| 4 | Daily filed-Issue cap | Three per installation |

## Risks

- **The Issue outlet is dormant on a development installation** — by design, the jurisdiction check sends
  everything to the Ticket route. Its live proof (Phase 2) files one marked test Issue, then closes it.
- **A fork of this fork** points `SELF_REPOSITORY` at the upstream constant; an operator who registers their
  own fork takes the Ticket route only when the registered repository equals the constant. Documented, not
  configurable.
- **In-flight findings depend on prompt discipline.** The prompts are pinned by tests and reviewed like all
  prompt text; a finding that is never recorded is invisible, which Phase 1's live proof addresses directly.
