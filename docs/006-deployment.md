# 006 Deployment

Use this guide to install, configure and operate dsh-superagent-further. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: the Orchestrator workspace, Sources for the agent accounts, Policy for allowed lists, and Execution for the projects, worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-further-worker` for Executors and `dsh-superagent-further-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent-further. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent-further restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

On Windows, POSIX file modes restrict nothing, so the state directory and the database are given an ACL that removes inherited permissions and gives the operator's account full control (`icacls`), the Windows equivalent of the `0700` directory and `0600` file used elsewhere. Explicit entries the path already carries, such as `SYSTEM`'s, stay. If Windows refuses the change, the log says so and the files keep the permissions they inherit.

The first start after installing or upgrading does not begin polling: the main Session needs an Orchestrator workspace that the operator selects. Open the panel, and the setup wizard's first step asks for an absolute path to an empty directory (or one this tool already marked with `.dsh-superagent-workspace`). The host registers that directory as the DeepSeek Harness workspace `dsh-superagent-further · <directory name>` and creates the master Session there. The state directory, the DSH home and profile, a source checkout or a project workspace cannot be selected, and no default path exists. Until a workspace is saved the runtime stays `paused`/`setupPending`: no Source polls, no Executor starts, no DSH workspace is registered and no master Session is created. An upgrade from a build without workspace identity keeps the old master Session as archived, readable history and starts a new one in the selected workspace; a Session's cwd cannot be changed, so the main conversation does not continue. A workspace selected again after switching away is unarchived and resumed under its own workspace-derived master id instead of being recreated.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm and git 2.32+. macOS, Linux and Windows 10/11 are supported: the service script is plain Node, so Python and tmux are no longer needed. On Windows run it as `scripts\dsh-superagent-further.cmd` (the `.cmd` wrapper runs the same script)
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A user-owned directory for the Orchestrator workspace: absolute, empty (or already marked by this tool), outside the state directory, the DSH home and profile, and the source checkout. Worker checkouts and logs stay under the state directory; the workspace is the project the main Session works in.
- A model provider configured for DeepSeek Harness. dsh-superagent-further uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the primary repository and every other repository its projects name. A GitHub App cannot be the agent, because dsh-superagent-further reads the account's notifications.
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

   Sign in as the agent account; the last command prints its login. dsh-superagent-further reads the login the same way.

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

   The GitHub card saves the agent CLI; setup probes it, and verifies the agent's push access to the primary repository, before the change is stored. The primary repository is the first project under **Execution → Projects** — the card lists every watched repository. Saving the Source with no CLI is the exception, so you can unbind an installation: the service then waits for setup again, as on its first run.

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

#### Independent DSH Sessions

The `session` Source is always registered and needs no account or CLI. It lets a root DeepSeek Harness Session that dsh-superagent-further does not manage ask for work with the global `superagent_submit` tool (`{title, instruction, project?, session_id?}`). Each call becomes one Trigger under the `workspace` admission row, so the Policy decides whether it is ignored, inferred or explicit; every outcome is delivered back to the calling Session as a message, and an accepted Request reports its result there. The tool refuses subagents, the Orchestrator's own, Lead and Executor Sessions, an unknown project and a disabled Source. Switch the Source off in **Sources** to stop submissions.

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
git clone <this repository> dsh-superagent-further && cd dsh-superagent-further
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`. If DeepSeek Harness is already installed, as with the desktop app, skip the first line and use the `dsh` it puts on `PATH`.

On Windows, run the same commands from PowerShell or `cmd`: create the profile with `dsh superagent --from-default-profile web --dump-config > $null` and install the bundle with the checkout's path, for example `dsh plugin --profile superagent add "link:C:/src/dsh-superagent-further"`. Only the executable names differ; the profile and patch files are the same.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

A release tarball installs without a checkout: download `dsh-superagent-further-<version>.tgz` from the project's GitHub releases, then install it by file path instead of `link:`:

```sh
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "file:$HOME/Downloads/dsh-superagent-further-0.4.0.tgz"
```

On Windows use the downloaded path in the same form, for example `dsh plugin --profile superagent add "file:C:/Users/me/Downloads/dsh-superagent-further-0.4.0.tgz"`. `link:` follows your checkout while you develop; a tarball stays at the version it was packed from, which is what a machine that only runs the agent should use. The tarball contains the built `lib`, the prompts, the skills and the locale files, so no build step is needed after installing it.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

### Install into an existing profile

The desktop application keeps its plugins in its own profile (`desktop`), so this bundle can be installed there instead of in a separate `superagent` profile. The orchestrator then runs inside the application and its panel appears in that UI:

```sh
git clone <this repository> dsh-superagent-further && cd dsh-superagent-further
pnpm install && pnpm build
dsh plugin --profile desktop add "link:$PWD"
```

Add the machine configuration to that profile's own `cordis.patch.yml` instead of copying the template: an entry `- id: dsh-superagent-further` with `stateDir`, and `- id: dsh-superagent-further-feishu` with `disabled: false` when Feishu is used. The application picks the change up on restart, and `dsh --profile desktop --dump-config` does not work because the application manages that profile exclusively.

A profile has one host at a time. Point the application and `scripts/dsh-superagent-further` at the same `stateDir` only if you run exactly one of them; two hosts would poll the same Sources and act on the same Tickets twice.

Switching hosts means quitting the current one, not only unloading the plugin: DeepSeek Harness keeps the orchestrator Session's write handle until the host process exits. Quit the application (or run `scripts/dsh-superagent-further stop`) and then start the other host. The host that is refused names the state directory the other one holds, the orchestrator Session, and both commands that stop it.

The orchestrator applies the worker environment to its whole host process: `PATH` gains `worker-bin`, so `gh` and `lark-cli` resolve to the worker's shims, and `GIT_CONFIG_GLOBAL` points at the agent's git configuration. Installing into a profile you also work in therefore applies those settings to your own Sessions in that application, and the commands you run there act as the agent's accounts. When that separation matters, install into a separate `superagent` profile, as this guide's default does, and restart the application after switching hosts.

### A pinned DSH installation

The desktop application updates itself, and an upgrade can change the Harness API the bundle builds against. A service can keep its own Harness launcher instead of the application's:

```sh
npm install -g --prefix "$HOME/.dsh-superagent/dsh" "@deepseek-ai/dsh@0.2.2-rc.1" \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
export DSH_SUPERAGENT_DSH="$HOME/.dsh-superagent/dsh/dsh"    # dsh.cmd on Windows
scripts/dsh-superagent-further start
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

Part of these checks run in CI; the visible part and the real accounts cannot, so a release does them by hand. Coverage is reported but not gated: `pnpm test:coverage` writes a text and JSON summary under `.artifacts/coverage`, and the CI check runs it with `continue-on-error` so a drop is visible in the job log without failing a release. The operator-facing checks and recovery steps are in 013 Operations runbook.

### macOS checklist

CI runs the whole suite on macOS. `.github/workflows/smoke.yml` also starts a real host on macOS on every push to `main`: it creates a profile, adds the bundle with `link:`, starts the service (expects exit 3, waiting for setup), signs into the panel with its token, checks that the orchestrator API answers, runs `verify-install` (expects exit 2 before setup) and stops the service — the same steps as 1–5 below, minus the visible rendering. What remains for a person, once per release, is the visible part and the real accounts:

1. `git pull && pnpm install --frozen-lockfile && pnpm build` and `pnpm check`; both exit 0.
2. Create a profile, install the bundle with `link:` and set a `webserver` port and a `stateDir` as the [Install](#install) section shows.
3. `scripts/dsh-superagent-further start` exits 3 with "No Execution project is registered.", then `status` exits 3; `scripts/dsh-superagent-further stop` exits 0 and `status` then exits 1.
4. `scripts/verify-install --profile <name>` exits 2 before setup and 0 after the agent CLI and a project are saved; `--json` prints the schema line.
5. The panel opens at the printed URL, and the Superagent sidebar entry renders — compare it with the committed screenshots in [005](005-panel.md).
6. A direct message on Feishu and a comment that mentions the agent both reach the Source, and one of them ends as a merged pull request.
7. `scripts/dsh-superagent-further logs` are the same shape as on Windows and Linux, and `stop` leaves no process behind (`pgrep -f dsh-superagent-further` is empty).

Record the result in the release notes, with the macOS version and the DSH version.

### Release check

Before tagging:

1. `pnpm check` green on all three platforms through CI (`.github/workflows/check.yml`), and the [macOS checklist](#macos-checklist) run once for this release. `pnpm check` also runs `architecture:check` (the import-direction rules), `pack:check` (the packed tarball's file list against `scripts/pack-manifest.json`) and `docs:check` (the generated tool and settings references under `docs/reference`), so a release cannot ship a stale manifest or reference page; after an intentional packaging or schema change run `pnpm pack:check --update` and `pnpm docs:generate` before the final check.
2. The panel renders in a desktop browser for the current build: the sidebar entry, the overview with its Source health and reply queue, one Ticket row, and one settings page. Save a screenshot next to the release notes; a screenshot is evidence for the whole panel, which CI cannot render. Capture them from a real host when the release changes the client, and note the DSH version the host ran; never commit a screenshot of a real workspace, because the sidebar and the account label show the operator's private project names. Where the system browser cannot start headless (Chrome 156 on the Windows machine of 2026-11-07 exits before writing DevToolsActivePort), Playwright's own Chromium renders the panel: open the panel URL with its token, dismiss the preview notice, click **Superagent** in the sidebar, screenshot the Overview and Source tabs.
3. `pnpm pack --pack-destination dist` produces a tarball, `dsh plugin --profile <name> add "file:<tarball>"` installs it into a fresh profile, and `--dump-config` composes it. Then tag `v<version>`, and the release workflow packs again, attaches the tarball and creates the release.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-further-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database `orchestrator.sqlite`, the lock, the command shims in `worker-bin`, the agent's git configuration, the operational log files in `logs`, and, by default, the Ticket directories in `work`. It is system-owned and is never the main Session's workspace. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent-further start
scripts/dsh-superagent-further status
```

On Windows the same commands are `scripts\dsh-superagent-further.cmd start` and `scripts\dsh-superagent-further.cmd status`; the wrapper takes the same arguments and returns the same exit codes.

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

Each profile started through these control scripts stores logs and control files under `.artifacts/`: a desktop Host starts without them and writes its operational log to the Logs tab and `<stateDir>/logs` instead.

- Startup logs: `dsh-superagent-further-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Several projects in one profile

One profile serves a team, not a repository: register every project under **Execution → Projects**, and the single GitHub Source polls all their repositories while each Ticket runs in its own project's worktree under that project's Lead. Sources, Tickets, the allowed lists and the state database stay per host, so the rule is one host per state directory; it is not one project per profile.

A separate profile is still useful when projects need different accounts, panel ports or a different host. Give it its own profile, install the bundle there, set a `webserver` port and a `stateDir` in its `cordis.patch.yml` (the same entries the [Install](#install) section shows), and start it with `scripts/dsh-superagent-further start --profile project-a --url http://127.0.0.1:3083`.

Only one service-hosted profile runs at a time. `node scripts/switch-project <profile>` stops the service-hosted profiles that are running, starts the one you name, and prints its panel URL with the token. On Windows use `node scripts\switch-project <profile>`. It reads each profile's panel port from the `webserver` entry of its `cordis.patch.yml`, and refuses with an explanation instead of stopping something whose port it cannot know:

```sh
node scripts/switch-project project-a
# Stopped project-b.
# Started project-a at http://127.0.0.1:3083 (waiting for setup).
# Panel: http://127.0.0.1:3083/?token=…
```

The application host is one profile too, so switching between service-hosted projects does not touch a project the application hosts; quit the application (or unload the plugin) before starting that project's service, as [Install into an existing profile](#install-into-an-existing-profile) describes.


### Finished worktrees and disk hygiene

A worker's report binds its PR either by the `pr_number` field or by linking the pull request in its summary; once bound, the Ticket waits for that merge and then ends `merged`. A Ticket whose project is registered runs its executor as a subagent of that project's Lead Session (`docs/010-project-orchestrator.md`); a request no registered project can own is refused at acceptance with a pointer to **Execution → Projects**, and onboarding requires at least one project (`SetupError('projectUnset')`), so every Ticket runs under its project Lead. A Lead-hosted executor's inputs and status requests reach it through its Lead. Its worker activation starts with DeepSeek Harness delivery `caller`, so DSH injects no settlement message into the Lead; the application's own durable Lead messages are the single notification authority. A reviewer activation starts with delivery `parent` instead, because it has no application tool of its own: DSH's settlement notice puts its closing verdict in front of the Lead, which records it with `lead_review_record`. A report that names an already-merged pull request ends the Ticket `merged` at once. Every Ticket gets its own checkout, so a long-lived deployment grows unless old ones go away. **Concurrent Tickets** (`maxWorkers`) caps the whole host, while **Concurrent Tickets per project** (`projectWorkers`, default 2) caps one project so a large project cannot starve the others; a person's follow-up may take one slot beyond as before. The **Execution** settings page has **Keep finished Tickets' worktrees** (`worktreeKeepDays`, default 7): a worktree and its `agent/` branch are removed once the Ticket has been ended at least that many days. Set `0` to keep them.

The host reclaims them itself: once at start, after each Ticket ends, and every six hours while it runs. It never touches a directory outside `<stateDir>/work`, and never one still used by an open Ticket. The removal is logged as `removed the worktree of Ticket … at …`. The database keeps the Ticket, so the panel still shows what the work did; only the checkout and the local branch go.

To see what a stopped host would remove, or to clean a machine by hand, use the script (it checks the database to skip open Tickets, and only previews until `--apply`):

```sh
node scripts/clean-worktrees --profile superagent --older-than 7
# would remove C:\Users\…\.dsh\state\superagent\work\add-login-abc123 (agent/add-login-abc123)
node scripts/clean-worktrees --profile superagent --older-than 7 --apply
```

The `--state-dir` option names the directory directly, `--json` prints a machine-readable summary, and on Windows use `node scripts\clean-worktrees.cmd …` or `node scripts\clean-worktrees …`.

The checkout keeps no runtime data: the state directory, the database, the worker environment and the worktrees live under `stateDir`, and the analysis of a real run (logs, reports) belongs in `.artifacts/`, which is ignored. The service keeps the newest twenty `.artifacts/dsh-superagent-further-<profile>-*.log` files when it starts; other files there are yours to keep or delete, so `.artifacts/tmp/` is a scratch area, not a backup.

### Memory

Memory is an **experimental** feature and is off by default: until the operator turns on **Memory enabled** on the **Memory** tab, nothing is injected, the memory tools refuse, and finished work is not recorded. Existing installations keep their saved switch values.

The main Session and each project Lead can remember facts that outlive a Session: a decision, a preference, a lesson or a fact worth not rediscovering. `memory_write` stores short text with a `kind` (`fact`, `decision`, `preference` or `lesson`), optional `tags`, an optional `project` or `ticket` scope, `pinned`, and `expires_in_days`; the same content in the same scope is stored once. `memory_search` finds memories by keyword in their text or tags, optionally within one project or ticket, pinned first; `memory_forget` removes one by id. A project Lead's tools are scoped to its project: it writes only to that project, cannot file a memory against another project's ticket, searches only that project (the installation-wide memories belong to the Orchestrator), and forgets only its project's entries.

Memories travel in the runtime-context snapshot rather than the system prompt: DSH appends a small changed snapshot as a user message after the cached history when memories change, so a write does not rewrite the system prompt (a system-prompt change would append or replace the whole prompt and cost far more). The snapshot carries the pinned memories and the most recent others, rebuilt for every model request within a 1,200-character budget, so a memory stored during a Session is visible to its next turn. The main Session's snapshot carries the whole installation's memories; a project Lead's carries only its own project's.

A Ticket and a Request are also remembered deterministically when they end, with no model call: the Ticket's title, project, outcome and time, and the Request's title, Ticket count and outcome. The Request's memory is installation-wide, so it belongs to the Orchestrator: a project Lead sees only its own project's Ticket memories, never the Request summary or another project's facts. That division is deliberate (decided 2026-11-08): the Orchestrator is the only role that sees across projects, and one summary avoids duplicating it into every project. A later Session can recall what happened without replaying the conversation; the same facts remain readable through `orchestrator_read tickets` and `orchestrator_read decisions`.

The **Memory** tab controls all of this and carries the experimental label. **Memory enabled** is the master switch and is off by default: off silences the snapshot, makes `memory_write` and `memory_search` refuse, and stops the automatic recording of finished work, while keeping the stored rows. **Inject memory** controls only the snapshot and is also off by default; turn it on to carry pinned and recent memories with each request. The model can always ask with `memory_search` instead. **Remember finished work** controls the automatic deterministic writes. The switches save as soon as they are clicked; the limits (pinned and recent counts, the snapshot's character budget, and how many days an automatic record is kept) save with **Save**. Every change is read on the next model request, so it takes effect without restarting the host or reloading the plugin, and each save appears in the tab's history.

Below the behavior controls the page lists the stored memories as expandable cards: a collapsed card shows a one-line preview with its kind, scope, project and time, and expanding it shows the whole text, its tags, source, expiry and id. The keyword box searches the text and the tags, a combo box filters by project (every project, one registered project, or the rows that belong to none), and another combo box picks the order: newest, oldest, kind or project. Pinned memories always lead whichever order is chosen. The list is paged twenty rows at a time with the visible range and page count under it. Each card can be pinned or unpinned and forgotten, and those actions apply immediately, like the switches.

Retention ages out only the automatic records of finished work after **Retention (days)** (default 30); a memory a person or agent wrote on purpose stays until it expires, is forgotten, or is unpinned and removed by hand. Pinned memories are never aged out.

Memories live in the same `orchestrator.sqlite` (`memory` table, added by schema 16; the behavior lives in the `memory` settings block).

### Automations

When the DeepSeek Harness profile mounts its `schedule` service, the management API and the main Session gain automation tasks: `GET`/`POST/PUT` `automations`, `POST automations/:id/run` and `DELETE automations/:id` for the panel, and six tools for the main Session, `automation_create`, `automation_list`, `automation_view`, `automation_edit`, `automation_run` and `automation_delete`. They exist only when the service is installed; a profile without it loads dsh-superagent-further normally and simply has no automation tools. The Automations page then says that the Host schedule service is not installed, and the management routes answer 503 instead of failing. A person creates, changes, runs or deletes a task by asking the main Session explicitly, or through the Automations page. Neither a Ticket, a message, a file nor another automation can grant that request.

A task is either **installation** scope, targeting the main Session, or **project** scope, targeting the Lead Session of a registered project as `lead-<projectId>`. Creating a project task first validates that the project is registered under Settings → Execution → Projects and ensures its Lead Session from the project workspace (titled `Lead · <name>`), so the Host receives a real target id; an unknown project is refused before the Host is called. Installation tasks may act with the Session's authority. **Project tasks are report-only for the repository:** the Host prompt begins `[AUTOMATION auto-… · project <projectId>]` and prefixes the instruction with an explicit rule telling the Lead to inspect and report, and, when the inspection finds work, to raise and decide a project request (`lead_request_create` / `lead_request_decide`) recording the automation id; it may not modify the repository, Settings, Sources, Tickets or Policy directly. Report-only is implied by project scope; there is no second toggle.

The limits apply to both scopes: 20 records in total, a title of at most 120 characters and an instruction of at most 4,000 characters. The rule is a single `DTSTART` line plus a single `RRULE` line with its time zone inside, for example:

```text
DTSTART:20261110T090000Z
RRULE:FREQ=DAILY
```

`automation_run` and `POST automations/:id/run` ask the Host to deliver one run now, without consuming or moving the scheduled occurrence: the Host owns the delivery, refuses while the same task is already queued or running (409 in the API), and the record learns about the admitted delivery on the next refresh. `automation_delete` and `DELETE automations/:id` remove the Host task, the record and its whole delivery history on an explicit human request; a Host task that is already gone is fine, and a Host refusal to delete keeps the record and reports the error. `automation_edit` and `PUT automations/:id` change the title, instruction, rule or enabled state and can pause a task; recovery stays edit-or-recreate. They cannot re-target an existing task's scope or project; disable the old task and create a new one instead. `automation_list` shows the stored tasks together with any installation task the Host has but this plugin has no record of. `automation_view` adds the Host's current status and next occurrence when it can be read.

The Automations page lists every task with its scope (installation, or project and project name), title, human-readable schedule, enabled switch, created and last-delivery times, and an orphan or error warning with the recorded reason. When at least one task is orphaned or has a recorded delivery error, an attention section above the table repeats the count, and each task row offers an expandable delivery history, newest first, with the result and error of each recent delivery. The operator can create a task there — scope, project from the registered projects, title, instruction, rrule and enabled — or edit an existing one's title, instruction, rule and enabled state, run one now, or delete one after a confirmation dialog. The page and the management API use the same service code path and require the panel's same-origin header.

The Host owns the clock, the durable task and delivery; the plugin owns the record and its meaning. Delivery is a user-role turn in the target Session whose prompt begins with `[AUTOMATION auto-… · installation]` or `[AUTOMATION auto-… · project <projectId>]` and then carries the stored instruction (and, for a project, the report-only rule). It is not a new Trigger or Ticket, and the standing instruction must work within the Session's existing tools and authority: an installation task never changes settings, Policy or Sources, and an installation delivery's only write is the installation Request it creates with `orchestrator_request_create`; a project delivery's only write is the project request it raises and decides. The Host delivers at least once, collapses missed occurrences to the latest, and delivers only while the Host runs, so the plugin schedules nothing while DeepSeek Harness is stopped. Host schedule management is installation-wide, so a task created outside this plugin is not visible as a plugin record unless its prompt carries the marker; reconciliation reports such Host tasks instead of adopting or recreating them.

Records live in the same `orchestrator.sqlite` (`automation` table, schema 19, and the `automation_delivery` table, schema 20). On startup the plugin compares its records with the Host tasks: a missing or ended task marks the record orphaned, a Host `updatedAt` the plugin did not write marks drift, a project-scope record whose recorded project id is no longer registered marks it orphaned, and a project record whose Host target is not `lead-<projectId>` marks drift. The table names the target Session, so a Lead Session archived by Host admission leaves an orphaned record that is never recreated. These conditions are recorded on the row, shown by the page and by `automation_list`/`automation_view`, and logged. Fix the record after reviewing it, or create a new task instead.

Every task keeps its newest 50 delivery rows; older ones are pruned, and the page shows the newest 10. A delivery is recorded from the Host's catalog or its `history` when the plugin observes a newer delivered time, and an `error` or `orphaned` entry is recorded when the recorded error first appears, so repeated reconciles do not duplicate entries. Refreshing the page also captures deliveries the startup pass has not seen, without bumping the record revision or writing an audit entry; the startup reconcile keeps its audit. The notices stay in the panel: no Feishu, GitHub or other IM message is sent for a delivery, failure or orphan (decision B-D5), and the page states that delivery is at-least-once and that missed occurrences collapse to the latest.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent-further: run `scripts/dsh-superagent-further --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent-further --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-further-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out. On Windows, use `scripts\dsh-superagent-further.cmd` in the same prompt.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

The operator normally saves settings in the panel or through the management API. The main Session's tools may save only tier-A fields directly, and such a save must carry the person's reason; the reason and the Session are recorded in the settings history. Every other change is refused for a tool-origin save and has to be made by the operator in the panel or through the API (see `docs/011-capabilities.md`):

| Tier | Fields | Who may save it |
| --- | --- | --- |
| A — direct | `pause`; `eval.timeoutSeconds`; `executor.worktreeKeepDays`; a Source's `pollSeconds`, `failuresBeforeError`, `observeIssues`, `observePulls`, `observeComments`, `observeCi`, `readPageSize`, `linkTimeoutMs` and `digestHour` | The panel, the API, or the main Session's tools with a reason |
| B — confirmation | `eval.mode`, `eval.model`; `executor.model`, `executor.maxWorkers`, `executor.projectWorkers`; every `policy.rules` and `policy.sources` change; every `memory.*`; `language.default`; a Source's `enabled`, `chats`, `directMessages`, `otherChats` and `digestChat` | The panel or the API; a tool save is refused with `approvalRequired`, and the tool's `orchestrator_settings_propose` records a proposal for the panel to apply |
| C — panel only | `executor.directory`, `executor.prepare`, `executor.blockedCommands`, `executor.projects`; `github.cli`, `feishu.cli`; anything that restarts the application | The panel or the API; a tool save keeps the existing `panelOnly…` refusal |

A B change is proposed, not saved, by the Agent: `orchestrator_settings_propose` validates it, records the person's reason and the block's base revision, and the panel's Settings page lists it with a per-field diff. **Apply** runs the same path as a panel save, so guards, account checks, Policy effects and restart decisions behave exactly as they do for a manual save; **Reject** closes it without writing settings. One proposal per block is pending at a time (a newer one supersedes the older), and a pending proposal expires after 7 days or when the block revision moves. Tier-A changes still apply without a restart. Pending proposals appear above the settings group they change, with the block, the requester's reason and Session, the expiry and the old → new value of each changed field; the count is the badge on Settings, and it appears on every settings group. An applied proposal's history row names the proposal, its actor and reason.

Each history row also offers **Restore** for the block it saved, after a confirmation that names the block and the revision. Restoring reads that block's value from the saved revision and saves it through the ordinary panel save path as a new revision, so guards, account checks, Policy effects and restart decisions behave exactly as they do for a manual save; a restore that changes a setup field still restarts dsh-superagent-further. The new history row records `restoredFrom`, and the settings history is the audit trail; there is no separate audit table and no Feishu or other IM message (docs/011 A-D2). Every saved settings revision is retained in the state database, so the API can restore any retained revision; the panel lists the newest 30, and only those rows offer Restore. A revision or block value that is not retained answers 404, and restoring a block that already holds the saved value answers 409 because a restore always creates a new revision.

1. **Sources.** Set the agent CLI, for example `/home/me/.local/bin/gh-agent` on macOS and Linux, or `C:\Users\me\.local\bin\gh-agent.cmd` on Windows. The Source polls every repository a registered project names, so one installation watches all its projects; the deployment's primary repository is the first project under **Execution → Projects**, and setup verifies the agent's push access to it. The Source card lists every watched repository, the primary one marked **主仓库**, and updates it when a project is added, removed or reordered. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. An Issue or PR of another project's repository gets a Thread id qualified with `owner/name#<number>`, so equal numbers in two repositories cannot collide. A project repository the agent account cannot read is reported in the Source's health (for example `project repositories unreadable: owner/name`) instead of failing the poll round, so one repository without a grant does not stop the others. A read position stays ten minutes behind the newest item it read, so an item GitHub indexes a moment after the listing that should have contained it is listed again next round; the deterministic Trigger id drops the overlap, and a slow round over several repositories cannot step past an event. A saved ETag only comes from a read that took in every listed item and is trusted for at most ten minutes: a conditional read older than that is answered in full once, and the first start after this upgrade drops the saved ETags once, so an item no earlier read took in is listed again instead of staying hidden behind the tag. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The projects this installation works on, then the directory root and a prepare command. **Projects** pairs each local workspace with its remote repository: an identifier (lowercase letters, digits and hyphens), a name, the absolute path of the local clone, `owner/name` of the remote repository, and an optional base branch (empty uses the repository's default). The first project in the list also supplies the deployment's primary repository: setup verifies the agent's push access to it, unqualified GitHub Thread ids refer to it, and the Source card marks it as the primary. Reordering the list moves the primary repository, so such a save restarts dsh-superagent-further, which verifies the new primary repository again. The list is part of the Execution settings block, so only the management panel or the API can change it. The overview can filter the waiting Tickets by project, shows a **Project Leads** section (one row per registered project: its Lead Session's state, running executors and undelivered messages; a row with a Session opens that Session in the main panel), and the Triggers list filters its Threads by the project each one's repository names, showing that project on the row. The Executor gives each Ticket of a project its own checkout automatically: a new branch `agent/<ticket name>` in `stateDir/work/<project>/<ticket name>`, created with `git worktree add` from the project's local clone at the project's base branch as that clone has it. The clone is not fetched for you, so fetch it yourself (or fetch in a prepare command) when the base branch has to be current. The worker environment names the project and its clone (`DSH_SUPERAGENT_PROJECT`, `DSH_SUPERAGENT_PROJECT_WORKSPACE`), and `DSH_SUPERAGENT_GITHUB_REPOSITORY` is that project's repository. A request from Feishu names no repository: the main Session sees the registered projects on the candidate card and may accept the work for one (the message may name a project id itself); the Executor refuses an unknown project, and for an accepted single delivery a project that differs from a GitHub Trigger's own repository is refused, so a GitHub request stays in its repository's project. A request spanning several deliveries accepts with `deliverables`: one Request is created with one Ticket per delivery unit, each unit in its own registered project (which may differ from the Trigger's repository), and `after` indexes order the units that must wait. The Request sends the acknowledgement once, and when all of its Tickets end it sends one result notice per IM Channel listing every Ticket and its pull request; GitHub timelines already show each pull request. A request no registered project owns is refused with a pointer to **Execution → Projects**. A PR the worker reports is read from the Ticket's project repository, so a Ticket in a project waits for that merge and ends `merged` like one in the deployment's own repository. A prepare command below replaces the automatic checkout; use it when the Ticket's work has to start from something other than the base branch, such as a pull request's head:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent-further/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent-further/$DSH_SUPERAGENT_TICKET"
   ```

   On Windows the prepare command runs in PowerShell, so write it that way; this is one line because the command is passed as `-Command`:

   ```powershell
   git -C C:\src\widgets fetch --no-tags "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "$($env:DSH_SUPERAGENT_GITHUB_PR_HEAD ?? 'HEAD'):refs/dsh-superagent-further/$env:DSH_SUPERAGENT_TICKET"; git -C C:\src\widgets worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" "refs/dsh-superagent-further/$env:DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Language

Settings → Language holds one free-text value, the default language for words a person reads (the `language` settings block; panel-only, revisioned, and listed in that tab's history). Any language name works — for example `简体中文`, `繁體中文`, `English` or `日本語`. Every decorated Session carries it in the runtime-context snapshot (`dsh-superagent-further-language`), so saving a new language applies to the next model request without a restart or a plugin reload.

The prompts add the boundaries around that default: the Orchestrator, a Lead and a Worker write what a person reads in this language; a Feishu or GitHub reply follows the language of the message it answers; pull request bodies, commit messages, code comments and file contents keep the repository's established language and conventions; structured fields do not change. This is a context constraint only — there is no language detection, no template layer and no post-generation check.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change every tier, including execution environment and setup account fields, unlike saves made through the main Session's tools, which are limited to tier-A fields and must give the person's reason.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, `accounts` once setup resolved them, and `workspace` (`{path, title}` when setup prepared one, otherwise `null`); `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; `proposals`, the count of pending settings proposals the Settings badge shows; and `masterId` |
| `GET settings` | `blocks`: `workspace`, `policy`, `eval`, `executor`, `memory` and `language`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST settings/<block>/restore` with `{"revision": n}` | Restores that block from saved settings revision `n` through the panel save path: the block's new `revision`, `restarting`, and `restoredFrom`, the revision it read. An optional `reason` is recorded on the new revision. A block or revision that is not retained answers 404; a restore that changes nothing answers 409 |
| `GET settings/proposals` | The pending proposals, newest first, as `{items}`: each with `id`, `block`, `value`, `diff` (`[{path, from, to}]`), `reason`, `actor`, `base_revision`, `status`, `created_at` and `expires_at` |
| `POST settings/proposals/<id>/apply` | Applies one pending proposal through the same path as a panel save: the block's new `revision`, `restarting`, and the proposal marked `applied` with `decided_by: "panel"` |
| `POST settings/proposals/<id>/reject` | Closes one pending proposal without saving settings: the proposal marked `rejected` with `decided_by: "panel"` |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent-further: `restarting: true`. Refused when setup has nothing to fix |
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
- 404: something that does not exist, including a settings proposal id and a settings revision (or that block's value in it) that is not retained.
- 409: a stale revision, a proposal that is no longer pending, a proposal whose base revision another save moved, or a restore whose value would change nothing.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the watched repositories and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, `otherChats` as `"none"` or `"mentions"`, and `digestChat` (empty for no digest) with `digestHour` (local hour, default 9). The repositories are not part of this config: the first project under Execution → Projects supplies the primary one, and the rest are derived from the projects.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `projectWorkers`, `directory`, `prepare`, `blockedCommands`, `projects` and `worktreeKeepDays`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a CLI, or the first project, runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the Orchestrator workspace first: the path must be absolute, empty or marked, writable and owner-only, and must not overlap the state directory, the DSH home and profile, the source checkout or a project workspace. A missing path is `workspaceRequired`; any other refusal is `workspaceInvalid`, `workspaceNotEmpty`, `workspaceNotWritable` or `workspaceUnsafe` and leaves the installation paused. Setup then verifies the agent's account and its push access to the primary repository (the first project's), writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent-further did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

An upgrade keeps the state directory, and the host opens an older database by migrating it on start; only a database
written by a newer build has to be restored from its backup. Wait for a quiet moment: a restart ends a running Assignment
and starts a replacement with a recovery note.

1. Wait until no Executor is in the middle of a turn (`status` shows no running Assignment).
2. Copy `<stateDir>/orchestrator.sqlite` (with its `-wal` and `-shm` files if present) somewhere you can restore it from.
3. Run `git pull && pnpm install --frozen-lockfile && pnpm build`.
4. Run `scripts/dsh-superagent-further restart` (`scripts\dsh-superagent-further.cmd restart` on Windows); an in-application host restarts the application instead.
5. If the installation predates workspace identity, it starts paused at `workspaceRequired`: open the panel and finish the workspace step of the setup wizard (or save the workspace block on **Execution → Settings**). The host registers the new DSH workspace and creates a new master Session; the old master Session is archived and readable, and the main conversation does not continue. An installation that already has a workspace skips this step. Selecting a previously used workspace later unarchives and resumes that workspace's own master Session.
6. Run `scripts/verify-install --profile <name>` and require exit 0. Its `schema` line says `schema 24 (current)`, or
   `schema 23 migrates to 24 on start` when the next start is the one that upgrades the database.

The GitHub Source no longer stores a repository: the migration removes the retired `repository` setting from the saved
settings and from their history, and setup derives the primary repository from the first project under **Execution →
Projects**. If the old deployment repository was not that project's repository, the installation now watches the first
project's repository as the primary instead; if the old repository is not one of the registered projects at all, it is
no longer watched. Register it under Execution → Projects and put it first to keep it as the primary.

Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked
**Default updated** after upgrading.

### Migrating from `dsh-superagent`

Version 0.3.0 renames the package and every registration identity: the npm package and bundle name, the bundle's
component ids (including both watch components), the agent preset ids, the two skill names and their directories, the
web client bundle id, the panel's locale namespace and the checked-in scripts. The state schema does not change, and
no stored Thread, Ticket, Request, Decision or setting is rewritten. An installation older than 0.3.0 needs these
steps once; a fresh 0.3.0 installation does not.

1. Stop the host: `scripts/dsh-superagent-further stop`, or quit the DeepSeek Harness application for an
   in-application install. No Session may hold the old preset ids while its log is rewritten.
2. Back up `<stateDir>` (at least `orchestrator.sqlite` with its `-wal` and `-shm` files) and
   `$DSH_HOME/profiles/<name>/` (`~/.dsh/profiles/<name>` by default).
3. Obtain the 0.3.0 source checkout, run `pnpm install --frozen-lockfile && pnpm build` in it, and note its absolute
   path. The migration script is not part of the built tarball, so a tarball-only installation also downloads the source
   archive for this step.
4. From that checkout run the migration script (add `--dry-run` first to see the files it would change):

   ```sh
   node scripts/migrate-rename.mjs --profile <name>
   ```

   The script makes these changes:
   - It renames the profile's `dependencies.dsh-superagent` entry and the `dsh.profile.bundles` entry to
     `dsh-superagent-further`, keeping the installed spec (`link:` path, `file:` tarball or version) unchanged.
   - It rewrites the `id:` values of the bundle's rows in the profile's `cordis.patch.yml` (`dsh-superagent`,
     `dsh-superagent-github`, `dsh-superagent-feishu`) and leaves every other entry, including `stateDir`, untouched.
   - It rewrites the `agentPreset` stored in each DSH Session log under `$DSH_HOME/sessions` from
     `dsh-superagent-worker` / `-router` / `-lead` to `dsh-superagent-further-worker` / `-router` / `-lead`, so the
     orchestrator, Lead and executor Sessions resume instead of failing with `agent-preset/not-found`. Each rewritten
     file gets a `.pre-0.3.0` copy.
   - It rewrites the same `agentPreset` in the DSH Session projection cache under
     `$DSH_HOME/storages/session_projcache/sessions`. A running host resolves a Session's preset from that cache when it
     resumes it, so an installation whose cache still names the old preset starts with
     `Unknown agent preset: dsh-superagent-router` even after the Session log was rewritten.

   Options: `--dsh-home <dir>` when the harness home is not `$DSH_HOME` or `~/.dsh`, `--sessions-dir <dir>` when the
   sessions live elsewhere (default `<dsh-home>/sessions`), and `--storages-dir <dir>` when the storage directory is
   elsewhere (default `<dsh-home>/storages`).
5. Refresh the profile's installed tree so the new package name resolves:

   ```sh
   dsh plugin --profile <name> install
   ```

   For a tarball install, download `dsh-superagent-further-0.4.0.tgz` and install it instead:
   `dsh plugin --profile <name> add "file:<path to the 0.4.0 tarball>"`. For a `link:` install, the script keeps the
   checkout path in the spec; the package inside that checkout is now named `dsh-superagent-further`. If the old
   checkout was a different directory, install the new checkout with
   `dsh plugin --profile <name> add "link:<new checkout>"`.
6. Start the host with the new script name (`scripts/dsh-superagent-further start --profile <name>`, or
   `scripts\dsh-superagent-further.cmd start --profile <name>` on Windows) and run
   `scripts/verify-install --profile <name>`; require exit 0.

What stays valid: the `stateDir` and its database (schema 22 migrates to 23 on start; no rename migration), worktrees, Tickets, Threads,
Requests, memories, Policy and settings, the `DSH_SUPERAGENT_*` environment variables and prepare commands, the Source
kinds `github` and `feishu`, and the stored delivery and GitHub-comment markers. Queued acknowledgements, replies and
comments therefore keep deduplicating across the upgrade, and an old Ticket remains valid and resumable. The worker
shims under `<stateDir>/worker-bin` and `<stateDir>/worker-gitconfig` carry the old `# Written by dsh-superagent` marker;
the host recognizes it as its own and rewrites the files on the next start.

The old script filenames (`scripts/dsh-superagent`, `scripts\dsh-superagent.cmd`) no longer exist; use the new names.
Team prompt text and skill bodies are data, not registration ids, so the script leaves them alone: if custom text names
a skill, replace `skill dsh-superagent-github` / `-feishu` with the `dsh-superagent-further-` names, and custom skills
`dsh-superagent-<name>` with `dsh-superagent-further-<name>`, under **Settings → Prompts**. Built-in parts and defaults
come from the new code, so only overridden text and team sections need review.

### Rolling back

1. Stop the host (`scripts/dsh-superagent-further stop`, or quit the DeepSeek Harness application).
2. Restore the backed-up database over `<stateDir>/orchestrator.sqlite`, and remove that directory's `-wal` and `-shm` files.
3. Restore the profile files the migration script backed up (`package.json.pre-0.3.0`, `cordis.patch.yml.pre-0.3.0`)
   and every session log it rewrote (`session.v4.jsonl.zstd.pre-0.3.0.bak`, restored over the log). Sessions recorded
   under the 0.3.0 preset ids do not load in 0.2.0, so this step is required, not optional.
4. Check out the earlier commit, then `pnpm install --frozen-lockfile && pnpm build`.
5. Start the host and run `scripts/verify-install` again; the `schema` line must report the version that checkout expects.

A database migrated by a newer version cannot be opened by an older one, so the backup is the rollback path, not a reverse
migration. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-further-worker` and `dsh-superagent-further-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the primary repository, or to the repository the message names |
| `No Execution project is registered.` | Register a project under Execution → Projects; its repository becomes the primary repository setup checks |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent-further writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent-further` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent-further is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent-further configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |

## First start

A fresh install has no project registered and no completed setup wizard, so the panel opens the
setup wizard by itself the first time it loads. It walks through welcome, the first project (id,
name, clone path, repository and branch), the GitHub agent account check, the optional Feishu
Source and the default language; every step can be skipped, and **Back** returns to an earlier
one. Each step writes the same setting as its Settings page; [005 Panel](005-panel.md#setup-wizard)
describes the dialog.

The wizard is a dialog over the panel: close it to use the rest of the panel, and reopen it from
**Setup wizard** (设置向导) in the header. It opens by itself once per browser session; a later
reload does not open it again.

Finishing or skipping writes `{ "at": …, "skipped": … }` to the `setup-wizard` record of the
Store, which ends the first run. The management API exposes the same state as `wizard` on
`GET /orchestrator/api/state` and records it with `PUT /orchestrator/api/wizard`. Registering a
project also ends the first run, even without an answer, so a deployment configured through the
settings files does not open the wizard.

If the wizard is not enough, the symptoms under Troubleshooting above still apply: the overview
names what blocks the first Ticket, and `status` reports the same problem.

