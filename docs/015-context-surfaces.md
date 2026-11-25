# 015 Context surfaces

The model-facing surface of each role — its prompt sections, its tools, the domain state it may read, its runtimes, the
projection policy applied to delivered text, and the budgets that bound all of it — is modelled once, in one module, and
every assembly, resource, budget and projection path derives from that model.

This document is the design half of [#6](https://github.com/louifinn/dsh-superagent-further/issues/6). The migration and
its acceptance criteria are tracked in [009](009-roadmap.md) and the issue.

## Why

A role's surface is currently expressed four times, in four incompatible shapes: prompt assembly has a closed
`orchestrator | worker` union plus a parallel `composeLeadPrompt` function; resource visibility is an `executor: boolean`
flag with exactly two levels; the surface inventory and the budget table live in `tests/model-surface.spec.ts`. The
projection policy — how much context is inlined, when a pointer is emitted — has no single representation at all; it is
56 `slice(0, …)` call sites across 30 files.

The Lead, added after those models, shows the failure mode: absent from the union, the flag and the budget, and routed
around the inventory by a parallel function. Adding a role means editing four sites, three of which fail silently when
forgotten. A fix that only adds the Lead to the budget leaves that structure intact and reproduces the defect on the next
role.

## The model

`src/app/surfaces.ts` holds an exhaustive `Record<RoleId, Surface>`:

```ts
type RoleId = 'orchestrator' | 'worker' | 'lead' | 'reviewer'

interface Surface {
  readonly sections: readonly SectionKey[]      // prompt parts, checked against the part registry
  readonly tools: readonly ToolKey[]            // tool surface, checked against the tool registry
  readonly reads: readonly ResourcePattern[]    // visibility as a pattern set, not a boolean
  readonly runtimes: readonly RuntimeKey[]      // memory, automations, language scopes
  readonly projection: ProjectionPolicy
  readonly budget: readonly BudgetEntry[]       // prompt, tool schema and injection budgets, each with a reason
}
```

- `Record<RoleId, Surface>` is exhaustive: adding a role without a surface fails to compile.
- Section and tool keys are typed against their registries; an unknown key fails to compile.
- `reads` is a lattice (worker ⊆ lead ⊆ orchestrator) so containment is assertable rather than aspirational.
- `composeLeadPrompt` is removed; the Lead's exclusions (no admission, no Policy, no worker `work` section) become data
  in its surface, not a second function.
- The reviewer inherits the Lead's model and reads, so a project's review sees the same world as its Lead.

## Projection

`src/app/projection.ts` is a pure, total function:

```
project(surface, field, text) -> { inline: string; chars?: number; read?: string }
```

`ProjectionPolicy` is a closed enum — inline, near, far, stub, pointer. Call sites may not construct policies; an
architecture check rejects policy literals outside this module. Context truncation moves here; direct `slice` for
projection is removed from the app layer, and the remaining `slice` uses (ids, Markdown, client text) are explicitly
annotated as non-projection. The policy table is generated into a reference page so the documented criteria and the code
cannot drift.

Four invariants, each a property test:

1. **Completeness** — inline plus a spilled pointer reconstructs the original text exactly once.
2. **Readable closure** — every emitted pointer resolves for the surface that received it, and never names an object the
   role may not see.
3. **Boundedness** — the summed inline length of one delivered message stays within that surface's injection budget,
   independently of the prompt budget.
4. **Determinism** — projection is a pure function of surface, field and text, so snapshots are reproducible.

## Budgets

The surface sweep moves from the test into the production module; the test inverts to assert that the declared surface
matches what is actually registered. Budgets are generated from surfaces, prompt files and tool schemas into a committed
table; CI fails on drift, as `docs:check` already does for the generated reference pages. Each budget entry carries a
structured reason, promoting today's free-text justification comments into data. The Lead and reviewer enter the same
table automatically.

## Reads

Resource visibility is derived from `surface.reads`; the `executor: boolean` flag is deleted. Every role that reads domain
state gets the same paged read capability: pointer, offset, redaction, refusal on out-of-scope. The Lead stops depending
on per-tool projections for `lead_status` and `lead_requests`. The `lead_*` tools remain — they are commands, not reads,
and only commands are role-specific.

## Migration

Landing out of order would produce a large diff with no evidence that behaviour did not change.

1. Capture golden snapshots of every current role's composed prompt, tool JSON and resource grammar. Every later step must
   produce a zero diff.
2. Promote the surface sweep to production; invert the model-surface test. The Lead's absence becomes a red test.
3. Introduce the surfaces table; derive the three assembly paths from it. Golden snapshots stay at zero diff.
4. Introduce the projection module wrapping the existing logic with identical output; then absorb the scattered
   constants into the policy and remove direct truncation.
5. Generate budgets, add the CI gate, add the Lead and reviewer entries.
6. Move the Lead onto the resource read path; delete the duplicated projections in its tools.

## Acceptance

The issue's acceptance criteria are the definition of done: one surface entry per new role and a compile error when it is
missing; zero projection call sites in the app layer; a property test per invariant; the Lead in the budget table with a
structured reason; a generated context-policy page and budget table gated in CI; the Lead able to page thread history,
trigger text and an audit surface through the shared read capability; `pnpm check` green throughout.

Adding the Lead to the budget alone, hand-writing the policy table, giving the Lead a second bespoke read tool, or
enforcing the invariants only in tests are rejected as insufficient.

## References

- [000 Philosophy](000-philosophy.md) — attention as the design metric
- [007 Architecture](007-architecture.md) — prompt assembly, resources and truncation today
- [010 Project orchestrator](010-project-orchestrator.md) — the Lead prompt composition
- `src/app/prompts.ts`, `src/app/resources.ts`, `src/app/assessment.ts`, `src/executor/dsh.ts`,
  `tests/model-surface.spec.ts`
