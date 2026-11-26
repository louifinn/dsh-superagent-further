# 0011 — Operational boundary and boundary audit

- Status: Accepted
- Date: 2026-11-26
- Context: Issue #37 and decision 11 of ADR-0009. Every role is a Session of the same DSH Host, under the same operator
  account, with the same state database at `<stateDir>/orchestrator.sqlite`; a worker runs under `danger-full-access`.
  The tool-layer adjacency rules of ADR-0008 (no direct Orchestrator tool into a worker Session; a report is a durable
  Lead message) and the project scope of a Lead read (docs/015 D5/D6) are not isolation: code and agents with shell
  access can read the database or another checkout directly. The operator asked the project to say this plainly and to
  make every tool-layer crossing discoverable.

## Decisions

1. **The boundary is operational, not a sandbox.** The project documents that worker Sessions share the operator's OS
   account, state database and filesystem, that a worker can bypass the tools, and that the Host must be a
   single-operator machine running trusted agents. No tenant or adversarial isolation is claimed; the tools and their
   project/role scope are refusal paths, not a security boundary against a hostile process.
2. **Every refused project-scoped read is audited.** A project-scoped `readResource` that `projectResource` refuses
   writes one `audit_boundary` row before throwing: the time, the caller's role (orchestrator/worker/lead/reviewer),
   the action, the resource, the caller's project, `refused`, and a short detail. A read that resolves writes no row, so
   the table stays a record of crossings rather than a transcript of normal work.
3. **The audit is durable and visible.** The rows live in schema 26's `audit_boundary` table and survive a restart; the
   Runtime mirrors each new row into the operational log under scope `boundary`, so the panel's Logs page can filter to
   it. The row carries ids and a short detail, never a message body.
4. **A refusal still leaves control with the caller.** The caller receives the same `Unknown or inaccessible …` error
   as before; the audit is additive. A person or the Orchestrator may inspect the rows through the store and the log;
   the plugin does not escalate a refusal on its own.

## Consequences

- Schema 26 adds `audit_boundary` (id, at, role, action, resource, project, outcome, detail, value) with indexes on
  `at` and `outcome`. No existing record changes; the migration is the schema bump only.
- `src/app/boundary.ts` owns `BoundaryAudit`; `ResourceHost.boundary` is optional so a fixture host without the audit
  still serves reads, and `Runtime` installs its logger sink once the Store is open.
- `SECURITY.md` states the operational boundary and the audit; `docs/003-execution.md` says a Lead read of another
  project is refused and recorded; `docs/007-architecture.md` registers `src/app/boundary.ts`.
- Tests: `tests/leads.spec.ts` asserts a Lead's cross-project read leaves a `refused` row with role `lead` and its own
  project; `tests/store.spec.ts` records, lists and reopens the audit rows, and checks the optional sink.
