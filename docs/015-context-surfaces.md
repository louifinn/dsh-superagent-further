# 015 — Context surfaces: one declared model of what each role's model sees

Issue #6 records three context-management defects — the Lead is outside the budget, outside the
resource system, and outside the role model — and shows they share one root cause: **a role's
model-facing surface is modeled four times, in four incompatible shapes, and nothing forces them to
agree.** This document is the design for the structural fix. It is design only; no code change rides
with it. After the operator confirms it, each migration step lands as its own ordinary ticket under
the Sprint 45 checklist in [009 Roadmap](009-roadmap.md).

A *surface* is everything a role's model is shown: the prompt sections its system prompt is composed
from, the application tools registered for it, the resources it may read, the runtime-context
contributions appended after its cached history, the projection policy that decides how much of any
field reaches the model inline, and the character budgets that bound all of it. Four roles exist
today — `orchestrator` (the main Session), `worker` (an Executor Session), `lead` (a project Lead
Session, [010](010-project-orchestrator.md)) and `reviewer` (a review subagent, [012](012-project-requests.md)
D14) — and a fifth will arrive the same way the fourth did.

## Why

[000 Philosophy](000-philosophy.md) judges every part by the attention it costs, and the whole
context regime — assignments and inputs arrive inline, "read pointers appear only for truncated
content" ([007](007-architecture.md)), large bodies stay out of prompts until requested — is that
principle applied to the model. A bound that holds for two of four roles is a convention, not a
bound; a visibility system with two levels cannot express a third reader; and a truncation policy
that lives in scattered character constants cannot be stated, tested or documented as one thing.
The failure mode is already demonstrated: adding `lead` required edits at four sites, three of which
fail silently when forgotten, and the one that could not be forgotten was routed around with a
parallel assembly function.

## What the evidence found

Four models of the same concern, none exhaustive:

| Concern | Where it is expressed today | Shape | Covers `lead`? | Covers `reviewer`? |
| --- | --- | --- | --- | --- |
| prompt assembly | `src/app/prompts.ts`: `type Role = 'orchestrator' \| 'worker'` (line 49), `promptParts`, `composeLeadPrompt` (line 132) | closed union plus a parallel Lead assembly function | no — `composeLeadPrompt` duplicates and diverges from `promptParts`; the Lead's part is registered with `roles: []` | no |
| resource visibility | `src/app/resources.ts`: `RESOURCES` with `executor?: true` (line 24), `resourceGrammar(executor: boolean)` (line 57) | one boolean flag: main Session (all 27 resources) or worker (the 14 marked `executor`) | no — the Lead reads through twelve command-shaped `lead_*` tools, each with its own bounded projection | no — a reviewer has no read tool at all |
| surface inventory | `tests/model-surface.spec.ts`: a test-only `Surface` with `role: 'both' \| 'orchestrator' \| 'worker'` (line 30) and the `collect()` sweep (line 297) | hand-maintained; its tool lists are hand-listed too | no | no |
| budget | `tests/model-surface.spec.ts`: `BUDGET: Record<Role, number>` (line 64, today `{ orchestrator: 73_000, worker: 44_400 }`) with free-text justification comments (lines 42–63) | hand-maintained record | no — the Lead's composed prompt plus its twelve tool schemas are never measured | no |

The projection policy has no single representation at all. The inherited philosophy is sound and
documented, but the inline-or-spill decision is made at each call site by a character constant:

- `src/app/assessment.ts` line 45: `TRIGGER_CHARS = 4000`, `NEAR_CHARS = 1200`, `WINDOW_CHARS = 400`, `STUB_CHARS = 50`
- `src/executor/dsh.ts` line 163: `ASSIGNMENT_CHARS = 1500`, `TRIGGER_CHARS = 600`; 160-character `replies_to` and batch previews
- `src/app/cards.ts`: `preview` at 160, report previews at 100, input text at 80, list caps `ASSIGNMENTS = 3`, `INPUTS = 10`, `related_tickets` at 8
- `src/app/resources.ts`: a text page at 4,000 code units, a list at 20 items (50 at most)
- `src/app/notices.ts`: report summaries at 600; `src/app/resources.ts` transcript previews at 80

A repository-wide grep for `slice(0,` finds 95 occurrences under `src/` today, spread over
model-facing projection, client rendering, id derivation and wire formats; nothing in the type system
or the test suite distinguishes the projection uses. A new model-facing field is inlined or
truncated according to what its author remembered, and nothing can state "this role never receives
more than X characters of inlined text per message" or "every truncation carries a readable pointer".

## Design

### D1. `Surface` as a first-class contract

New module `src/app/surfaces.ts` holding one declarative record:

```ts
type RoleId = 'orchestrator' | 'worker' | 'lead' | 'reviewer'
const SURFACES: Record<RoleId, Surface>
```

with, per the issue's contract:

- `sections: readonly SectionKey[]` — the prompt parts, keyed against the existing part registry
  (`PART_KEYS` in `src/app/prompts.ts`), including the team sections and the generated parts;
- `tools: readonly ToolKey[]` — the application tools registered for the role, keyed against a tool
  registry the tool modules own; DSH-native preset tools (`bash`, `read`, jobs, subagent) stay
  preset configuration, not surface entries;
- `reads: readonly ResourcePattern[]` — resource visibility as a pattern set over the `RESOURCES`
  name templates, not a boolean (D5);
- `runtimes: readonly RuntimeKey[]` — the runtime-context contributions: `memory`, `automations`,
  `language`, with the scopes they have today (memory and automations installation-wide for the
  orchestrator and project-scoped for a Lead; language for every decorated Session);
- `projection: ProjectionPolicy` — the role's policy table (D2);
- `budget: readonly BudgetEntry[]` — the prompt, tool-schema and injection budgets, each with a
  structured `reason` (D4).

Requirements:

- `Record<RoleId, Surface>` is exhaustive by TypeScript's own rule: adding a role without a surface
  entry fails to compile. An *empty* surface (the reviewer's) is still a declared surface.
- Section keys are checked against `PART_KEYS` and tool keys against their registries; an unknown key
  fails to compile.
- `composeLeadPrompt` is deleted. `promptParts` becomes `compose(SURFACES[id], …)`: the Lead's
  exclusions (no `runtime/admission`, no Policy section, no worker `runtime/work` section, plus its
  own `runtime/lead` part and generated project section) become data in its surface, not a second
  function. The three assembly paths — orchestrator, worker, Lead — and the reviewer's activation
  text are all derived from `SURFACES`.
- The `collect()` sweep moves from `tests/model-surface.spec.ts` into this production module as a
  function over the runtime's own registrations, so the panel, the generator and the tests read one
  inventory. The spec inverts: it asserts that the declared `Surface` matches what is actually
  registered, instead of hand-listing model-facing text and tool names.

### D2. Projection as a pure, total function

New module `src/app/projection.ts`:

```
project(surface, field, text) -> { inline: string; chars?: number; read?: string }
```

- `ProjectionPolicy` is a **closed enum**: `inline` (whole), `near` (the two neighbouring messages'
  width), `far` (an ordinary window message's width), `stub` (a one-line preview with a read
  pointer), `pointer` (nothing inlined; only the read pointer). The enum carries no numbers; the
  policy table maps each field key to a policy and its character width, per surface where they
  differ.
- `field` is a keyed descriptor (`FieldKey` plus the resource reference its pointer names), not a
  bare string, so the returned `read` pointer is derivable without call-site knowledge.
- All context truncation moves here. The existing constants (the assessment window's 4000/1200/400/50,
  the worker's 1500/600, the cards' preview widths and list caps, the resources' page sizes) are
  absorbed into the policy table with their current values first, so behaviour is preserved
  byte-for-byte before anything is tuned.
- Direct `slice`-based truncation of model-facing text is removed from the app layer; the remaining
  `slice` uses (ids, Markdown plumbing, client text, wire formats) stay and are annotated as
  non-projection, enforced by an allowlist rule in `scripts/check-architecture.mjs` that rejects
  policy literals and raw model-facing truncation outside `projection.ts`.
- The policy table is generated into `docs/context-policy.md`, joining the generated reference pages
  under the `docs:generate` / `docs:check` drift gate, so the documented criteria and the code
  cannot drift ([007](007-architecture.md) records the same rule for `docs/reference/*`).

### D3. The four invariants

Each has a property-based test, and invariants 1 and 2 hold **by construction** — the single
`project` implementation is the mechanism, and the tests are evidence, not the enforcement:

1. **Completeness** — `inline + (read ? spilled-via-read : '') === original`; no content is lost
   when its pointer is followable, and none is duplicated. Truncation without a pointer is
   representable only as `pointer` policy, never as a silent cut.
2. **Readable closure** — every emitted `read` pointer resolves for that surface: the resource is in
   `surface.reads`, the role's scope covers the object, and a pointer must never name an object the
   role that received it may not see. Today nothing prevents a truncated field from handing a role a
   pointer it cannot follow; this is the invariant that matters most.
3. **Boundedness** — the summed inline length of one delivered message (assignment + trigger card +
   batch lines + notes + recovery text, the worst case the delivery path can build) stays within
   that surface's **injection budget**, independently of the prompt budget.
4. **Determinism** — `project` is a pure, total function of `(surface, field, text)`; identical
   input produces identical output, so golden snapshots are reproducible and caching is safe.

### D4. Budgets as generated artefacts

- The budget table is generated from `SURFACES` + the prompt files + the registered tool schemas
  into a committed generated page behind the `docs:check` gate, exactly as
  `scripts/generate-tool-reference.mjs` does for the tool and settings references; CI fails on drift.
- Each `BudgetEntry` carries a structured `reason` (`change`, `delta`, `issue`, `date`); the existing
  free-text justification comments in `tests/model-surface.spec.ts` are promoted to this data and
  rendered by the generator.
- The Lead and the reviewer enter the table automatically, because the sweep reads the real
  registrations rather than a hand list. The Lead's initial entry records what the composed Lead
  prompt (roughly 27,000 characters of prompt parts before the environment section) plus its twelve
  `lead_*` schemas actually cost — measured for the first time.
- A budget change is a data change with a reason, reviewed in a diff, not a comment edit; lowering a
  limit stays as easy as it is today, and raising one carries its justification in the artefact.

### D5. One read path, role-appropriate visibility

- Resource visibility is derived from `surface.reads`; the `executor?: true` flag and the
  `resourceGrammar(executor: boolean)` boolean are deleted. `orchestrator_read`'s `resource`
  description is generated per role from its own pattern set.
- Every role that reads domain state — orchestrator, worker, lead — reads through the same paged
  capability in `src/app/resources.ts`: pointer, offset, redaction, and refusal on out-of-scope. The
  Lead stops depending on the per-tool projections inside `lead_status` / `lead_requests` and reads
  views built by the projection layer (thread history, trigger text, decision and request audit)
  the way every other reading role already can.
- The twelve `lead_*` tools remain: they are **commands**, not reads (`lead_request_decide`,
  `lead_review`, `lead_notify_worker`, …). The split is commands vs. reads, and only commands are
  role-specific. A reading command that merely formats domain state (`lead_status`,
  `lead_requests`) shrinks to what its command semantics require, or is deleted once the read path
  covers it.
- The reviewer's surface declares its reads explicitly (ticket-scoped, ⊆ the worker's) even if the
  first phases register no read tool for it, so widening it later is a one-line data change.

### D6. The visibility lattice

`reads` expresses a lattice, so containment is assertable rather than aspirational. Two dimensions:

- **Patterns.** Over the `RESOURCES` name templates: `reviewer.reads ⊆ worker.reads ⊆ lead.reads ⊆
  orchestrator.reads`. A lower role never names a pattern a higher role does not. What stays
  orchestrator-only (`settings`, `settings/<block>`, `settings/proposals`, `models`, …) is simply
  absent from the lower surfaces, and the subset assertions still hold.
- **Scopes.** Each surface carries a data scope: `ticket` (worker, reviewer — its own Ticket's
  objects), `project` (lead — its project's Tickets, Threads and requests), `installation`
  (orchestrator — everything). Scope narrowing is monotone: whatever a scope authorizes, every wider
  scope authorizes too. The instance-level checks that exist today (`readable`, `mayRead`, the
  per-route `main()` guard) become the scope object's rules, unchanged in behaviour.

A property test asserts both: pattern-set containment between each adjacent pair, and, over seeded
instances, that no object readable in a narrower scope is refused in a wider one. Adding a resource
or a role without placing it in the lattice fails that test at the seam that owns the rule
(`tests/resources.spec.ts`).

## Alternatives considered

- **Patch each defect where it bites** — add `lead` to `BUDGET` and to `it.each`, add a Lead note to
  the docs. Rejected: it fixes one symptom and leaves four role models that will reproduce the same
  defect on the next role; Issue #6 names this shortcut insufficient and asks for it to be closed.
- **Extend the `Role` union and delete `composeLeadPrompt` only** — the smallest structural step (a
  third member of `type Role`, the Lead assembled through `promptParts`). Rejected as the whole
  answer: it unifies one of the four models while leaving visibility a boolean, the inventory and
  the budgets hand-maintained, and projection scattered. It is absorbed as step 3 of the migration,
  where it belongs.
- **Surfaces as settings** — make the surface record an operator-configurable settings block.
  Rejected: a surface is a code contract between modules, not team policy; [000](000-philosophy.md)
  keeps behaviour teams describe in words as prompt text and keeps settings few. Prompt *text*
  remains overridable through the existing prompt revisions ([004](004-prompts.md)); the shape of a
  role's surface is not a setting.
- **Per-resource authorization callbacks instead of a pattern set** — express `reads` as predicates.
  Rejected: predicates are invisible to docs, tests and the generator, and containment between two
  arbitrary predicates is undecidable; patterns make the lattice a set-inclusion check.
- **Enforce the invariants only in tests** — keep projection where it is and add property tests over
  the scattered call sites. Rejected: invariants 1 and 2 must hold by construction (one pure
  function), with tests as evidence; a test that watches 95 `slice(0,` sites proves nothing about
  the 96th.

## Impact

- **Modules.** Adds `src/app/surfaces.ts` and `src/app/projection.ts`; rewrites the assembly branch
  in `src/app/sessions.ts`, `src/app/prompts.ts` (`compose`, `promptParts`), `src/app/resources.ts`
  (`RESOURCES` descriptors, per-role grammar), the truncation call sites in `src/app/assessment.ts`,
  `src/app/cards.ts`, `src/app/notices.ts`, `src/executor/dsh.ts`, and the `lead_status` /
  `lead_requests` reads in `src/app/tools/lead.ts`. No layering change: `surfaces.ts` and
  `projection.ts` live in `src/app`, import `src/core` only, and are importable by `src/executor`
  and `src/sources` exactly as today's `src/app` modules are.
- **Interfaces.** `composeLeadPrompt` is deleted (internal; its one production call site in
  `src/app/sessions.ts` and two `tests/leads.spec.ts` call sites move to `compose(SURFACES.lead)`).
  `RESOURCES`' `executor?: true` field is deleted (internal descriptor).
  `orchestrator_read`'s per-role resource grammar becomes generated. No domain schema change: no
  store table, no migration, no `SCHEMA_VERSION` bump; Ticket, Request and Trigger shapes are
  untouched. Prompt revisions keep their schema and their overrides; team-edited parts keep their
  keys, so saved configurations survive every step.
- **Data.** Generated artefacts are committed: `docs/context-policy.md` (the projection policy
  table) and the budget page, both under the `docs:check` drift gate. Golden snapshot baselines are
  committed as test fixtures.
- **Rollback.** Every migration step is behaviour-preserving and independently revertible; the
  golden snapshots are the evidence (see below). The first step that changes behaviour at all is
  step 5's Lead/reviewer budget *measurement* (a test-only addition until a Lead read tool changes
  anything) and step 6's Lead read path — each its own PR, each revertible without touching the
  others.

## Migration order

Landing out of order produces a large diff with no evidence that behaviour did not change. Each step
is one ordinary ticket, ends with `pnpm check` green, and reports the commands it ran.

1. **Golden snapshots first.** Capture, byte-for-byte, every current role's composed prompt (with a
   fixed environment and policy fixture), the registered tool JSON, and the resource grammar, as
   committed snapshot fixtures plus a spec that reproduces them. Every later step must produce a
   **zero diff** against these baselines — the refactor is proven behaviour-preserving before it is
   behaviour-expanding. *Rollback:* revert the step; the baselines are documentation until then.
   *Done when* the snapshot spec exists and is green on the unchanged tree.
2. **Promote the surface sweep to production.** Move `collect()` into `src/app/surfaces.ts` as a
   production inventory; invert `tests/model-surface.spec.ts` to assert declared-equals-registered.
   The Lead's absence becomes a red test — the defect is demonstrated, not described. *Done when*
   the inverted spec fails exactly on the Lead (and reviewer) and the hand-listed expectations are
   gone.
3. **Introduce `SURFACES`, derive the three assembly paths from it.** Delete `composeLeadPrompt`;
   the Lead's exclusions become data. The golden snapshots stay at zero diff. *Done when* prompts,
   tool registration and the reviewer activation text are all derived from `SURFACES`, and steps 1
   and 2 are still green.
4. **Introduce `projection.ts` wrapping the existing logic.** First wrap only: identical output from
   the same constants. Then absorb the scattered constants into the policy table, remove direct
   model-facing truncation, annotate the remaining `slice` uses, add the architecture-check rule,
   and generate `docs/context-policy.md`. Snapshots stay at zero diff through the wrap; absorbing
   the constants keeps the values, so the diff remains zero. *Done when* the app layer has zero
   unannotated truncation sites and the policy page is generated and drift-gated.
5. **Generate budgets, add the CI gate, add the Lead and reviewer entries.** The generated budget
   page replaces the hand record; the structured reasons replace the comment block; the Lead and
   reviewer enter the table measured. The four invariant property tests land at their seams
   (`tests/properties.spec.ts` and the projection spec). *Done when* `docs:check` fails on budget
   drift and every role appears with a reasoned entry.
6. **Move the Lead onto the resource read path.** Derive visibility from `surface.reads`, delete the
   `executor` flag, give the Lead the same paged reads (thread history, trigger text, decision and
   request audit), and delete the duplicated projections inside its reading tools. This step
   intentionally changes the Lead's behaviour — the snapshots gain a Lead baseline for the new read
   surface instead of diffing against the old one. *Done when* the Lead pages at least thread
   history, trigger text and one audit surface through the same capability as the other roles.

## Acceptance criteria

All must hold at the end of the migration; partial delivery is not acceptable, and a "just add Lead
to `BUDGET`" patch is closed as insufficient.

- Adding a hypothetical new role requires exactly one `SURFACES` entry and zero changes to assembly,
  resource or budget code; forgetting the entry fails to compile.
- Context projection call sites in the app layer are zero, with the remaining `slice` uses annotated
  and justified.
- Each of the four invariants has a property-based test that fails when the invariant is violated.
- The Lead appears in the same budget table as the other roles, and its budget carries a structured
  reason.
- `docs/context-policy.md` and the budget table are generated; CI fails if either drifts.
- The Lead can page at least thread history, trigger text and one audit surface through the same
  read capability as the other roles.
- `pnpm check` stays green throughout, and each step's report names the commands it ran.

## Explicitly rejected shortcuts

- Adding `lead` to `BUDGET` and to `it.each` — fixes one symptom, leaves three duplicate role models.
- Writing the criteria table by hand in a document — it drifts; it must be generated from the
  projection policy.
- Giving the Lead a second bespoke read tool — that is the defect, not the fix.
- Enforcing the new invariants only in tests — invariants 1 and 2 hold by construction, with the
  tests as evidence rather than as the mechanism.

## Non-goals

- No change to the domain model, the store schema, admission or Policy: this is the model-facing
  layer only.
- No prompt-text rewrite: sections keep their text; the change is which sections a role receives and
  how they are accounted. Team overrides and prompt revisions are untouched.
- No new settings block; a surface is a code contract.
- No streaming, token-level budgeting or model-specific encodings: budgets stay character-based, as
  the existing `BUDGET` is.

## Decision points submitted with this document

1. **Generated page placement.** The budget table as `docs/reference/surfaces.md` beside the other
   generated references, and the projection policy as `docs/context-policy.md` at the issue's named
   path — or both under `docs/reference/`. This document proposes the issue's path for the policy
   page and `docs/reference/` for the budget table; the operator may prefer one directory for both.
2. **The lattice orientation.** `reviewer ⊑ worker ⊑ lead ⊑ orchestrator` as proposed, which forces
   `lead.reads ⊇ worker.reads` (a Lead may read what its workers read, at project scope). The
   alternative — a Lead beside the worker under the orchestrator — matches nothing the Lead does,
   since it owns the workers' project.
3. **Snapshot fixture form.** Committed fixture files (proposed — they diff line-by-line in review)
   versus inline snapshot strings in the spec.
