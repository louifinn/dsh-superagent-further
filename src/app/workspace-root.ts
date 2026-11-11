/**
 * The Orchestrator workspace: the operator-chosen directory the main Session runs in (docs/adr/0003-workspace-identity.md).
 *
 * DSH sessions keep their `cwd` for life, so a workspace is an identity, not a preference: the first selection must be an
 * empty directory (this module writes the `.dsh-superagent-workspace` marker), the path is persisted canonical and made
 * owner-only, and it can never be the plugin's state directory, the DSH home, profile or session store, the source
 * checkout, or a project checkout. A non-empty directory without the marker is refused rather than searched.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { restrictToOwner } from '../infra/acl.ts'
import { isAbsolutePath, packageRoot } from '../infra/paths.ts'
import { fill } from '../infra/text.ts'
import type { SetupCode, SetupPlace, SetupProblem } from '../setup.ts'

/** The marker file that makes a directory this deployment's workspace; it never appears outside one. */
export const WORKSPACE_MARKER = '.dsh-superagent-workspace'
/** The marker's contents; written owner-only and used only as a marker, never read as configuration. */
const MARKER_TEXT = 'dsh-superagent-further workspace\n'
/** Codes the workspace rules add to `SetupError`; they live here because `src/setup.ts` owns deployment problems only. */
export type WorkspaceCode = 'workspaceRequired' | 'workspaceInvalid' | 'workspaceNotWritable' | 'workspaceNotEmpty' | 'workspaceUnsafe'
const WORKSPACE_PROBLEMS = {
  workspaceRequired: ['execution',
    'The orchestrator workspace is not selected. Choose an empty directory in the setup wizard before selecting a project.'],
  workspaceInvalid: ['execution',
    '"{path}" cannot be the orchestrator workspace ({reason}). Choose an empty directory outside the state directory, the DSH home and profile, dsh-superagent-further\'s own checkout, and every project checkout.'],
  workspaceNotWritable: ['execution',
    'The orchestrator workspace "{path}" is not writable, so dsh-superagent-further cannot use it.'],
  workspaceNotEmpty: ['execution',
    'The orchestrator workspace "{path}" is not empty and carries no dsh-superagent-further workspace marker. Choose an empty directory.'],
  workspaceUnsafe: ['execution',
    'The orchestrator workspace "{path}" cannot be protected for its owner ({reason}).'],
} as const satisfies Record<WorkspaceCode, readonly [SetupPlace, string]>

/**
 * Thrown when the selected workspace is missing, invalid, not writable, not empty, or unsafe. `Setup` records it for the
 * management panel, and the HTTP layer returns `problem` so the panel localizes it exactly like a deployment problem.
 */
export class WorkspaceSetupError extends Error {
  readonly place: SetupPlace = 'execution'
  constructor(readonly code: WorkspaceCode, readonly values: Record<string, string> = {}) {
    super(fill(WORKSPACE_PROBLEMS[code][1], values))
    this.name = 'WorkspaceSetupError'
  }
  /**
   * The structured problem the panel renders. The code is cast because the workspace codes extend the deployment table
   * without editing `src/setup.ts`; every one has a `setup.<code>` locale entry.
   */
  get problem(): SetupProblem { return { place: 'execution', code: this.code as SetupCode, values: this.values, detail: this.message } }
}

/** The explicit DSH workspace title: the product name and the workspace's directory name, stable across the install. */
export function workspaceTitle(path: string): string {
  return `dsh-superagent-further · ${basename(path) || path}`
}

/** Filesystem operations `prepareWorkspace` uses, injectable so tests can pin the ACL and write failure branches. */
export interface WorkspaceDeps {
  exists?(path: string): boolean
  realpath?(path: string): string
  lstat?(path: string): { isSymbolicLink(): boolean }
  stat?(path: string): { isDirectory(): boolean }
  readdir?(path: string): string[]
  mkdir?(path: string): void
  writeFile?(path: string, text: string): void
  chmod?(path: string, mode: number): void
  restrictToOwner?(path: string, directory: boolean): void
}
export interface WorkspaceInput {
  /** The directory the operator typed, or the persisted canonical path being re-validated at startup. */
  path: string
  /** The plugin's state directory, which holds the database, logs and worker scratch and is never a workspace. */
  stateDir: string
  /** The registered projects' checkouts, which are never the orchestrator workspace. */
  projects: readonly { workspace: string }[]
  /** The environment the DSH home and profile are read from; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** The user's home directory; defaults to `os.homedir()`. */
  home?: string
  /** dsh-superagent-further's own checkout; defaults to `packageRoot()`. */
  repository?: string
}
export interface PreparedWorkspace { path: string; title: string; created: boolean }

const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
/** Whether `child` is `parent` or lies below it, after canonicalization and case folding on Windows. */
function within(parent: string, child: string): boolean {
  const rest = relative(fold(resolve(parent)), fold(resolve(child)))
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
}
/** Two paths overlap when either contains the other; a workspace may never share ground with a forbidden location. */
const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a)

/** Canonicalize an existing path the way `WorkspaceRegistry.create` will, without requiring the path to exist. */
function canonical(path: string, deps: WorkspaceDeps): { path: string; existed: boolean } {
  const exists = deps.exists ?? existsSync
  const realpath = deps.realpath ?? realpathSync.native
  const lexical = resolve(path)
  if (exists(lexical)) return { path: realpath(lexical), existed: true }
  // Resolve the nearest existing ancestor, then append the missing names so the result is canonical even before creation.
  let ancestor = lexical
  const missing: string[] = []
  while (!exists(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new WorkspaceSetupError('workspaceInvalid', { path, reason: 'no existing parent directory' })
    missing.unshift(basename(ancestor))
    ancestor = parent
  }
  return { path: resolve(realpath(ancestor), ...missing), existed: false }
}

/**
 * Validate a selected workspace and prepare it for use: reject every location whose identity belongs to the state
 * directory, the DSH home/profile/session store, the source checkout, or a project; canonicalize the path (rejecting a
 * symbolic link that escapes the declared location); require an empty directory on first selection; write the marker;
 * and restrict the directory and marker to their owner.
 * @throws WorkspaceSetupError with the exact failure the panel and startup report.
 */
export async function prepareWorkspace(input: WorkspaceInput, deps: WorkspaceDeps = {}): Promise<PreparedWorkspace> {
  const raw = input.path.trim()
  if (raw === '') throw new WorkspaceSetupError('workspaceRequired')
  if (!isAbsolutePath(raw)) throw new WorkspaceSetupError('workspaceInvalid', { path: raw, reason: 'a relative path' })
  if (/^[\\/]{2}/.test(raw)) throw new WorkspaceSetupError('workspaceInvalid', { path: raw, reason: 'a UNC path' })
  const lexical = resolve(raw)
  if (lexical === parse(lexical).root) throw new WorkspaceSetupError('workspaceInvalid', { path: raw, reason: 'a filesystem root' })

  const exists = deps.exists ?? existsSync
  const realpath = deps.realpath ?? realpathSync.native
  const target = canonical(raw, deps)
  // Refuse the selection itself when it is a link; `realpath` comparisons would also flag legitimate case/8.3 spelling.
  if (target.existed && (deps.lstat ?? lstatSync)(lexical).isSymbolicLink()) {
    throw new WorkspaceSetupError('workspaceUnsafe', { path: raw, reason: 'the path is a symbolic link' })
  }
  if (target.existed && !(deps.stat ?? statSync)(target.path).isDirectory()) {
    throw new WorkspaceSetupError('workspaceInvalid', { path: raw, reason: 'not a directory' })
  }

  const environment = input.environment ?? process.env
  const home = input.home ?? homedir()
  const dshHome = environment.DSH_HOME?.trim() || join(home, '.dsh')
  const profile = environment.DSH_PROFILE_DIR?.trim() || join(dshHome, 'profiles', environment.DSH_PROFILE?.trim() || 'desktop')
  const repository = input.repository ?? packageRoot()
  /** Ensure an existing forbidden path is compared canonically; a path that does not exist is compared lexically. */
  const root = (path: string): string => exists(path) ? realpath(path) : resolve(path)
  const forbidden: [string, string][] = [
    [root(input.stateDir), 'the state directory'],
    [root(dshHome), 'the DSH home'],
    [root(join(dshHome, 'profiles')), 'the DSH profiles'],
    [root(profile), 'the DSH profile'],
    [root(join(profile, 'sessions')), 'the DSH session store'],
    [root(repository), "dsh-superagent-further's checkout"],
    ...input.projects.filter(project => project.workspace.trim() !== '')
      .map((project): [string, string] => [root(project.workspace), 'a project checkout']),
  ]
  for (const [path, reason] of forbidden) {
    if (overlaps(target.path, path)) throw new WorkspaceSetupError('workspaceInvalid', { path: raw, reason: `it overlaps ${reason}` })
  }

  if (!target.existed) {
    try { (deps.mkdir ?? (path => mkdirSync(path, { recursive: true, mode: 0o700 })))(target.path) }
    catch (error) { throw new WorkspaceSetupError('workspaceNotWritable', { path: raw, output: message(error) }) }
  }
  if (!(deps.stat ?? statSync)(target.path).isDirectory()) throw new WorkspaceSetupError('workspaceInvalid', { path: raw, reason: 'not a directory' })
  const entries = (deps.readdir ?? readdirSync)(target.path)
  if (!entries.includes(WORKSPACE_MARKER) && entries.length > 0) {
    throw new WorkspaceSetupError('workspaceNotEmpty', { path: target.path })
  }
  const marker = join(target.path, WORKSPACE_MARKER)
  try {
    (deps.writeFile ?? ((path, text) => writeFileSync(path, text, { mode: 0o600 })))(marker, MARKER_TEXT)
  } catch (error) {
    throw new WorkspaceSetupError('workspaceNotWritable', { path: raw, output: message(error) })
  }
  try {
    const chmod = deps.chmod ?? chmodSync
    const restrict = deps.restrictToOwner ?? restrictToOwner
    chmod(target.path, 0o700)
    restrict(target.path, true)
    restrict(marker, false)
  } catch (error) {
    throw new WorkspaceSetupError('workspaceUnsafe', { path: raw, reason: message(error) })
  }
  return { path: target.path, title: workspaceTitle(target.path), created: !target.existed }
}

/** The `WorkspaceRegistry` operations this module needs; DSH's real registry satisfies it structurally. */
export interface WorkspaceView { id: string; path: string; title: string; setTitle(title: string): Promise<void> }
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceView>
  resolveByPath(path: string): Promise<WorkspaceView | undefined>
  delete(id: string): Promise<boolean>
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
}

/**
 * Register the prepared workspace with DSH under its explicit title. `create` is idempotent by canonical path but keeps
 * an existing title, so a renamed product or directory repairs the title explicitly.
 */
export async function registerWorkspace(registry: WorkspaceRegistryLike, target: Pick<PreparedWorkspace, 'path' | 'title'>): Promise<WorkspaceView> {
  const workspace = await registry.create(target.path, target.title)
  if (workspace.title !== target.title) await workspace.setTitle(target.title)
  return workspace
}

export interface RetireInput {
  /** The workspace-derived session id this install must now use (`orchestrator-<hash(workspaceDir)>`). */
  desired: string
  /** The master id a previous version stored; when it differs, its session is archived (never deleted) first. */
  stored?: string
  /** The plugin's state directory whose legacy DSH workspace registration must be removed. */
  stateDir: string
  /** The registered workspace's id, which is not the legacy state directory. */
  workspaceId: string
  registry: WorkspaceRegistryLike
  /** Whether DSH still knows the stored session; an unknown or unreadable id is already retired. */
  hasSession(id: string): Promise<boolean>
}
/**
 * Retire a previous master session and the state directory's legacy workspace registration. Archiving happens before the
 * registration is deleted, and no session is ever removed: the old conversation stays readable as history while the new
 * workspace-derived session, with a new id, has no conversation continuity. The caller publishes the new master id only
 * after creating that session, so a crash between the steps replays the same idempotent retirement on the next start.
 */
export async function retireMaster(input: RetireInput): Promise<{ archived: string[] }> {
  const archived: string[] = []
  if (input.stored !== undefined && input.stored !== input.desired && await input.hasSession(input.stored)) {
    await input.registry.archiveSession(input.stored, { stopActivity: true })
    archived.push(input.stored)
  }
  const legacy = await input.registry.resolveByPath(input.stateDir)
  if (legacy !== undefined && legacy.id !== input.workspaceId) await input.registry.delete(legacy.id)
  return { archived }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
