---
name: dsh-superagent-further-project-request
description: Raise and answer project-level requests: worker request_create, Lead disposition, Orchestrator escalation, and independent DSH Session submission.
---

Project-level requests carry decisions that a single Ticket must not make alone. Pick the smallest path that owns the
decision:

- **A worker inside a Ticket** raises one with `request_create` (title, instruction, kind, evidence) when the work
  needs a decision, a new deliverable, or another project's change. The Ticket stays open; the completion report must
  name every request it leaves with `requests`.
- **A project Lead** answers with `lead_requests` and `lead_request_decide`/`lead_request_reply`/`lead_request_complete`
  or `lead_request_approval`; every disposition needs a non-empty reply, which is delivered to the raising Session.
  Accepting work creates the Request and its staged Tickets under a Lead Mandate confined to that project.
- **A Lead with work outside its project** escalates with `lead_request_escalate`. The Lead cannot decide an
  escalation; the Orchestrator lists it with `orchestrator_escalations` and decides it with
  `orchestrator_escalation_decide` (accept needs at least one delivery unit). The decision and its reply are delivered
  back to the Lead.
- **An independent DSH Session outside SuperAgent's management** submits through the global `superagent_submit` tool;
  the request is judged by the operator's Policy like any other, and the decision and final result are delivered back
  to that Session.
- **The Orchestrator** turns an installation automation delivery into work with `orchestrator_request_create`,
  naming the installation automation as the source.

Architecture-level work needs a person's approval on the root conversation; the Lead produces a design document first
and requests approval, then implements only after the approval arrives. Never bypass the Policy, never invent a
delivery unit for an absent project, and always answer the person or Session that raised the request.
