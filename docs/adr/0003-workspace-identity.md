# 0003 — The Orchestrator workspace is mandatory, validated, and set up fail-closed

- **Status:** accepted
- **Date:** 2026-11-11
- **Deciders:** the operator (approval recorded in the M31 brief), implemented by mission M31

## Context

The main Session's working directory was the plugin's `stateDir`. That directory also holds `orchestrator.sqlite`, the state lock, `worker-bin`, `worker-gitconfig`, `logs/` and the worker checkouts under `work/`. DeepSeek Harness therefore had no registered workspace for the main Session: the panel showed an unassigned workspace, and the agent's cwd was the same directory the application mutates, backs up and asks the operator to archive.

A Session's cwd is fixed in DSH. The workspace is the identity: `workspaceRegistry.create()` canonicalizes a path, refuses a relative, missing or non-directory path, and a Session cannot later move to another workspace (`session/conflict` carries the existing cwd). The previous fallback was also implicit: `KV.runtime.masterId` was seeded from `orchestrator-<hash(stateDir)>` and written before setup ran, so a host that had never completed onboarding still looked initialized.

This ADR records the decision to make the workspace a first-class, mandatory setting that is validated before anything else, with no default path and no fallback to `stateDir`.

## Decision

1. **The workspace is a first-class settings block, tier A.** `SettingsSchema.workspace` is `{ path: string }`, `SettingsBlock` includes `workspace`, and `fieldTier` returns `A` so the main Session may save it with a reason through the normal settings path. `PUT settings/workspace` validates and canonicalizes before the value is stored; an invalid save is refused with a setup problem and writes nothing.
2. **No default workspace and no fallback.** An empty path is not a location: setup reports `workspaceRequired` and the Runtime stays `paused`/`setupPending`. `stateDir`, its parents, its `work/` scratch, the DSH home and profile directories, the DSH session store, the package root and every registered project workspace are refused. The selected directory must be absolute, must not be a UNC path or a filesystem/drive root, must not be a symlink or junction, and must be empty or carry the `.dsh-superagent-workspace` marker; the application writes that marker and gives the directory `0700`/owner-only ACL.
3. **Setup order is workspace → projects → accounts → environment.** `Setup.resolve()` prepares the workspace first; only then may it report `projectUnset`, resolve the GitHub and Feishu accounts, and write and verify the worker environment. The same rules run when a save changes the workspace (`Setup.verifyWorkspace`), so the panel cannot store a path that startup would refuse. A workspace change restarts the host.
4. **The main Session lives in a titled DSH workspace.** Startup registers the prepared path with the explicit title `dsh-superagent-further · <directory name>` (and corrects a drifted title). The master session id is `orchestrator-<sha256(JSON.stringify([canonicalPath])).slice(0, 32)>`; it is derived from the workspace, not from `stateDir`. No code path passes `stateDir` to `workspaceRegistry.create()` or to `Sessions.ensure()`.
5. **An upgrade pauses at `workspaceRequired` and never deletes Sessions.** When the stored master id is absent or differs from the workspace-derived id, startup archives the stored session with `{ stopActivity: true }` (readable history, no conversation continuity), removes the legacy `stateDir` DSH workspace registration — which retains the directory and every session log — and creates the new master session in the selected workspace. The KV update is one `store.atomic` write published only after the retirement and before polling starts; the operation is idempotent, so a crash between archive, workspace deletion and KV publish is reconciled on the next start. A workspace selected again after a switch away is resumed under its own identity, not recreated: startup unarchives its workspace-derived master before resolving the Session, because DSH rejects every step of an archived Session even though `resolveAgent` still resolves it. Only the desired workspace-derived id is unarchived; an upgrade's legacy `stateDir` id is never the desired id and stays archived. If DSH cannot unarchive the returning workspace's master, startup fails closed with `workspaceUnsafe` instead of starting an orchestrator whose steps would all be rejected.
6. **The wizard cannot be bypassed.** The setup wizard's first step after the welcome is the workspace. While the path is empty, Skip step, Skip all, the primary button and the modal close are inert; the server also refuses `PUT wizard` with `workspaceRequired`. Once a workspace is saved, the remaining steps behave as before.
7. **The panel always shows the titled workspace.** `GET state` carries `setup.workspace { path, title }` once setup prepared it; `GET settings` carries `blocks.workspace`. The Execution settings page shows the title and the path in a workspace card with its own revision and history, and the Overview's setup state names the workspace problem where the operator fixes it.

## Rejected alternatives

- **Default to a directory under `stateDir`.** It would keep the confusion this decision removes: state, logs, database and worker scratch are not the agent's project, and a default can be created without the operator's consent. The operator explicitly rejected a default.
- **Keep the existing `orchestrator-<hash(stateDir)>` session and only register `stateDir`.** The workspace would be the directory the application owns and archives, its title would be meaningless, and the session cwd could never be corrected later. The operator accepted a new master session with the old one kept as readable, non-continuing history.
- **Validate only in the panel.** A settings save and an upgrade are different paths; validation at startup and at save share `prepareWorkspace`, and startup cannot start polling on a path the panel never checked.
- **Migrate by rewriting the old session's cwd.** DSH's session cwd is immutable; forcing it would corrupt the session header and its workspace attachment. Archiving and creating a new Session is the only supported path.
- **Delete the old Session or its workspace registration silently.** Sessions are domain history; workspace deletion in DSH keeps directories and session logs, and no migration path deletes a Session record.

## Consequences

- An installation that upgrades without a workspace starts paused with `setupPending`/`workspaceRequired` and no Sources, executor, workspace registration or master session until a person selects one. This is the intended fail-closed state, not an error.
- The first save of a workspace creates its directory and marker and sets permissions; a directory that already holds other files is refused instead of adopted, so an operator who points at the wrong path loses nothing.
- The workspace-derived master id gives each workspace its own master conversation. Switching away archives the previous workspace's master; selecting that workspace again unarchives and resumes it under the same id, so the operator returns to the conversation they left. An upgrade's old `stateDir` master is never resumed: it stays archived and readable as history. If DSH cannot unarchive a returning workspace's master, startup fails closed with `workspaceUnsafe` rather than starting an orchestrator whose Session steps DSH would reject.
- `stateDir` remains the worker scratch (`<stateDir>/work`), database, lock and log location; it is system-owned and never becomes an agent cwd or a DSH workspace.
- Tests: `tests/workspace-identity.spec.ts` covers validation, registration under the title, retirement order and idempotence, the switch-back unarchive and its fail-closed error, fail-closed startup, the wizard refusal, the panel state/settings surface and the startup-order guards; `tests/panel-setup-wizard.spec.tsx` and `tests/panel-execution.spec.tsx` cover the mandatory step and the titled workspace card; `tests/http.spec.ts`, `tests/policy.spec.ts` and the runtime fixture cover the round trip.

## References

- [003 Execution](../003-execution.md) — the main Session's workspace and the worker checkouts under `stateDir/work`.
- [005 Panel](../005-panel.md) — the setup wizard's workspace step and the Execution settings card.
- [006 Deployment](../006-deployment.md) — install, upgrade and the workspace in the API.
- [007 Architecture](../007-architecture.md) — `src/app/workspace-root.ts`, startup order and composition.
- [011 Capabilities](../011-capabilities.md) — required DSH services and the workspace identity.
- [013 Operations runbook](../013-operations-runbook.md) — the upgrade step that selects a workspace.
