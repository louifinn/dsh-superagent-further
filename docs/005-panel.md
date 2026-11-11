# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

Open **Superagent** for the Overview tab: what needs a person, the last day, and the Executor. The Source tab adds
each Source's health and, for a polling Source, when it checks next. The release check in the deployment guide says how
to capture these views for a release; screenshots are deliberately not committed, because a real host shows the
operator's workspace and account names.

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Source**, **Trigger**, **Eval**, **Execution**, **Memory**, **Automations**, **Incidents**, **Logs**, and **Settings**. Until repository and account setup succeeds, Overview shows what is missing and links to the relevant setting.

| Tab | Shows |
| --- | --- |
| Overview | Tickets needing action, open Requests, open escalations awaiting the Orchestrator, self-evolution Issue drafts awaiting approval, automation records needing attention, open deterministic incidents (a "needs you" block with each incident's severity, rule, occurrences and last-seen time, linking to its page), system problems, activity counts for the last 24 hours, Executor load, and the Project Leads block: one row per registered project with its Lead Session's state and its pending project requests. A self-report draft shows its title, target repository, an evidence preview and its age, with Approve and file and Dismiss actions that audit the decision; an incident's self-report resolution deep-links here and highlights the named draft row; when the day's three-Issue cap is reached the block says so. A file the Orchestrator could not send appears as a problem with its path, target chat and the Source's own reason; its full reason is also in the Logs tab. An escalation can be decided here with its required reply (accept starts one Ticket in the escalating project; reject and needs info record the reply), or from the main Session when its units belong elsewhere. Each block links to its detailed page |
| Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as Overview |
| Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Eval | Decisions with their reason and matched rules |
| Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, authorization, waiting Inputs, Subscriptions and Assignments. The Workers block below the filters shows each open Ticket's worker Session, its Assignment state, and each background job's status, start or end time, detail and latest output preview; a job still running shows its output so far, read without waiting on it. The Logs group sets the Host log's level (`info` or `debug`) and retention (1–30 days), both applied immediately. The Incidents group sets deterministic detection and read-only diagnosis: enabled, auto-diagnose (high and critical records only), the daily new-record budget, the daily diagnosis budget (0–24, default 2) and the minimum severity, each saved with the Executor block |
| Memory | Labeled experimental and off by default: the master switch, the injection and automatic-write switches (pre-injection is also off by default), snapshot limits, and the stored memories: search, sort and project filters, expand for the full record, pin or forget one |
| Automations | Installation- and project-scope scheduled tasks: create, edit, run now, delete with confirmation, delivery history and the missing Host schedule service state |
| Incidents | The deterministic incidents the host recorded on its own, newest first: severity, title, the rule, the scope ids, status, occurrences and last-seen time. The status filter starts at open (detected, bundled or diagnosed) and the severity filter narrows further; a row opens the detail, which adds the fingerprint, first and last times, the plain detail, the parsed diagnosis (root cause, evidence, hypotheses, fix plan, confidence and target), the resolution link, and the evidence bundle: its directory under `<workspace>/artifacts/incidents/<id>/`, the manifest's content digest and version, and each file's size and SHA-256. Detect and bundled records offer **Diagnose** (a read-only child Session, pending while it runs, with the failure shown), diagnosed records offer **Create fix** (a confirmation first, then a discovery Request or a self-report and a link to it; one route runs at a time per record, an overlapping click shows the refusal, and a route that loses to a dismissal or a repeat leaves the newer record and its reason intact) and every open record offers **Dismiss** (a required reason). Detection makes no model call and fixes nothing automatically; a dismissed record shows the localized dismissal reason, and its self-report resolution opens the Overview with the named draft row highlighted. |
| Logs | The Host log, newest last: a level filter (all, warning and error, error only), a scope filter, and a keyword search over the message, scope and structured data. **Copy** copies the current filtered view as JSONL, **Download JSONL** saves that view in the browser, and **Load more** raises the shown rows from 200 towards the ring's 2000. A Ticket, Request or Assignment links here prefilled with `q=ticket=<id>`, `q=request=<id>` or `q=assignment=<id>`, and the API's `GET logs` takes the same `q`. Human-triggered domain actions — settings saves, Ticket retry and stop, escalation decisions, self-report approve and dismiss, and automation create, edit, run and delete — are recorded under the `audit` scope with `actor=operator` and ids and counts only, never setting values, reply text or other content. Debug and info entries appear when the log level allows them, and the other scopes name the domain: startup and lifecycle (`runtime`, `trigger`, `ticket`, `request`, `assignment`), reply delivery (`outbox`), the Runtime's own warnings including a failed file delivery (`host`), the plugin's own warnings (`session`, `setup`, `automation`), worker launches, retirements, preemptions, turns, background jobs, reports and agent errors (`executor`), a Source kind such as `feishu` or `github` for its polling, or a health claim such as `logs` for the file sink. Every entry is also appended to durable JSONL files under `<stateDir>/logs`: one file per UTC day, rotated at 20 MiB, kept for the configured retention (1–30 days) and pruned at startup and day rollover. Only structured metadata is recorded — never message bodies, tool arguments or results, report summaries, setting values, or model prompts and output |
| Settings | Sources, Eval, Execution (including the Incidents detection and diagnosis settings), Language, Prompts and Deployment. The Eval group holds the accept mode, the self-report gate (`off`, `observe` or `auto`) and the Eval timeout and model, each with its save history. Each group includes its save history |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged**, **Answered** or **Stopped by a person**.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts. GitHub also offers receive-all switches for new Issues, pull requests, comments and default-branch CI. Polling and read limits are under Advanced.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. The built-in rules show their Chinese names and instructions; each row expands for editing, can be duplicated or removed, and its switch enables or disables it. All sixteen built-in categories ship enabled; the operator can switch any of them off. The history below the form words rule changes in Chinese, naming the rule that was added, renamed, re-worded, enabled, disabled or removed. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model.
- **Execution:** the Orchestrator workspace card, worker model, concurrency, directory root, the registered projects, prepare command and blocked commands. The workspace card shows the explicit DSH title (`dsh-superagent-further · <directory name>`) and the canonical path, and saves through the workspace settings block with its own revision; the history lists workspace saves beside executor and pause. Clicking an available variable inserts it into the prepare command.
- **Language:** the default language for words a person reads, saved with the block's revision; the next model request uses it, and the runtime context names it to every Session.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution. Settings are grouped by the concept they configure. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.

## Setup wizard

A first run — no workspace selected, or no project registered and no recorded answer — opens the setup wizard by itself when the panel loads. It opens once per browser session: closing it does not mark it answered, and a reload does not open it again. **Setup wizard** (设置向导) in the header reopens it at any time, before and after the first run ends.

The wizard walks through welcome, the Orchestrator workspace, the first project, the GitHub agent account check, the optional Feishu Source, the default language and a summary. **Skip this step** moves on without saving, **Skip the wizard** ends the whole flow, and **Back** returns to the previous step; saved steps apply immediately. The workspace step is mandatory: until a valid workspace is saved, **Skip this step**, **Skip the wizard**, the primary button and closing the dialog are inert, and the server also refuses a wizard skip with `workspaceRequired`. The step validates the same way startup does — absolute path, empty directory or one carrying the workspace marker, not the state directory, a DSH home or profile, a source checkout or a project workspace — and shows the resulting title. A save that restarts dsh-superagent-further says **Restarting…** and the panel reconnects on its own. A refused save leaves its error on the step that raised it.

The workspace, project and language steps write the same settings blocks as Settings → Execution and Settings → Language, with the block's current revision, so the two surfaces never disagree. Skipping or finishing writes a marker to the Store's key-value area; that marker is what ends the first run, and an empty workspace always keeps the first run open. The browser session only keeps the closed wizard from reopening while the panel stays open. Registering a project also ends the first run without an answer, and the header entry stays available.

The wizard is a dialog over the current page, so the page behind it keeps polling; closing the dialog leaves the rest of the panel usable.
