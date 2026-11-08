# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

On Windows, POSIX file modes restrict nothing, so the state directory and the database are given an ACL that removes inherited permissions and gives the operator's account full control (`icacls`), the Windows equivalent of the `0700` directory and `0600` file used elsewhere. Explicit entries the path already carries, such as `SYSTEM`'s, stay. If Windows refuses the change, the log says so and the files keep the permissions they inherit.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm and git 2.32+. macOS, Linux and Windows 10/11 are supported: the service script is plain Node, so Python and tmux are no longer needed. On Windows run it as `scripts\dsh-superagent.cmd` (the `.cmd` wrapper runs the same script)
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

   On Windows, write the same wrapper as a batch file, `%USERPROFILE%\.local\bin\gh-agent.cmd`, and sign it in from `cmd`:

   ```bat
   @echo off
   set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-agent"
   gh %*
   ```

   ```bat
   gh-agent.cmd auth login
   gh-agent.cmd api user --jq .login
   ```

   The Deployment page saves the repository and the agent CLI, and verifies both before it stores them. Saving the Source with no repository is the exception, so you can unbind an installation: the service then waits for setup again, as on its first run.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   On Windows, set the variables in `cmd` or PowerShell and write the wrapper as `%USERPROFILE%\.local\bin\lark-bot.cmd`:

   ```bat
   set "LARKSUITE_CLI_CONFIG_DIR=%USERPROFILE%\.lark-cli-dsh-superagent"
   lark-cli config init --app-id <cli_…> --app-secret-stdin
   lark-cli config strict-mode bot --global

   :: lark-bot.cmd
   @echo off
   set "LARKSUITE_CLI_CONFIG_DIR=%USERPROFILE%\.lark-cli-dsh-superagent"
   lark-cli %*
   ```

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

   The Source can also post a **daily digest** to one chat: set **Daily digest chat** and **Digest hour (local)** in its settings below. Once a day, at that local hour, it posts a new message to the chat — not a Thread reply, and with no history to read — listing the Tickets that wait for a person, what each needs, how long it has waited, and how many are working. When waiting Tickets name projects, the list is grouped under the project names from the Execution settings (Tickets without one come last as “No project”). A quiet day still gets one line saying nothing waits. The digest reports its own `digest` health entry, so a failed send shows in the panel, and it tries again on its next minute check inside that hour. When Requests are in flight, it also names each one with the number of Tickets delivering it, so cross-project work is visible as one ask.

#### What a Feishu Source receives

- **Chats it lists.** Each entry takes `@`-mentions only or all messages. Several chats can be listed, and each keeps its own history cursor and its own reads; a message is received once, from the chat it was sent in. One group can manage every project: a Feishu message names no repository, so the main Session's card lists the registered projects and the accepted work names one, or names a project id in the message itself; the Ticket then checks out in that project's workspace.
- **Chats it does not list.** The bot may already be in other chats. With **Other chats** set to `@ only`, a mention there is received and the Policy's `other` row decides whether it may start work; otherwise those messages are dropped and counted under the Source's health.
- **Direct messages.** With **Receive direct messages** on, a message to the bot is an `explicit` request from its sender, and the Source also recovers direct chats it has seen before. Turning it off stops both; the Policy reports `direct_messages_not_allowed` for one that arrives meanwhile.
- **History.** When the Source is switched on it starts reading each listed chat (and each known direct chat) from that moment, page by page in time order, up to 50 messages per page. It also follows topics that had a message in the last two weeks, and a Thread that still has an open Ticket. A page that does not advance fails that chat's read instead of looping, a failed read keeps the chat's cursor at the previous good position and reports on `history`, and the next minute tries again. `readPageSize` changes the page size for the panel's reads.
- **Attachments.** An image message keeps its `image_key` in the text, and the assessment can read that image (PNG, JPEG, WebP or GIF) when the Source message is admitted; a file keeps its `file_key` and name as text, and the Source does not download it. Forwarded messages keep the forwarded text and any image keys in it.
- **Rate limits and failures.** Feishu's limits and permission errors come back from `lark-cli` as errors (`99991400` for a rate limit, `99991672` and `230027` for a missing scope). The Source never hides them: a history read reports the error on its `history` entry and retries on the next minute round, and the event consumer is restarted with a one-second delay after a run that stayed up a minute and with exponential backoff up to sixty seconds otherwise.

### Where the secrets live, and how to rotate them

Nothing in this guide writes a secret into the repository. A copy of the values for convenience belongs in the workspace `.env`, which is ignored by git (`git check-ignore .env` prints it); check before committing that no `.env` file is staged.

| Secret | Where it lives | How to rotate |
| --- | --- | --- |
| Agent GitHub token | The `gh-agent` CLI's own store: the OS keychain (Windows Credential Manager, macOS Keychain, Linux libsecret), or `~/.config/gh-agent/hosts.yml` when the CLI stores it as text | Create a new token on GitHub, run `gh-agent auth login --with-token` (or `gh auth refresh`) with it, verify `gh-agent api user --jq .login`, then delete the old token |
| Feishu app secret | The keychain entry `lark-cli` uses for the app id; the bot configuration directory holds the app id, brand and bot `open_id`, not the secret | In the Feishu console, reset the app secret, publish the version, rerun `lark-cli config init --app-id <cli_…> --force-init --app-secret-stdin`, restart the host, and update the `.env` copy |

Use a fine-grained token rather than a classic one. It needs access to the agent's repository only — Contents, Issues and Pull requests read and write, Metadata read — and no administration, workflow or repository-deletion permissions. A classic token with `admin:org` and `delete_repo` turns one leaked file into a whole-account loss.

A Session that runs with the worker environment applied has the agent's `gh` wrapper first on `PATH`, so a plain `gh` there acts as the agent, not as you. To act as the operator (editing a release, merging as yourself), call the real CLI with `GH_CONFIG_DIR` unset — `C:\Program Files\GitHub CLI\gh.exe` on Windows — and confirm the account with `gh auth status`; the same applies to `git push`, which the worker `insteadOf` rules otherwise rewrite to the agent's credentials.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`. If DeepSeek Harness is already installed, as with the desktop app, skip the first line and use the `dsh` it puts on `PATH`.

On Windows, run the same commands from PowerShell or `cmd`: create the profile with `dsh superagent --from-default-profile web --dump-config > $null` and install the bundle with the checkout's path, for example `dsh plugin --profile superagent add "link:C:/src/dsh-superagent"`. Only the executable names differ; the profile and patch files are the same.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

A release tarball installs without a checkout: download `dsh-superagent-<version>.tgz` from the project's GitHub releases, then install it by file path instead of `link:`:

```sh
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "file:$HOME/Downloads/dsh-superagent-0.2.0.tgz"
```

On Windows use the downloaded path in the same form, for example `dsh plugin --profile superagent add "file:C:/Users/me/Downloads/dsh-superagent-0.2.0.tgz"`. `link:` follows your checkout while you develop; a tarball stays at the version it was packed from, which is what a machine that only runs the agent should use. The tarball contains the built `lib`, the prompts, the skills and the locale files, so no build step is needed after installing it.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

### Install into an existing profile

The desktop application keeps its plugins in its own profile (`desktop`), so this bundle can be installed there instead of in a separate `superagent` profile. The orchestrator then runs inside the application and its panel appears in that UI:

```sh
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh plugin --profile desktop add "link:$PWD"
```

Add the machine configuration to that profile's own `cordis.patch.yml` instead of copying the template: an entry `- id: dsh-superagent` with `stateDir`, and `- id: dsh-superagent-feishu` with `disabled: false` when Feishu is used. The application picks the change up on restart, and `dsh --profile desktop --dump-config` does not work because the application manages that profile exclusively.

A profile has one host at a time. Point the application and `scripts/dsh-superagent` at the same `stateDir` only if you run exactly one of them; two hosts would poll the same Sources and act on the same Tickets twice.

Switching hosts means quitting the current one, not only unloading the plugin: DeepSeek Harness keeps the orchestrator Session's write handle until the host process exits. Quit the application (or run `scripts/dsh-superagent stop`) and then start the other host. The host that is refused names the state directory the other one holds, the orchestrator Session, and both commands that stop it.

The orchestrator applies the worker environment to its whole host process: `PATH` gains `worker-bin`, so `gh` and `lark-cli` resolve to the worker's shims, and `GIT_CONFIG_GLOBAL` points at the agent's git configuration. Installing into a profile you also work in therefore applies those settings to your own Sessions in that application, and the commands you run there act as the agent's accounts. When that separation matters, install into a separate `superagent` profile, as this guide's default does, and restart the application after switching hosts.

### A pinned DSH installation

The desktop application updates itself, and an upgrade can change the Harness API the bundle builds against. A service can keep its own Harness launcher instead of the application's:

```sh
npm install -g --prefix "$HOME/.dsh-superagent/dsh" "@deepseek-ai/dsh@0.2.2-rc.1" \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
export DSH_SUPERAGENT_DSH="$HOME/.dsh-superagent/dsh/dsh"    # dsh.cmd on Windows
scripts/dsh-superagent start
scripts/verify-install --dsh "$DSH_SUPERAGENT_DSH"
```

The build scripts are not optional: without them `node-pty` and `koffi` keep no binaries, and the host starts a web server but never loads its plugins (the panel answers 401 and `/orchestrator/api/state` answers 404, with an empty service log). With the launcher pinned the service keeps running the tested version while the application updates, and `verify-install --dsh <path>` reports the version it finds. Profiles and the state database stay shared, so the one-host rule, the schema check and the rollback steps still apply; update the pinned launcher deliberately, together with the bundle, when it expects a newer Harness.

Verified on 2026-11-07: a `@deepseek-ai/dsh@0.2.2-rc.1` prefix booted a profile on port 3088, served the panel and answered `GET /orchestrator/api/state`, and `verify-install --dsh <pinned>/dsh.cmd` reported that version.

### Verify an installation

`scripts/verify-install` reads one installation and reports what it found, without changing anything. It has no dependency beyond Node's standard library, and needs no token on a loopback host:

```sh
scripts/verify-install --profile superagent
scripts/verify-install --profile desktop --url http://127.0.0.1:52471   # hosted by the desktop application
```

It checks the DSH version the launcher reports, the profile's `package.json` dependency and `dsh.profile.bundles` entry, the profile's `cordis.patch.yml` `stateDir`, the management API (health, setup, paused), the state directory lock and service PID file, and the panel URL. On Windows run `scripts\verify-install.cmd` with the same arguments; `--json` prints the results as JSON, and `--token <token>` prints the panel URL.

Exit codes: `0` every check passed, `1` at least one check failed, `2` the API answered but the installation waits for setup, which a person must finish before the panel can act.

## Platform and release checks

Part of these checks run in CI; the visible part and the real accounts cannot, so a release does them by hand.

### macOS checklist

CI runs the whole suite on macOS. `.github/workflows/smoke.yml` also starts a real host on macOS on every push to `main`: it creates a profile, adds the bundle with `link:`, starts the service (expects exit 3, waiting for setup), signs into the panel with its token, checks that the orchestrator API answers, runs `verify-install` (expects exit 2 before setup) and stops the service — the same steps as 1–5 below, minus the visible rendering. What remains for a person, once per release, is the visible part and the real accounts:

1. `git pull && pnpm install --frozen-lockfile && pnpm build` and `pnpm check`; both exit 0.
2. Create a profile, install the bundle with `link:` and set a `webserver` port and a `stateDir` as the [Install](#install) section shows.
3. `scripts/dsh-superagent start` exits 3 with "The GitHub Source names no repository", then `status` exits 3; `scripts/dsh-superagent stop` exits 0 and `status` then exits 1.
4. `scripts/verify-install --profile <name>` exits 2 before setup and 0 after the GitHub Source is saved; `--json` prints the schema line.
5. The panel opens at the printed URL, and the Superagent sidebar entry renders — compare it with the committed screenshots in [005](005-panel.md).
6. A direct message on Feishu and a comment that mentions the agent both reach the Source, and one of them ends as a merged pull request.
7. `scripts/dsh-superagent logs` are the same shape as on Windows and Linux, and `stop` leaves no process behind (`pgrep -f dsh-superagent` is empty).

Record the result in the release notes, with the macOS version and the DSH version.

### Release check

Before tagging:

1. `pnpm check` green on all three platforms through CI (`.github/workflows/check.yml`), and the [macOS checklist](#macos-checklist) run once for this release.
2. The panel renders in a desktop browser for the current build: the sidebar entry, the overview with its Source health and reply queue, one Ticket row, and one settings page. Save a screenshot next to the release notes; a screenshot is evidence for the whole panel, which CI cannot render. Capture them from a real host when the release changes the client, and note the DSH version the host ran; never commit a screenshot of a real workspace, because the sidebar and the account label show the operator's private project names. Where the system browser cannot start headless (Chrome 156 on the Windows machine of 2026-11-07 exits before writing DevToolsActivePort), Playwright's own Chromium renders the panel: open the panel URL with its token, dismiss the preview notice, click **Superagent** in the sidebar, screenshot the Overview and Source tabs.
3. `pnpm pack --pack-destination dist` produces a tarball, `dsh plugin --profile <name> add "file:<tarball>"` installs it into a fresh profile, and `--dump-config` composes it. Then tag `v<version>`, and the release workflow packs again, attaches the tarball and creates the release.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

On Windows the same commands are `scripts\dsh-superagent.cmd start` and `scripts\dsh-superagent.cmd status`; the wrapper takes the same arguments and returns the same exit codes.

`start` launches `dsh --profile superagent --no-open` in the background, with its output in the log file named below, and returns when the runtime is ready or reports a setup requirement. No terminal or `tmux` session stays attached, and the process survives closing the terminal. It waits up to one minute, prints the missing setup information on a first run, and refuses duplicate instances, including ones started outside this script.

`stop` and `restart` ask the running instance to stop over the management API (`POST /orchestrator/api/shutdown` with the panel's `x-orchestrator-request: 1` header) and wait up to five minutes for Executor Sessions. When that route is missing, as with an older build, `stop` falls back to `SIGINT` on macOS and Linux and to ending the process tree with `taskkill` on Windows. They never touch other DeepSeek Harness profiles. Because `start` detaches the service, closing the terminal does not stop it; a service that dies unexpectedly is recovered by the hourly check below or by `start`.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### One project per profile

One profile serves one project: one state directory, one set of Sources and one panel port. Running two projects from one profile is not supported, because Sources, Tickets, the allowed lists and the state database are per host.

Give each project its own profile, named after the project:

```sh
dsh plugin --profile project-a add "link:$PWD"
```

Then set a `webserver` port and a `stateDir` in `~/.dsh/profiles/project-a/cordis.patch.yml` (the same entries the [Install](https://github.com/louifinn/dsh-superagent-further/blob/main/docs/006-deployment.md#install) section shows), and start it with `scripts/dsh-superagent start --profile project-a --url http://127.0.0.1:3083`.

Only one of those projects runs as the service at a time. `node scripts/switch-project <profile>` stops the service-hosted projects that are running, starts the one you name, and prints its panel URL with the token. On Windows use `node scripts\switch-project <profile>`. It reads each profile's panel port from the `webserver` entry of its `cordis.patch.yml`, and refuses with an explanation instead of stopping something whose port it cannot know:

```sh
node scripts/switch-project project-a
# Stopped project-b.
# Started project-a at http://127.0.0.1:3083 (waiting for setup).
# Panel: http://127.0.0.1:3083/?token=…
```

The application host is one profile too, so switching between service-hosted projects does not touch a project the application hosts; quit the application (or unload the plugin) before starting that project's service, as [Install into an existing profile](#install-into-an-existing-profile) describes.


### Finished worktrees and disk hygiene

A worker's report binds its PR either by the `pr_number` field or by linking the pull request in its summary; once bound, the Ticket waits for that merge and then ends `merged`. A Ticket whose project is registered runs its executor as a subagent of that project's Lead Session (`docs/010-project-orchestrator.md`); a request no registered project can own is refused at acceptance with a pointer to **Execution → Projects**, and onboarding requires at least one project (`SetupError('projectUnset')`), so every Ticket runs under its project Lead. A Lead-hosted executor's inputs and status requests reach it through its Lead, reports settle back through it, and a report that names an already-merged pull request ends the Ticket `merged` at once. Every Ticket gets its own checkout, so a long-lived deployment grows unless old ones go away. **Concurrent Tickets** (`maxWorkers`) caps the whole host, while **Concurrent Tickets per project** (`projectWorkers`, default 2) caps one project so a large project cannot starve the others; a person's follow-up may take one slot beyond as before. The **Execution** settings page has **Keep finished Tickets' worktrees** (`worktreeKeepDays`, default 7): a worktree and its `agent/` branch are removed once the Ticket has been ended at least that many days. Set `0` to keep them.

The host reclaims them itself: once at start, after each Ticket ends, and every six hours while it runs. It never touches a directory outside `<stateDir>/work`, and never one still used by an open Ticket. The removal is logged as `removed the worktree of Ticket … at …`. The database keeps the Ticket, so the panel still shows what the work did; only the checkout and the local branch go.

To see what a stopped host would remove, or to clean a machine by hand, use the script (it checks the database to skip open Tickets, and only previews until `--apply`):

```sh
node scripts/clean-worktrees --profile superagent --older-than 7
# would remove C:\Users\…\.dsh\state\superagent\work\add-login-abc123 (agent/add-login-abc123)
node scripts/clean-worktrees --profile superagent --older-than 7 --apply
```

The `--state-dir` option names the directory directly, `--json` prints a machine-readable summary, and on Windows use `node scripts\clean-worktrees.cmd …` or `node scripts\clean-worktrees …`.

The checkout keeps no runtime data: the state directory, the database, the worker environment and the worktrees live under `stateDir`, and the analysis of a real run (logs, reports) belongs in `.artifacts/`, which is ignored. The service keeps the newest twenty `.artifacts/dsh-superagent-<profile>-*.log` files when it starts; other files there are yours to keep or delete, so `.artifacts/tmp/` is a scratch area, not a backup.

### Memory

The main Session and each project Lead can remember facts that outlive a Session: a decision, a preference, a lesson or a fact worth not rediscovering. `memory_write` stores short text with a `kind` (`fact`, `decision`, `preference` or `lesson`), optional `tags`, an optional `project` or `ticket` scope, `pinned`, and `expires_in_days`; the same content in the same scope is stored once. `memory_search` finds memories by keyword in their text or tags, optionally within one project or ticket, pinned first; `memory_forget` removes one by id. A project Lead's tools are scoped to its project: it writes only to that project, cannot file a memory against another project's ticket, searches only that project (the installation-wide memories belong to the Orchestrator), and forgets only its project's entries.

Memories travel in the runtime-context snapshot rather than the system prompt: DSH appends a small changed snapshot as a user message after the cached history when memories change, so a write does not rewrite the system prompt (a system-prompt change would append or replace the whole prompt and cost far more). The snapshot carries the pinned memories and the most recent others, rebuilt for every model request within a 1,200-character budget, so a memory stored during a Session is visible to its next turn. The main Session's snapshot carries the whole installation's memories; a project Lead's carries only its own project's.

A Ticket and a Request are also remembered deterministically when they end, with no model call: the Ticket's title, project, outcome and time, and the Request's title, Ticket count and outcome. The Request's memory is installation-wide, so it belongs to the Orchestrator: a project Lead sees only its own project's Ticket memories, never the Request summary or another project's facts. That division is deliberate (decided 2026-11-08): the Orchestrator is the only role that sees across projects, and one summary avoids duplicating it into every project. A later Session can recall what happened without replaying the conversation; the same facts remain readable through `orchestrator_read tickets` and `orchestrator_read decisions`.

The **Memory** tab controls all of this. **Memory enabled** is the master switch: off silences the snapshot, makes `memory_write` and `memory_search` refuse, and stops the automatic recording of finished work, while keeping the stored rows. **Inject memory** controls only the snapshot, so a model can still ask with `memory_search` when it is off. **Remember finished work** controls the automatic deterministic writes. The switches save as soon as they are clicked; the limits (pinned and recent counts, the snapshot's character budget, and how many days an automatic record is kept) save with **Save**. Every change is read on the next model request, so it takes effect without restarting the host or reloading the plugin, and each save appears in the tab's history.

Below the behavior controls the page lists the stored memories as expandable cards: a collapsed card shows a one-line preview with its kind, scope, project and time, and expanding it shows the whole text, its tags, source, expiry and id. The keyword box searches the text and the tags, a combo box filters by project (every project, one registered project, or the rows that belong to none), and another combo box picks the order: newest, oldest, kind or project. Pinned memories always lead whichever order is chosen. The list is paged twenty rows at a time with the visible range and page count under it. Each card can be pinned or unpinned and forgotten, and those actions apply immediately, like the switches.

Retention ages out only the automatic records of finished work after **Retention (days)** (default 30); a memory a person or agent wrote on purpose stays until it expires, is forgotten, or is unpinned and removed by hand. Pinned memories are never aged out.

Memories live in the same `orchestrator.sqlite` (`memory` table, schema 16; the behavior lives in the `memory` settings block).

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out. On Windows, use `scripts\dsh-superagent.cmd` in the same prompt.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent` on macOS and Linux, or `C:\Users\me\.local\bin\gh-agent.cmd` on Windows. That repository is the host's own; the Source also polls every repository a registered project names, so one installation watches all its projects. The Source card lists every watched repository — the deployment repository and each project's — and updates it when a project is added or removed. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. An Issue or PR of another project's repository gets a Thread id qualified with `owner/name#<number>`, so equal numbers in two repositories cannot collide. A project repository the agent account cannot read is reported in the Source's health (for example `project repositories unreadable: owner/name`) instead of failing the poll round, so one repository without a grant does not stop the others. A read position stays ten minutes behind the newest item it read, so an item GitHub indexes a moment after the listing that should have contained it is listed again next round; the deterministic Trigger id drops the overlap, and a slow round over several repositories cannot step past an event. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The projects this installation works on, then the directory root and a prepare command. **Projects** pairs each local workspace with its remote repository: an identifier (lowercase letters, digits and hyphens), a name, the absolute path of the local clone, `owner/name` of the remote repository, and an optional base branch (empty uses the repository's default). The list is part of the Execution settings block, so only the management panel or the API can change it. The overview can filter the waiting Tickets by project, shows a **Project Leads** section (one row per registered project: its Lead Session's state, running executors and undelivered messages; a row with a Session opens that Session in the main panel), and the Triggers list filters its Threads by the project each one's repository names, showing that project on the row. The Executor gives each Ticket of a project its own checkout automatically: a new branch `agent/<ticket name>` in `stateDir/work/<project>/<ticket name>`, created with `git worktree add` from the project's local clone at the project's base branch as that clone has it. The clone is not fetched for you, so fetch it yourself (or fetch in a prepare command) when the base branch has to be current. The worker environment names the project and its clone (`DSH_SUPERAGENT_PROJECT`, `DSH_SUPERAGENT_PROJECT_WORKSPACE`), and `DSH_SUPERAGENT_GITHUB_REPOSITORY` is that project's repository. A request from Feishu names no repository: the main Session sees the registered projects on the candidate card and may accept the work for one (the message may name a project id itself); the Executor refuses an unknown project, and for an accepted single delivery a project that differs from a GitHub Trigger's own repository is refused, so a GitHub request stays in its repository's project. A request spanning several deliveries accepts with `deliverables`: one Request is created with one Ticket per delivery unit, each unit in its own registered project (which may differ from the Trigger's repository), and `after` indexes order the units that must wait. The Request sends the acknowledgement once, and when all of its Tickets end it sends one result notice per IM Channel listing every Ticket and its pull request; GitHub timelines already show each pull request. A request no registered project owns is refused with a pointer to **Execution → Projects**. A PR the worker reports is read from the Ticket's project repository, so a Ticket in a project waits for that merge and ends `merged` like one in the deployment's own repository. A prepare command below replaces the automatic checkout; use it when the Ticket's work has to start from something other than the base branch, such as a pull request's head:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   On Windows the prepare command runs in PowerShell, so write it that way; this is one line because the command is passed as `-Command`:

   ```powershell
   git -C C:\src\widgets fetch --no-tags "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "$($env:DSH_SUPERAGENT_GITHUB_PR_HEAD ?? 'HEAD'):refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"; git -C C:\src\widgets worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST shutdown` | Stops the runtime and ends the host process, after answering `stopping: true`. The service script uses it for a graceful stop, because Windows cannot deliver a signal to a detached process |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

The panel shows the reply queue while messages wait: how many, how many failed at least once, the oldest wait and the
next attempt. A polling Source shows its next check beside its last message, so a quiet Source and a stuck one look
different; a Source driven by a live stream has no next check to show. The service script keeps the twenty newest log
files, and the application host keeps its own log.

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history`, `digest` | Source polling, events, history recovery and the daily digest |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, `otherChats` as `"none"` or `"mentions"`, and `digestChat` (empty for no digest) with `digestHour` (local hour, default 9).
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `projectWorkers`, `directory`, `prepare`, `blockedCommands`, `projects` and `worktreeKeepDays`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

An upgrade keeps the state directory, and the host opens an older database by migrating it on start; only a database
written by a newer build has to be restored from its backup. Wait for a quiet moment: a restart ends a running Assignment
and starts a replacement with a recovery note.

1. Wait until no Executor is in the middle of a turn (`status` shows no running Assignment).
2. Copy `<stateDir>/orchestrator.sqlite` (with its `-wal` and `-shm` files if present) somewhere you can restore it from.
3. Run `git pull && pnpm install --frozen-lockfile && pnpm build`.
4. Run `scripts/dsh-superagent restart` (`scripts\dsh-superagent.cmd restart` on Windows); an in-application host restarts the application instead.
5. Run `scripts/verify-install --profile <name>` and require exit 0. Its `schema` line says `schema 16 (current)`, or
   `schema 10 migrates to 16 on start` when the next start is the one that upgrades the database.

Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked
**Default updated** after upgrading.

### Rolling back

1. Stop the host (`scripts/dsh-superagent stop`, or quit the DeepSeek Harness application).
2. Restore the backed-up database over `<stateDir>/orchestrator.sqlite`, and remove that directory's `-wal` and `-shm` files.
3. Check out the earlier commit, then `pnpm install --frozen-lockfile && pnpm build`.
4. Start the host and run `scripts/verify-install` again; the `schema` line must report the version that checkout expects.

A database migrated by a newer version cannot be opened by an older one, so the backup is the rollback path, not a reverse
migration. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |

