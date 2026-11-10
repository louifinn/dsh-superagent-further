# 003 Execution

This document follows an accepted Ticket through execution, delivery and recovery. It builds on [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

## Ticket stages

Each open Ticket has one stage, determined by what it is waiting for. Read the table from top to bottom; the first matching row wins.

| Stage | Condition | Panel label |
| --- | --- | --- |
| person / delivery | Delivering an Input to the Executor Session failed; it is retried after 2 seconds, then after a delay that doubles up to a minute, and a success, a new Assignment or the Ticket's end clears it | Input undelivered |
| person / answer | It has an Attention | Awaiting answer |
| person / review | The latest Report is `ready` | Awaiting review |
| person / blocked, failed | The latest Report is `blocked` or `failed`, and no person's message reached the Ticket since | Blocked · Failed |
| working / queued | No Assignment, or a pending one | Queued |
| idle | The latest Report is `waiting`, or the Assignment ended | Waiting for a Trigger |
| working | Everything else | Working |

A `person` stage means the Ticket cannot continue without human input. A new human message releases a `blocked` or `failed` Ticket to its Executor, so it moves to the next matching stage, usually `working`.

An `idle` Ticket has finished its turn without an outstanding question. A Trigger on a subscribed Thread can continue it.

## The Executor

Each Ticket gets an Executor Session named `worker-<ticket id>` and a directory named after the Ticket's short name. Directories are created under the configured execution root, which defaults to `<stateDir>/work`, in a `<project>` subdirectory when the Ticket names a registered project.

Executors of a Ticket whose project is registered run as subagents of that project's Lead Session: the Lead is the parent, the Executor stays out of the Session list, and new input reaches it through the Lead rather than by prompting a Session it does not own. A worker activation starts with DeepSeek Harness delivery `caller`, so DSH injects no settlement message into the Lead; the application's own durable Lead messages are the single notification authority. A reviewer subagent starts with delivery `parent` instead: it has no application tool of its own, so DSH's settlement notice is what puts its closing verdict in front of the Lead, which records it with `lead_review_record` (docs/012 D14). A request no registered project can own is refused at acceptance and points at **Execution → Projects**; onboarding requires at least one project before the host starts (`SetupError('projectUnset')`), so there is no root-Session execution path. The root arrangement is otherwise the one described in the next paragraphs.

When a Report ends the Ticket that made it — a `ready` Report on an `answer` Ticket, or a `dropped` Report — the ending is recorded inside the Report call and must not cancel the turn still running that call. The Executor stops the worker only after the ending transaction commits: for cause `report` it waits, bounded by `RETIRE_GRACE_MS` (60 s), for the worker's turn to end, then disposes the activation and stops the worker's background work without cancelling the turn. A turn that outlives the grace is cancelled as a person's stop, with the Report already recorded. A `human` stop, a followed pull request's close (`merge`), an Eval stop (`eval`) and a retry preempt the turn at once, because that work is no longer wanted; a retry ends the Assignment but not the Ticket. A rolled-back end leaves the worker running. The reasoning is recorded in [ADR 0001](adr/0001-ticket-end-authority.md).

Executor Sessions run commands without approval as the operator's OS user. Their `dsh-superagent-further-worker` preset contains the tools needed for work and moves foreground shell commands to background jobs after 5 seconds. A job wait lasts 60 seconds by default, up to 10 minutes, so a worker can wait for a job to settle before ending its turn. This lets a worker receive new messages at the next step instead of waiting for a long command to finish.

The main Session uses `dsh-superagent-further-router`, with the same 5-second shell limit, 5-second job waits, and a smaller tool set for routing. Sessions retain the preset selected at creation. Worker subagents use DeepSeek Harness's `standard` preset.

### Background work and worker slots

When a turn ends with shell jobs or subagents still running, the Ticket keeps its worker slot and stays working. It is not reported as waiting, and the main Session receives no waiting report. A completed job or subagent wakes the Executor with its result in the same slot. Once a turn ends with no background work, the Executor reports waiting normally.

After each turn, background work has at most 30 minutes to finish. At that limit, shell jobs are killed and the Ticket is reported waiting. The report includes the Executor's last words and which jobs were killed or subagents remain active. Subagents are allowed to continue. The Executor reads killed-job results on its next turn.

A handoff to a person frees the slot immediately and leaves the Report in effect. This applies after a `ready` Report or a question, unless another Input arrived since, and after any `blocked` or `failed` Report.

At handoff, subagents stop. Shell jobs, such as a server offered for review, may continue until the Assignment ends. They hold no slot and are exempt from the 30-minute limit, including after later turns. Their completion does not wake the Executor; it reads the results on its next turn.

A person can also start a turn by writing directly in the Executor Session. Its background work follows the same rules.

When an Assignment ends, its shell jobs are killed without waking the Session. Its subagents are released, and any completion turns they wake are dropped. The replacement Assignment and its waiting Inputs start after that shutdown finishes.

Stopping or restarting the plugin inside the DeepSeek Harness process uses the same shutdown path. Inputs not yet taken into Session history are retained. Shutdown waits up to 10 seconds for each worker's background work; a process restart ends that work outright. An Assignment interrupted while busy restarts with a recovery note.

Worker subagents, including nested ones, use DeepSeek Harness's `standard` preset with the worker's permissions. They retain only the worker's allowed work tools, and lose those tools when the Ticket ends. Under `standard`, a shell command moves to the background after 60 seconds. A subagent's jobs are killed when it ends.

### Preparing a Ticket directory

Before the first Assignment, if the Ticket directory does not exist, the prepare command runs once with `sh` in the execution root. It has ten minutes to finish. Without a prepare command, the worker starts in an empty directory.

A failed command fails the Ticket and records its output. A retry or a person's message on one of the Ticket's Threads tries preparation again. A typical command uses `git worktree` to create a checkout. A pull request belongs to the Ticket when its branch's last path segment matches the Ticket's short name.

### Concurrency

A Ticket holds a worker slot from the start of a launch, including preparation, or from the delivery that wakes its idle Executor. It also holds the slot throughout an active turn.

The configured concurrency limit applies to these slots, with one extra slot for a person's message or a status request. Such a wake can use the extra slot when normal slots are full, and takes the next free slot before a new launch. New work therefore cannot prevent a person from continuing an existing Ticket.

Other Inputs, such as CI results, wait for a normal slot. A launch waits in `working / queued` until a slot is free. Launches run concurrently, so a slow prepare command delays only its own Ticket.

### Execution variables

The prepare command and Executor instructions receive the same execution variables. The command reads environment variables; the Executor reads their values and descriptions in its prompt. None contains credentials.

| Variable | Registered by | Value |
| --- | --- | --- |
| `DSH_SUPERAGENT_DIR`, `DSH_SUPERAGENT_NAME`, `DSH_SUPERAGENT_TICKET` | Executor | The Ticket's directory, short name and id |
| `DSH_SUPERAGENT_BLOCKED_COMMANDS` | Executor | Commands the Executor may not run |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | The repository the Source watches, `owner/name` |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT`, `DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | The agent account and its commit email |
| `DSH_SUPERAGENT_GITHUB_NUMBER`, `DSH_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | The Issue or pull request that started the Ticket, and its head ref when it is a pull request |
| `DSH_SUPERAGENT_FEISHU_BOT`, `DSH_SUPERAGENT_FEISHU_CHAT` | Feishu | The bot, and the chat that started the Ticket |

Ticket-specific values come from its directory and originating Trigger. Other values come from the current deployment settings. Only the panel can change execution environment settings; text sent to the main Session cannot change the configured shell command.

Workers reach GitHub through the agent account's `gh` and Feishu through the bot's `lark-cli`. Blocked commands fail when invoked by name.

These wrappers and directories establish defaults, not a security boundary. A worker can still execute a program by absolute path.

## Merging

Auto-merge is governed by the **Delivery requirements** prompt. The host has no merge-specific decision logic.

By default, the Executor never enables auto-merge as the agent account: GitHub attributes the merge to whoever enabled it. Delivery requirements must name another account's CLI for merging. Without one, people merge the pull request.

The default instructions allow auto-merge only for a pull request opened for the Ticket, when it is ready, the required approvals cover the head commit, and additions plus deletions total fewer than 200 lines. Before pushing another revision, the Executor withdraws auto-merge.

Reviews without a body, such as approvals, also arrive as Triggers and can wake an Executor waiting for review. These instructions govern the agent, not GitHub's merge rules. To enforce approvals, require them in branch protection and dismiss stale approvals. Omit the merge CLI or remove the auto-merge paragraph to require manual merging.

## How a Ticket ends

- **Ready on an answer:** a `ready` Report ends an `answer` Ticket as completed; it reads the project's live checkout and opens no branch or pull request. The Report is the ending record, and the turn that made it is not cancelled: the Executor retires the worker after that turn ends (see **The Executor**).
- **Ready on a change without a pull request:** a `change` Ticket is refused with `changeNeedsPullRequest`; it names the pull request in its report and ends only through the Threads it follows.
- **Review gate:** a change Ticket may carry a review its project Lead started with `lead_review`. A `clean` verdict lets a followed pull request's merge end the Ticket; a `blocked` verdict keeps it open even after the merge, so a person resolves the findings (docs/012 D14).
- **Verification evidence:** a Report may carry at most 20 checks, each a name, an optional command, an optional integer exit code and optional evidence text. The Assignment keeps them, the Ticket shows them as evidence, and a request's result notice counts them. The Executor reports only checks it actually ran.
- **Nothing to do:** an Executor that finds no work for a person to act on, such as a request that does not reproduce or is superseded, reports `dropped`. The Ticket ends without a message, unless a matched rule asks for one, and a person's later message on its Threads resumes it.
### Pull requests

When a followed pull request merges or closes, the Orchestrator also tells the Ticket's project Lead, which relays the end to the Ticket's worker Sessions (`lead_notify_worker`); GitHub timelines already show the merge, so the IM notice is the only external Channel notice. A `change` Ticket follows the pull request it started from once its Executor reports it. It also follows each pull request opened from its branch once reported by the Executor or found by the GitHub Source. Reopened pull requests are followed again.

The Ticket is done when none of the pull requests it opened remain open. If it opened none, all pull requests it follows must be closed. It then ends with the outcome of the last relevant close and keeps its Subscriptions, allowing a later human comment to resume it.

A close does not end the Ticket while resumed, retried or recovered work is unfinished. It also waits if the Executor acknowledged or answered a follow-up it owns but has not since made a non-progress Report or ended a turn after reading that message. A later `ready` Report ends the Ticket once the same pull-request completion rule is satisfied.

Chat Channels receive one final notice about the pull-request outcome, and a root project Request adds one aggregate report across its Tickets and derived requests when its Lead completes it. GitHub already displays the outcome on the pull request itself. Removing a Ticket's Subscription to a pull request also stops it following that pull request.

"Awaiting review" therefore means a `ready` Report with a pull request on a `change` Ticket.

### Project requests

A worker that finds a missing decision, a new deliverable or work for another project raises one durable project request with `request_create({ title, instruction, kind?, parent?, evidence? })` instead of guessing or widening its Ticket. The request names its project and its raising Ticket or Session. A repeated title on the same Ticket returns the existing open request, and optional evidence is kept with the instruction. The worker's completion report lists the requests it leaves open in `requests`; a non-progress report that omits an open unanswered request is refused with "Name the unanswered project requests this report leaves behind in requests: <ids>".

The project Lead answers through its project-request tools. Every disposition carries a non-empty reply, which is delivered to the raising Session; the runtime re-prompts a Lead whose turn ends with an unanswered request, at most twice, and then records the request as needing attention without closing it. Accepting a work request creates the domain Request and its staged Tickets under a Lead Mandate confined to that project. Up to eight `deliverables` become Tickets in that project, keeping their `after` edges; the statement sets the work's scope. Rejecting or asking `needs-info` records the decision and the reply and changes nothing else. A derived request raised by a worker of that Request's Tickets keeps the root pointer, and its own Tickets count toward the root's report.

When the root request and all derived work have ended, the Lead completes it with one summary; the host sends one aggregate message per Channel of the root request and its originating Trigger, listing every Ticket with its pull-request outcome when it has one, every derived request and the summary. The ordinary `request.ended` notices still describe each Request on its own.

An architecture request follows the same raise and accept path, but its accept creates one standalone design Ticket instead of a Request. When the design ends, the Lead sends the proposal to the root Thread and marks the request `awaiting-approval`; a person's reply on that Thread is routed to the Lead, and `lead_request_approve` records the approval only from a human Trigger written after the proposal. Approval creates the implementation Request and its staged Tickets; rejection records the answer and ends the request.

A request the Lead leaves unanswered after two reminders stays open in the store and is marked as needing attention for the Orchestrator and the panel; a later answer follows the ordinary path.

Work that belongs outside the project is escalated, never widened: `lead_request_escalate` records a pending escalation, the Orchestrator lists it with `orchestrator_escalations` and answers it with `orchestrator_escalation_decide` and its mandatory reply, and an accept creates one installation-level Request under an `escalation` Mandate. An installation automation delivery can create such a rootless installation Request directly from the main Session with `orchestrator_request_create`, recording the automation id (`docs/012-project-requests.md` D12, D13).

### Follow-ups and context Threads

The Executor decides human follow-ups on its Ticket's own Threads. It handles in-scope requests and hands back requests beyond its scope or for another Ticket. Once no Executor owns the message, it becomes a candidate for the main Session. The main Session may otherwise act on the follow-up only to stop work at the person's request.

An Input counts as read after the Session takes it into a step and subsequently reports or ends a turn. When a Ticket ends, unread messages that were not acknowledged, answered or handed back return to Eval, as described in [002 Authorization](002-authorization.md). Read messages left without action, such as thanks, do not.

Threads followed only for context still deliver messages, but do not give the Ticket ownership of human follow-ups or resume ended Tickets. Those messages can be assessed independently.

Sources poll subscribed Threads while a live Ticket subscribes, and for two weeks after the later of the last Trigger and the subscribing Tickets' end. Afterwards, messages arrive only through ordinary intake: GitHub notifications or Feishu live events.

## Failure and recovery

### Executor blocked or failed

When an Executor Session reports `blocked` or `failed`, or fails to start or errors, which records `failed`, the Ticket takes no automatic Input.

A passing failure of the model provider or the network, an HTTP 408, 429 or 5xx or a refused, reset or timed-out connection, is tried again first, three times with a growing backoff: a launch runs again, and a worker whose turn failed is told to go on; a failed prepare command is not tried again.

Once failed, CI and bot messages are recorded on it, but they are not delivered and do not wake the Session.

Its tools stay available, so a person can continue in the Session directly.

A launch that failed is not tried again on its own.

A person's message, a later Report that is neither `blocked` nor `failed`, or a retry ends the hold.

It is worked out from the stored Reports and Inputs, so a restart keeps it.
### Retry

Available while an open Ticket is in `person / delivery`, `person / blocked` or `person / failed`: a new Assignment, which starts its worker again and takes the Inputs that wait, is the remedy for each.

Once a person's message reached a blocked or failed Ticket, the Executor has the message, so the Ticket shows as working, or as queued when a failed launch starts again, and offers no retry, unless delivering that message failed.

A retry ends the current Assignment and starts a new one in the same Executor Session, directory, branch and pull request.

The Executor model applies only when a Session is created; an existing Session keeps its model.
### Restart

Running Assignments end with "host restarted" and new ones start with a recovery note that tells the Executor to check its directory, git history and GitHub before repeating any outside action, oldest Ticket first.

Assignments that are waiting, ready, blocked or failed stay as they are, unless an Input reached them after that Report, in which case they start again too.

Sessions, directories, Subscriptions, pending messages and the stored work below survive a restart, and so does the record of which messages each Executor Session took into its history, which a step does once it claimed them and before its model call: a message taken by a turn the restart cut off counts as read once a Report or the end of a turn follows, while one a step claimed but a cancel or error cut off before the history counts as unread.

A retry or a restart gives the new Assignment again the messages delivered to the Assignment it replaces that its Executor Session did not take, which a cancel or a cut-off step may have dropped; a copy still waiting in the Session, kept by a restart or persisted across a crash, is taken out before the new Assignment's first message, so the new delivery is the only copy.
### Stored work

What dsh-superagent-further does after a decision, such as relaying a candidate, a follow-up or a report to the main Session, launching an Assignment or delivering an Input, is stored first and done afterwards.

A relay or a delivery that fails, such as when its Session cannot be reached, is retried after 2 seconds, then after a delay that doubles up to a minute; a launch that fails fails its Ticket, unless the failure was a passing one, as above.

Each kind of work reports an error among the overview's system problems only after one item failed three times in a row; a failed Input delivery shows on its Ticket instead.

Relays to the main Session keep their order, and so do notices; a failed one holds back the later ones of its kind.
### Source failure

The GitHub Source reads each Issue, pull request and Thread on its own: a failed read keeps its error on its Thread, is read again on the next poll, and counts towards an error of the Source, which it reports after three failed polls in a row by default; any successful poll resets the count.

GitHub answers 404 also when the agent lost access to a private repository, so a 404 is retried.

A notified Issue or pull request whose reads keep failing is dropped a day after its first failed read, and at once when GitHub reports it as deleted; it then no longer fails the poll, its Thread keeps the error, and the Source's state names it.

Its read position stays where it was, so a later notification or a poll of its Thread reads what the failed reads missed.

The Feishu event consumer reports every failure, and polling of subscribed topics keeps each failure on its Thread.

A malformed item in a GitHub list or a Feishu page is skipped, and the Source's state counts it.
### Channel failure

Outgoing messages are stored and sent as stored work, retried with backoff from 5 seconds, doubling up to 300.

A Ticket's messages to one conversation go out in the order they were queued, so its acknowledgement comes before its later answer or result: a message waits while an earlier one of the same Ticket to the same conversation has not gone out, until that one has failed three times in a row and shows as a problem.

Messages of other Tickets, and messages of no Ticket, do not wait for it.

A message with failed attempts is a system problem until it goes out or is withdrawn.

A message is dropped only when its Source no longer listens to the conversation, or when the Source answers that the conversation can never receive it; while its Source is off, it waits.

The Sources answer that for a deleted Issue or a locked conversation on GitHub, and for a recalled message or one Feishu no longer finds on Feishu.

A reply to a review comment that no longer exists goes to the pull request's conversation instead.

A dropped message keeps its record, with when and why it was dropped and the Ticket it was for, so it is never queued again; a dropped acknowledgement reads as dropped, not sent.
### Pause processing

Stops dispatch, new Evals, Eval timeouts, Input delivery and replies; a launch already under way waits until processing resumes.

Sources keep recording Triggers, and a running Executor turn is not interrupted.

A person's message to an ended Ticket waits: the first pass after the pause resumes the Ticket, if its Mandate holds under the Policy then.

An Eval in progress does not expire during a pause; its deadline moves later by the pause's length.
### Invalid configuration

A stored Source configuration that its kind rejects disables that Source instance.
