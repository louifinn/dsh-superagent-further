# ADR-0008 — The project Lead manages every Worker of its project

Status: accepted (2026-11-12)

## Context

A Worker runs as a DSH subagent of its project's Lead Session (ADR-0006 of `docs/007`); there is no root-worker path. The
Orchestrator could nevertheless reach a Worker's Ticket directly: `orchestrator_ticket_retry`, `_request_status` and
`_note` wrote the Ticket or its Assignment, and `orchestrator_route` could attach a Trigger or stop a Ticket. Nothing
guaranteed that a project with an open Ticket had a Lead at all: Leads were created lazily, an archived Lead resolved
without being unarchived (DSH then refuses every model step), and a project could be removed from Settings while its
Tickets were still open.

## Decision

1. **The Lead owns Worker management.** A project Lead gets `lead_ticket_attach`, `lead_ticket_stop`,
   `lead_ticket_retry`, `lead_ticket_note` and `lead_ticket_request_status`. Each checks that the Ticket belongs to the
   Lead's project; the Engine still refuses a Ticket whose latest report waits for a person's answer, and every command
   keeps the Ticket's existing mandate instead of creating one.
2. **The Orchestrator instructs, it does not command.** `orchestrator_lead_instruction` writes one durable
   `lead_message` (`kind: instruction`, request id `lead-instruction:<ticket>:<nonce>`), prompts the project Lead, and
   returns that id. The Lead answers with `lead_instruction_reply`, which applies the matching Ticket command once,
   acknowledges the record, and writes a `notice` back to the Orchestrator. One reply per instruction.
3. **The Lead-session guarantee.** Every project with an open Ticket has a Live Lead at every start: `Runtime.initialize`
   calls `Sessions.ensureOpenTicketLeads()` (skipping unregistered projects, warning instead of failing the start), and
   `Sessions.ensure` unarchives an archived Session before returning it. Settings refuse to remove a project that still
   has open Tickets (`projectHasOpenTickets`). Accept-time project validation already refuses a Ticket naming an unknown
   project.
4. **Person actions stay direct.** The panel's `POST tickets/:id/retry` and `POST tickets/:id/stop` are people's own
   actions (`EngineForPeople`); they do not pass through the Lead. The stalled watchdog keeps writing its waiting
   Report/attention into the Ticket and notifying the Lead — it records state, it does not command a Worker.

## Consequences

- A Worker is only touched through a Lead that is live, of its project, and has taken the instruction; the Orchestrator
  can no longer write a Worker's Input or Assignment directly.
- `orchestrator_route` no longer needs attach/stop for Worker management; those kinds move to instructions in a follow-up
  change that also converts the remaining routing tests. Until then they remain accepted for routing a person's stop
  message, and the Lead tools are the supported path for managing a Worker.
- An instruction that the Lead does not answer is detected by its durable record; the bounded re-prompt and the timeout
  notice belong to the same flow as the Lead activation boundary (a follow-up hardening item).
- The guarantee is enforced at startup and at save time, not only at launch: a project removed while Tickets are open,
  an archived Lead, and a missing Lead now fail closed or are repaired rather than stranding a Worker.
