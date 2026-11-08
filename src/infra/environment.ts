/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent-further on every start; edits are lost.'
/**
 * Markers of files written under the project's earlier names, which `dsh-superagent-further` owns and replaces too.
 * `dsh-superagent` is the name the bundle used until 0.3.0: an existing state directory's shims carry it, and refusing
 * them would make every upgrade ask the operator to move the directory.
 */
const LEGACY_MARKERS = ['dsh-superagent', 'dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

/** A directory's canonical spelling: its real path, its trailing separators dropped, and its case folded on Windows, whose filesystems ignore it. */
function directoryKey(path: string): string {
  let real: string
  try { real = realpathSync(path) } catch { real = resolve(path) }
  const trimmed = real.replace(/[\\/]+$/, '')
  // A root (`/` or `C:\`) keeps its separator, so all its spellings still name the same directory.
  const canonical = trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? real : trimmed
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}
/**
 * True when both spellings name the same directory, including one with a trailing separator or, on Windows, another case
 * and mixed `/` and `\` separators.
 */
export function sameDirectory(a: string, b: string): boolean { return directoryKey(a) === directoryKey(b) }
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** The markers that identify a file dsh-superagent-further writes; a POSIX shim names the marker with a `#` comment and a Windows shim with `rem`. */
const MARKERS: readonly string[] = [MARKER, ...LEGACY_MARKERS]
/** True when a regular file starts with a dsh-superagent-further marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent-further. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return MARKERS.some(marker => head.some(line => line.includes(marker)))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/** Windows shells find a command by its extension (`PATHEXT`), so their shims carry `.cmd`; POSIX shells run the extension-less wrapper. */
const WINDOWS = process.platform === 'win32'
const shimFile = (name: string): string => WINDOWS ? `${name}.cmd` : name
/** A literal in a batch file: `%` starts a variable reference, and the redirection and separators would split the command. */
const batchLiteral = (value: string): string => value.replaceAll('%', '%%').replace(/[\^&|<>()]/g, char => `^${char}`)
/**
 * The batch body of a shim that removes its own directory from PATH and runs `program` with the shim's arguments, forwarding
 * its exit status. A wrapper the program runs by name must reach the real CLI, never this shim again; PATH may spell the
 * directory with backslashes or forward slashes, and batch's substring substitution ignores case.
 */
function runBatch(program: string): string {
  return [
    'setlocal EnableDelayedExpansion',
    'set "SELF=%~dp0"',
    // `%~dp0` ends in a separator; the substitution below needs the directory without it.
    'if "%SELF:~-1%"=="\\" set "SELF=%SELF:~0,-1%"',
    'set "FSELF=%SELF:\\=/%"',
    'set "PATH=;!PATH!;"',
    'set "PATH=!PATH:;%SELF%;=;!"',
    'set "PATH=!PATH:;%FSELF%;=;!"',
    'set "PATH=!PATH:~1,-1!"',
    `call "${program.replaceAll('%', '%%')}" %*`,
    'exit /b %ERRORLEVEL%',
  ].join('\n')
}
/** The batch body of a shim that refuses to run a command, printing `message` to stderr. */
const failBatch = (message: string): string => `1>&2 echo ${batchLiteral(message)}\nexit /b 1`

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const file = shimFile(name)
    const temporary = join(dir, `.${file}.${process.pid}.tmp`)
    await writeFile(temporary, `${WINDOWS ? '@echo off' : '#!/bin/sh'}\n${WINDOWS ? `rem ${MARKER}` : MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, file))
    kept.add(file)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => WINDOWS ? runBatch(program) : `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => WINDOWS ? failBatch(message) : `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', run(github.cli))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/**
 * The pairs in `git config -z --show-origin` output, which separates the origin from its value with NUL. `-z` never quotes a
 * path, but an older git that ignores `-z` prints a C-quoted origin, which `originPath` unquotes.
 */
function originEntries(output: string): [string, string][] {
  const fields = output.split('\0')
  const entries: [string, string][] = []
  for (let index = 0; index + 1 < fields.length; index += 2) entries.push([fields[index]!, fields[index + 1]!])
  return entries
}
/** The path a `--show-origin` origin names, or `undefined` when the setting did not come from a file. */
function originPath(origin: string): string | undefined {
  if (!origin.startsWith('file:')) return undefined
  const value = origin.slice('file:'.length)
  return value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const output = await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')
  const entries = originEntries(output)
  const expected = credentialHelper(github.cli)
  // The helper must be the one in the worker gitconfig, whose path git prints as it was written: Windows may spell it with
  // another case or with forward slashes.
  const matches = entries.length === 1 && (() => {
    const [origin, value] = entries[0]!
    const path = originPath(origin)
    return path !== undefined && sameDirectory(path, workerGitConfig(stateDir)) && value === expected
  })()
  if (!matches) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
