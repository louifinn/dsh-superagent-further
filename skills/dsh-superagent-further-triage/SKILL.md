---
name: dsh-superagent-further-triage
description: Classify a GitHub Issue or pull request, suggest a next step, and apply only existing repository labels through orchestrator_label.
---

Triage is a read-only judgement unless the operator explicitly authorizes a label change. Read the object with
`orchestrator_read`: `github/issues/<number>` or `github/pulls/<number>` for the description, then the conversation and
CI pages it names. State the category (bug, enhancement, question, documentation, duplicate, invalid), a severity or
priority when the object gives enough evidence, and one concrete next step.

The repository's canonical triage labels are `needs-triage`, `needs-info`, `ready-for-agent` and `ready-for-human`
(plus `wontfix` for declined work). Discover the labels that actually exist before proposing any; use
`orchestrator_label` with the trigger id to add or remove only those labels, and never create, rename or delete a
label. Without an explicit instruction to change labels, report the suggestion and change nothing.

Raising work is separate: if triage shows the request needs a decision or a cross-project change, raise a project
request through the Lead path (`request_create` for a worker, `lead_request_create` for a Lead) instead of a Ticket.
Include the label decision and the reason in `orchestrator_report` so the source conversation reads why.
