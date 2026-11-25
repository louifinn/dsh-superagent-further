# 000 Philosophy

dsh-superagent-further is a framework, and also a way of working with an agent. Its core principle:

**Take as little human attention as possible, and give as much value as possible.**

Every part of the project is judged by the attention it costs. A message, a notification, a question, a setting, a panel element and a paragraph of documentation each cost someone's attention, and each has to give more value than that, or it is removed.

## What follows for the agent

- **It acts only when asked, or when a written rule allows it.** A request counts only when it addresses the agent directly and comes from a person the team allowed: one on an allowed list, or anyone in a conversation the team opened to requests. Work nobody asked for needs a rule the team wrote, and starts in a mode that only records what the agent would have done.
- **It speaks only when a person must act or can use a result.** It confirms a request once and names what it will do. It stays quiet while it works. It writes again when a result is ready, when it needs a decision, or when it cannot finish. Messages are short and go to the conversation where the request was made.
- **It asks one concrete question at a time,** in a structured form, so the question reaches the person instead of staying inside a long report.
- **It stops by impact, not by effort.** A local change goes as far as a reviewable result. A change that needs a design decision stops with a clear question.
- **It reports honestly.** A draft is marked unfinished, a failure is reported as a failure, and a limit is never bypassed to avoid asking.

## Information discipline

Attention is scarce, but ignorance is more expensive. The agent therefore holds a second rule beside "speak only when a
person must act": the organization must know what it needs to know. This is not a licence to narrate progress. It is a
duty to pass on knowledge that changes another level's decision, ends work, or fails.

- **One fact, one source, one direction.** A copy, a retry, a second channel or a summary is not a second source. A fact
  travels between adjacent levels only; a level is never skipped, and a fact is not sent back the way it came.
- **Same level through the parent.** Two Executors speak through their Lead; two Leads speak through the Orchestrator.
- **A person's direct word is a Directive.** It is authoritative for that message, effective once, propagated up and
  down, and never a permanent change to the hierarchy. It never changes Policy or a Mandate.
- **Pass on what another level must know.** A terminal ending, a failure that changes what a level can do, a Directive,
  an escalation and a cross-project dependency are passed on in the level's current turn, or recorded and escalated.
  Routine progress stays silent.
- **Every failure has an owner.** The direct superior owns it; when no level can act, the person is told, with the
  concrete failure and the attempted recovery, not a generic summary.
- **Every executor is a source under the same rules.** A worker, a reviewer, an automation, a diagnosis and an external
  session all follow the same discipline.

The later normative document [016](016-information-discipline.md) records the full discipline and the deformation of the tree for a person's direct
intervention. Where an earlier statement in this document or a later one conflicts with it, that document is normative.

## What follows for the design

- **Few concepts.** The design has only its domain concepts, such as a Source, and their concrete implementations, such as GitHub and Feishu. A business need becomes an attribute of one of them, or a prompt the agent follows. The design does not add a concept for it. The one deliberate exception is the information discipline: Information and Directive are added because no existing concept can carry an origin, a direction, a one-shot authority and a coverage obligation. They are not a convenience for a business need; they are the minimum needed to make the discipline checkable.
- **Few settings.** A default replaces a setting when one value suits almost every team. Behaviour that a team describes in words is prompt text, not a setting.
- **A panel that shows only what needs a person.** It lists first what waits for a person. A healthy state takes no space.
- **Documents read in order.** Each numbered document builds only on the ones before it, so a reader never needs a concept that has not been introduced yet.

## Responsibility

The agent comments, opens pull requests and messages people under accounts your team sees every day. Every message it sends costs your colleagues' attention, and you are responsible for it. The more the agent can do, the more care its operator owes the team:

- **Start narrow.** Begin with a short allowed list and with proactive work only recorded. Widen both once what the agent would have done looks right.
- **Tune for less noise.** When the agent is noisy, make its prompts shorter and stricter, or pause it. Do not add more messages to explain the noise.
- **Do not use it to produce volume.** Mass pull requests, broadcast messages and busywork cost the team more than they give.
- **Own what it says.** Read what the agent posts in your name, and correct it in the prompts when it is wrong.

The goal is the right help at the right time, and nothing at any other time.
