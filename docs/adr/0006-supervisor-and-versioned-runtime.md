# 0006 — A stable supervisor starts a versioned domain runtime

- **Status:** accepted
- **Date:** 2026-11-11
- **Deciders:** the operator (approved plan, M35 brief), implemented by mission M35

## Context

The plugin's domain code currently lives in the same module as its Cordis entry: `src/index.ts` constructs `Runtime`
directly, and that constructor takes the state-directory lock, opens the Store and builds every service. Any change to
the domain code therefore needs a plugin reload or a host restart, even when the state lives entirely in SQLite and the
files under the state directory. The approved target is the opposite: the business runtime should be replaceable inside
the running DeepSeek Harness process, with no human restart, while only host-level changes (a DeepSeek Harness upgrade,
machine configuration) need a controlled restart. The first step (P2) is to make that swap structurally possible. The
update pipeline itself — staging a deploy, requesting a swap, the panel's Updates surface — belongs to M36.

That split imposes constraints. DeepSeek Harness loads a plugin from a package, and a versioned runtime has to run with
the same services, permission model, Sessions and state directory. It may not carry the host's package tree as a runtime
dependency, because then the "versioned" artifact would only start against one exact host build. It also must not lose
the state-directory lock while another process could take it during a swap. And a crash at any point in a swap must
leave a supervisor that can decide what to start, without ever handing a newer database to older code.

## Decision

1. **The supervisor is the stable shell; the domain runtime is a versioned bundle.** `src/index.ts` (the Cordis entry)
   constructs one `Supervisor` from `src/supervisor/supervisor.ts`. The supervisor owns the machine configuration
   (`src/supervisor/config.ts`), the state-directory lock, the `Logs` ring and `LogFileSink`, version resolution, the
   crash journal, the health probe and the drain controller. It owns nothing domain-specific. `src/app/runtime.ts` stays
   the composition root of the domain, but it is now reached only through `src/runtime-entry.ts`'s `createRuntime(host)`.

2. **`RuntimeHost` v1 is a frozen, value-complete interface.** `src/runtime-host.ts` exports `HOST_API = 1`, the host
   interface, the handle and the `DrainReport`. The supervisor builds the host from the live Cordis context and passes:
   the twelve DSH services the runtime uses (`agents`, `sessionController`, `sessionPersistence`, `workspaceRegistry`,
   `permissionPresets`, `tools`, `systemPrompt`, `skills`, `webServer`, `llm`, `subprocess`, `settings`); the DSH values
   the runtime must not import at runtime (`Service`, `freezeMessage`, `MessageId`, `ReasoningEffortId`, `scopeParentOf`,
   schemastery); `machine`, the restart callback, the exit callback, the logger, the lifetime `AbortSignal`, the Logs
   ring, the LogFileSink, the state directory, the log-state listener, the retention setter, `flushLogs()` and
   `releaseStateLock()`. The runtime registers itself as the Cordis `orchestrator` service and keeps only `import type`
   declarations for `@deepseek-ai/*`; `scripts/check-runtime-bundle.mjs` fails the build if a value import or a
   `@deepseek-ai/` specifier reaches the bundle. Changing the shape of a provided field requires `HOST_API = 2`; a
   loader that sees a descriptor or module with another host API refuses it and falls back, so an old runtime never
   receives a new contract silently.

3. **The runtime is built as a self-contained ESM entry.** `tsdown.config.ts` has a third entry,
   `src/runtime-entry.ts` → `lib/runtime-entry.js`, with `zod` bundled and `schemastery`/`proper-lockfile` treated as
   bundled source, while `@deepseek-ai/*` stays a type-only boundary. A descriptor (`lib/runtime-manifest.json`) records
   `{version, entry, hostApi, schema, sha256}`; `pnpm build` writes it through
   `node scripts/check-runtime-bundle.mjs --write`, and `pnpm runtime:check` asserts the invariants without writing:
   only `node:` static imports, no `@deepseek-ai/` runtime import, `createRuntime` exported, `HOST_API === 1`, an integer
   `SCHEMA_VERSION`, a size bound and a hash that matches the file and the descriptor.

4. **Version resolution falls back, never crashes.** The supervisor reads `<stateDir>/runtime/current.json`, checks the
   descriptor's shape, a path-safe `version`, an `entry` that stays inside `<stateDir>/runtime/<version>/`, the file's
   SHA-256, `hostApi === HOST_API`, and a schema that is not older than the open database. Rejections are logged and
   skipped. The order is: a recorded interrupted-journal current, `current.json`, `previous.json`, then the packaged
   runtime. The loader imports the entry through an opaque specifier and additionally checks the module's `HOST_API`,
   `createRuntime`, integer `SCHEMA_VERSION` and handle shape (`ready` is thenable, `drain` and `dispose` are functions).
   A load or initialization failure disposes whatever it created, journals `rollback`, and tries the next candidate. The
   packaged runtime is the last resort and is always present; a broken deployment is therefore a warning and a fallback,
   never a supervisor that refuses to start.

5. **The drain is a fixed, idempotent contract.** The runtime's `drain(reason, signal?)` records and performs the phases
   in this order: stop intake (passes, Sources, new HTTP work), cancel the remaining agents as
   `{kind:'user'}, {keepInbox:true}`, wait bounded for in-flight effects, the outbox and assignments, dispose the
   components, flush the LogFileSink, close the Store, release the state-directory lock. It returns one report with each
   phase's status, start and duration, and `completed` (no failed phase). A second call returns the first report and does
   nothing. Normal shutdown and M36's update path reuse it. The supervisor's `DrainController` writes the journal's
   `drain` phase, awaits the handle's report, commits or fails the journal, and only then finishes the flush and lock
   release; the runtime never writes the journal and never releases the lock itself.

6. **The crash journal makes a swap recoverable at every point.** `<stateDir>/runtime/journal.json` holds
   `{api:1, status:'running'|'committed'|'failed', operation:'startup'|'drain', phase, steps, current, previous,
   recovery}`. Each step is written to a mode-`0600` temporary file, fsynced, renamed over the journal and followed by a
   best-effort directory fsync, so a torn write is never read as a complete record. Phases are `prepare`, `stage`,
   `drain`, `swap`, `load`, `init`, `commit`, `rollback`. On startup, an interrupted record makes its recorded current the
   first candidate; if it does not verify, `current.json` and then `previous.json` do; if none verify, the packaged
   runtime does. The recovery note is written to the journal and the log. No recovery path downgrades the SQLite schema:
   the supervisor reads the schema version from the database before choosing a runtime, a descriptor whose schema is
   older is rejected, and the loader refuses a module whose `SCHEMA_VERSION` is below the database. The schema is never
   migrated down; a newer database can only stop an older bundle, never be rewritten by it.

7. **The split is documented and tested without changing the database.** Schema stays 25. `tests/supervisor.spec.ts`
   covers valid/missing/invalid/hash-mismatch/host-API-mismatch pointers, escaping entries, schema downgrades, loader
   import/export failures, the host descriptor freeze, crash recovery and one start/swap/drain; the existing runtime suites
   build their host through `tests/fixtures/host.ts` and keep passing. docs/003, 005, 006, 007, 009, 011 and 013 describe
   the visible behavior, and the package's manifest is updated for the new `lib/` files.

## Rejected alternatives

- **Keep the runtime in the shell and restart the plugin for every change.** This is the status quo the operator
  rejected: it needs a human restart for business changes and loses in-flight work. It cannot be reconciled with the
  approved no-restart target; only host-level changes keep a controlled restart.
- **Hot-load the latest source or an arbitrary path.** Unverifiable code, version skew and no rollback: a bad file would
  leave no known-good runtime to return to. The packaged fallback and the hash/schema/host checks only work because the
  artifact is a built, described bundle.
- **Hot-swap without a journal.** A crash between "old drained" and "new initialized" would leave an unknown current
  version and an unrecorded database state. The journal is the only durable account of which version was being started,
  and therefore what recovery may prefer; it is written before every step, not reconstructed afterwards.
- **Let the runtime own the lock and the log sink.** Then a swap would release the lock and stop logging exactly while
  the new runtime loads, and a second process could migrate the same state. The supervisor owns both for its whole life;
  the runtime only flushes and releases at the end of its drain.
- **Silent fallback.** A fallback that leaves no trace hides a broken deploy. Every rejection and recovery is a warning
  in the Logs ring and a journal note, and `versionStatus()` exposes the version actually started and its source.
- **Direct value imports from `@deepseek-ai/*` in the runtime.** The bundle would then resolve against the host's package
  tree at load time and could not be versioned independently. Injecting the values through `RuntimeHost` keeps the
  artifact self-contained and makes the boundary checkable at build time.
- **A second in-process drain path for updates.** Two shutdown implementations would drift on the ordering that keeps
  the outbox and lock safe. M36's update path calls the same handle `drain()` and the same supervisor `DrainController`.

## Consequences

The plugin's package gains a third build entry, a generated manifest and a check; `src/app/runtime.ts` loses the lock,
the log sink creation and its `Service` base, and every domain module that used a DSH value receives it through a host
interface. The supervisor is now the only place that may create the state-directory lock and the only place that
resolves which runtime runs. M36 can build staging, deploy and rollback on `current.json`, the journal and the drain
without changing the runtime contract; a later contract change is a `HOST_API` bump, not an in-place edit.
