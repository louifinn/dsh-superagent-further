# 0002 — Operational log files: one durable JSONL sink beside the memory ring

- **Status:** accepted
- **Date:** 2026-11-11
- **Deciders:** the operator (approval recorded in the M29/M30 briefs), implemented by missions M29 and M30, documented by mission M30

## Context

The Host log began as a bounded in-memory ring: operators read it in the panel, but every restart, crash or upgrade erased it. The records that matter most after an incident — the startup claims that came up ready, a failed reply delivery, a Source's first error, an Executor launch or retirement, a Ticket's lifecycle — were exactly the ones the next start removed. Reading the whole DSH artifact log instead is noisy, host-specific and unavailable on a desktop Host that did not start through the service scripts.

The ring also had to stay cheap. It is written from inside the domain path — a Source poll, an Executor turn, a health transition — so a log failure must never fail the work it describes. Entries are metadata: an id, a state, a count, a reason code. Message bodies, tool arguments and results, report summaries, setting values, model prompts and output, and credentials must never reach it. A file sink adds a second risk: a durable copy of anything the ring mistakenly accepts.

M29 introduced the ring (2000 entries, 200 by default, level/scope filters, keyword search, 60 s folding of repeated entries, credential redaction, a minimum-level setting) and the durable sink behind it. M30 completed the operator-facing side — panel search, copy, JSONL export, load-more and deep links — and added an `audit` scope for human-triggered domain actions. This ADR records why the log is a file beside the state database rather than in it, in memory only, or a full-body record.

## Decision

1. **The memory ring is the read model.** One `Logs` ring of 2000 entries, 200 returned by default, filtered by level (`all`, `warn`, `error`), exact scope and a case-insensitive keyword over the message, scope and structured `data`. Consecutive identical scope+message entries within 60 s fold into one with a `repeated` count. The panel polls the ring; `GET logs` is the only read route and accepts the same `limit` (1–2000), `scope`, `level` and `q`.
2. **One writer, one durable file per UTC day.** `LogFileSink` appends every ring entry under `<stateDir>/logs` to `YYYY-MM-DD.jsonl`. Size rotation renames the active file to `YYYY-MM-DD.N.jsonl` at 20 MiB. Retention is 1–30 days (7 by default): files are pruned at startup, at day rollover and when the retention setting changes. Writes are queued (bounded at 10,000) and flushed in 50 ms batches on an unref timer, so a slow disk never blocks the domain; the line cap is 8 KiB and the file and directory are owner-only.
3. **The sink is best-effort and never fails its caller.** `append` only enqueues and never throws; the queue reports a dropped count. The sink reports one failure state behind the `logs` health claim. `close()` stops accepting entries first, then drains the last batch with asynchronous writes, so shutdown keeps the final records.
4. **Metadata only, and an audit allowlist.** Entries carry an id, scope, level, message and small structured facts. Credentials and secret-shaped values are redacted before the ring and the file. The `audit` scope (M30) records only human-triggered domain actions — settings saves, Ticket retry/stop, escalation decisions, automation create/edit/run/delete — as `info` entries with `actor=operator`, the action name, and the affected ids, block and revision or counts. It never records setting values, reply text, automations' instructions, message content, tool arguments or results. Automatic lifecycle entries keep their existing scopes and are not audit entries.
5. **The browser reads and exports the ring; it never fetches a file route.** Copy and Download JSONL use the current filtered `entries` in the page: one JSON object per line with the same `at`, `level`, `scope`, `message` and optional `data` as the file, written through a Blob. Deep links from a Ticket, Request or Assignment are client routes that prefill `q=ticket=<id>`, `request=<id>` or `assignment=<id>`; no server route serves log files and no new API route exists.
6. **Logs are not archived.** `scripts/archive-state.mjs` snapshots the state database only (`<stateDir>/orchestrator.sqlite` by default, `--database` to override) because the database is domain truth. Log files have their own short retention window and must be copied by hand when a backup needs them.

## Rejected alternatives

- **Keep the memory-only ring.** It was the pre-M29 behaviour and lost exactly the evidence an operator needs after a restart, crash or upgrade. Increasing the ring size does not make it survive a process exit.
- **Store entries in a database table.** That adds write amplification and contention to the same WAL database the domain uses, requires schema migration to carry non-domain data, complicates retention pruning, grows every archive and backup, and makes a log write able to fail a domain transaction. The log is not domain truth.
- **Record full message bodies, tool arguments, results or prompts.** They are the data the privacy rules exclude, they grow without bound, and they make the file a second copy of secrets. An id and a state are enough to correlate an entry with the durable domain record.
- **Rotate by size only, or let an external log rotator own the files.** A single writer that knows the day, the size cap and the retention is simpler and keeps each file readable by date; an external rotator would need to know this format and could race the Host.
- **Serve the files through a new HTTP route.** It would add an authenticated file surface and another path to leak state, for a download the page can produce from data it already has.
- **Log every HTTP write, or every automatic action, in the audit scope.** That would bury the human decisions and misattribute system work to the operator; the audit scope is limited to the actions a person triggers from the panel.

## Consequences

- A crash or power loss can lose the entries accepted but not yet flushed — the last queue batch, at most the 50 ms flush window — while everything flushed survives the restart.
- One Host must own a state directory, because the sink assumes a single writer per day file. Shutdown drains through `close()`; an unclean exit leaves at most a torn final line, which the reader can ignore.
- Log files are local, owner-only files with a 1–30 day window. They are not in archive-state snapshots; the runbook tells the operator to copy them manually when needed.
- The audit scope adds human-triggered actions to the same ring and files, so a `GET logs?scope=audit` and an exported view can show who did what without showing the values.
- Tests: `tests/logs.spec.ts` pins the ring filters and keyword search; `tests/log-files.spec.ts` pins rotation, retention, the queue and close; `tests/operational-log.spec.ts` pins lifecycle and automatic entries; `tests/panel-logs.spec.tsx` pins search, copy, JSONL download, load-more and deep links; `tests/http.spec.ts` pins the audit entries and their metadata-only contents.

## References

- [005 Panel](../005-panel.md) — the Logs tab, its filters and its export.
- [006 Deployment](../006-deployment.md) — `stateDir` and the log directory.
- [007 Architecture](../007-architecture.md) — `src/app/logs.ts`, `src/app/log-files.ts` and the panel module.
- [013 Operations runbook](../013-operations-runbook.md) — log paths, retention, backups and manual copy.
- `src/app/logs.ts`, `src/app/log-files.ts`, `src/app/http.ts`, `src/client/logs.tsx`, `scripts/archive-state.mjs`.
