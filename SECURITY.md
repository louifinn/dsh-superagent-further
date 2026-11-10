# Security policy

DSH SuperAgent runs as a plugin inside a DeepSeek Harness Host on a machine the operator controls. It reads GitHub and
Feishu through the operator's own credentials and executes worker agents in local checkouts. This file states what the
project treats as a security boundary and how to report a problem.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it privately through the repository's
**Security → Advisories** page on GitHub, or email the maintainer listed in `package.json`. Include the version, the
profile configuration (redact tokens), and a reproduction. We acknowledge within a week and will agree on a disclosure
date with you.

## Boundaries

- **Credentials stay in the Host profile.** Source credentials (`gh-agent`, `lark-cli`), the model provider key and the
  panel token are read from the operator's environment by the Host; the plugin never stores or echoes them, and model
  prompts contain Ticket text, not credentials.
- **Only the panel can confirm work.** The management API checks `Origin` and the `X-Orchestrator-Request` header and
  serves loopback by default; a decision, approval, Settings proposal or automation change made elsewhere is not trusted.
- **Worker Sessions run in their own checkout.** A change Ticket gets a worktree on `agent/<name>`; an answer Ticket
  reads the project's live checkout with write tools removed and a read-only profile. A worker cannot push, merge, close a
  pull request or change policy; those need the origin Thread or a person.
- **The Policy is the trust boundary.** A Trigger is accepted only under an enabled rule and an admission row; inferred
  acceptance is recorded, not acted on, unless `eval.mode` is `auto`. A Source cannot mint authority by itself.
- **State is local.** `state.sqlite` and the worktrees live under the profile's state directory; the plugin sends to the
  network only through the configured Sources (GitHub, Feishu) and the model provider.

## Hardening checklist

- Bind the panel to loopback (default) and keep `webServer` off untrusted networks; the token is the only session gate.
- Run the Host as the operator account, not root; worker ACLs are owner-only.
- Keep `executor.maxWorkers` and `projectWorkers` small; a runaway automation is bounded by the admission and reply rules.
- Review `Settings → Executor → blockedCommands`; it cannot list the worker's own commands but blocks everything else.
- Archive state before upgrading, and treat a schema bump as one-way for an installation that cannot be rebuilt.
