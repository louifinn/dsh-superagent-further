/**
 * The Orchestrator workspace is a first-class, mandatory identity (`docs/adr/0003-orchestrator-workspace.md`): the setup wizard
 * cannot finish without one, startup is fail-closed until one is selected, and a workspace is never the plugin's state directory,
 * the DSH home or profile, the source checkout, or a project checkout. These tests pin the validation rules, the registration
 * protocol (explicit DSH title, canonical path), the legacy-session retirement order, and the fail-closed startup sequence.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { key } from '../src/core/ids.ts'
import { packageRoot } from '../src/infra/paths.ts'
import { KV } from '../src/kv.ts'
import { startRuntime } from './fixtures/host.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A fresh temporary directory removed after the test. */
function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

/** The workspace-root module, imported lazily so the startup and guard tests can still run while it does not exist yet. */
async function workspaceRoot() {
  return await import('../src/app/workspace-root.ts')
}

/** Assert that `run` rejects with a `WorkspaceSetupError` of `code` and return its problem. */
async function rejection(run: () => Promise<unknown>, code: string) {
  try {
    await run()
  } catch (error) {
    const failure = error as { name?: string; code?: string; problem?: { place?: string; code?: string; detail?: string } }
    expect(failure.name).toBe('WorkspaceSetupError')
    expect(failure.code).toBe(code)
    expect(failure.problem).toMatchObject({ place: 'execution', code })
    return failure.problem!
  }
  throw new Error(`expected a WorkspaceSetupError(${code})`)
}

describe('workspace validation', () => {
  test('creates an empty directory, marks it and returns the canonical path with an explicit title', async () => {
    const { prepareWorkspace, workspaceTitle } = await workspaceRoot()
    const root = temporary('workspace-root-'), stateDir = temporary('workspace-state-')
    const target = join(root, 'agent-home')

    const prepared = await prepareWorkspace({ path: target, stateDir, projects: [] })

    expect(prepared.path).toBe(join(realpathSync.native(root), 'agent-home'))
    expect(prepared.title).toBe(`dsh-superagent-further · agent-home`)
    expect(prepared.title).toBe(workspaceTitle(prepared.path))
    expect(existsSync(join(prepared.path, '.dsh-superagent-workspace'))).toBe(true)
    expect(readFileSync(join(prepared.path, '.dsh-superagent-workspace'), 'utf8')).toContain('dsh-superagent-further')
    if (process.platform !== 'win32') expect(statSync(prepared.path).mode & 0o777).toBe(0o700)
  })

  test('accepts an existing empty directory and a marked workspace, and rejects an unmarked non-empty one', async () => {
    const { prepareWorkspace } = await workspaceRoot()
    const root = temporary('workspace-root-'), stateDir = temporary('workspace-state-')
    const empty = join(root, 'empty'), marked = join(root, 'marked'), occupied = join(root, 'occupied')
    mkdirSync(empty)
    mkdirSync(marked)
    writeFileSync(join(marked, '.dsh-superagent-workspace'), 'dsh-superagent-further workspace\n')
    writeFileSync(join(marked, 'notes.txt'), 'existing agent work\n')
    mkdirSync(occupied)
    writeFileSync(join(occupied, 'notes.txt'), 'not a workspace\n')

    expect((await prepareWorkspace({ path: empty, stateDir, projects: [] })).path).toBe(realpathSync.native(empty))
    expect((await prepareWorkspace({ path: marked, stateDir, projects: [] })).path).toBe(realpathSync.native(marked))
    const problem = await rejection(async () => await prepareWorkspace({ path: occupied, stateDir, projects: [] }), 'workspaceNotEmpty')
    expect(problem.detail).toContain(occupied)
  })

  test('rejects relative, UNC, drive-root and non-directory selections', async () => {
    const { prepareWorkspace } = await workspaceRoot()
    const root = temporary('workspace-root-'), stateDir = temporary('workspace-state-')
    const file = join(root, 'file.txt')
    writeFileSync(file, 'not a directory\n')

    await rejection(async () => await prepareWorkspace({ path: 'relative/workspace', stateDir, projects: [] }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: '\\\\server\\share\\workspace', stateDir, projects: [] }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: process.platform === 'win32' ? 'C:\\' : '/', stateDir, projects: [] }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: file, stateDir, projects: [] }), 'workspaceInvalid')
  })

  test('rejects the state directory, its ancestors and descendants, including the system-owned worker scratch', async () => {
    const { prepareWorkspace } = await workspaceRoot()
    const root = temporary('workspace-root-'), outer = temporary('workspace-state-')
    const stateDir = join(outer, 'nested')
    mkdirSync(stateDir, { recursive: true })

    await rejection(async () => await prepareWorkspace({ path: stateDir, stateDir, projects: [] }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: outer, stateDir, projects: [] }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: join(stateDir, 'work'), stateDir, projects: [] }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: join(root, 'scratch'), stateDir: join(root, 'scratch'), projects: [] }), 'workspaceInvalid')
  })

  test('rejects the DSH home, the DSH profile and its session store, the source checkout and project checkouts', async () => {
    const { prepareWorkspace } = await workspaceRoot()
    const root = temporary('workspace-root-'), stateDir = temporary('workspace-state-')
    const home = join(root, 'home'), dshHome = join(home, '.dsh'), profile = join(dshHome, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    const project = join(root, 'project')

    await rejection(async () => await prepareWorkspace({ path: join(dshHome, 'agent'), stateDir, projects: [], home,
      environment: { DSH_HOME: dshHome, DSH_PROFILE_DIR: profile, DSH_PROFILE: 'desktop' } }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: profile, stateDir, projects: [], home,
      environment: { DSH_HOME: dshHome, DSH_PROFILE_DIR: profile, DSH_PROFILE: 'desktop' } }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: join(profile, 'sessions', 'agent'), stateDir, projects: [], home,
      environment: { DSH_HOME: dshHome, DSH_PROFILE_DIR: profile, DSH_PROFILE: 'desktop' } }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: join(packageRoot(), 'agent-home'), stateDir, projects: [] }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: join(project, 'nested'), stateDir, projects: [{ workspace: project }] }), 'workspaceInvalid')
    await rejection(async () => await prepareWorkspace({ path: root, stateDir, projects: [{ workspace: project }] }), 'workspaceInvalid')
  })

  test('rejects a symbolic link that escapes its declared path', async () => {
    const { prepareWorkspace } = await workspaceRoot()
    const root = temporary('workspace-root-'), stateDir = temporary('workspace-state-')
    const target = join(root, 'target'), link = join(root, 'link')
    mkdirSync(target)
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

    await rejection(async () => await prepareWorkspace({ path: link, stateDir, projects: [] }), 'workspaceUnsafe')
  })

  test('blocks when the directory cannot be written or its owner-only ACL cannot be applied', async () => {
    const { prepareWorkspace } = await workspaceRoot()
    const root = temporary('workspace-root-'), stateDir = temporary('workspace-state-')
    await rejection(async () => await prepareWorkspace({ path: join(root, 'unwritable'), stateDir, projects: [] },
      { writeFile: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) } }), 'workspaceNotWritable')
    await rejection(async () => await prepareWorkspace({ path: join(root, 'acl'), stateDir, projects: [] },
      { restrictToOwner: () => { throw new Error('icacls: failed to grant owner') } }), 'workspaceUnsafe')
  })
})

describe('workspace registration and legacy retirement', () => {
  test('registers the workspace with its explicit title and repairs a drifted title', async () => {
    const { registerWorkspace } = await workspaceRoot()
    const target = { path: '/srv/agent-home', title: 'dsh-superagent-further · agent-home' }
    let title = 'stale title'
    const workspace = { id: 'w1', path: target.path, get title() { return title }, setTitle: vi.fn(async next => { title = next }) }
    const registry = { create: vi.fn(async () => workspace) }

    expect(await registerWorkspace(registry as never, target)).toBe(workspace)
    expect(registry.create).toHaveBeenCalledWith(target.path, target.title)
    expect(workspace.setTitle).toHaveBeenCalledWith(target.title)
  })

  test('retires the stored master session before deleting a stateDir registration and never deletes a session', async () => {
    const { retireMaster } = await workspaceRoot()
    const order: string[] = []
    const registry = {
      archiveSession: vi.fn(async (id: string, options: { stopActivity?: boolean }) => { order.push(`archive:${id}:${options.stopActivity}`) }),
      resolveByPath: vi.fn(async (path: string) => path === '/state' ? { id: 'legacy-workspace', path } : undefined),
      delete: vi.fn(async (id: string) => { order.push(`delete-workspace:${id}`); return true }),
    }

    const result = await retireMaster({ desired: 'orchestrator-new', stored: 'orchestrator-old', stateDir: '/state',
      workspaceId: 'workspace', registry: registry as never, hasSession: async id => id === 'orchestrator-old' })

    expect(result).toEqual({ archived: ['orchestrator-old'] })
    expect(order).toEqual(['archive:orchestrator-old:true', 'delete-workspace:legacy-workspace'])
  })

  test('is idempotent when the stored session is already archived or absent and when replaying a completed migration', async () => {
    const { retireMaster } = await workspaceRoot()
    const registry = {
      archiveSession: vi.fn(async () => {}),
      resolveByPath: vi.fn(async () => undefined),
      delete: vi.fn(async () => true),
    }

    await expect(retireMaster({ desired: 'orchestrator-new', stored: 'orchestrator-old', stateDir: '/state',
      workspaceId: 'workspace', registry: registry as never, hasSession: async () => false })).resolves.toEqual({ archived: [] })
    expect(registry.archiveSession).not.toHaveBeenCalled()

    await expect(retireMaster({ desired: 'orchestrator-new', stored: 'orchestrator-new', stateDir: '/state',
      workspaceId: 'workspace', registry: registry as never, hasSession: async id => id === 'orchestrator-new' })).resolves.toEqual({ archived: [] })
    expect(registry.archiveSession).not.toHaveBeenCalled()
  })
})

describe('fail-closed startup', () => {
  /** Start a host whose settings hold no workspace, as an install upgraded from a build before workspace identity. */
  async function withoutWorkspace() {
    const host = await startRuntime(store => {
      const current = store.settings()
      store.saveSettings({ ...current, workspace: { path: '' } })
    })
    cleanups.push(() => void host.stop())
    return host
  }

  test('a missing workspace pauses setup, registers no DSH workspace and creates no master session', async () => {
    const host = await withoutWorkspace()

    const state = (await host.api('GET', 'state')).body as { setup: { problem: { code: string }; workspace: unknown }
      health: { runtime: Record<string, unknown> } }
    expect(state.setup.problem.code).toBe('workspaceRequired')
    expect(state.setup.workspace).toBeNull()
    expect(state.health.runtime).toMatchObject({ state: 'paused', code: 'setupPending' })
    expect(host.runtime.masterId).not.toBe('')
    expect(host.registry.create).not.toHaveBeenCalled()
    expect(host.controller.create).not.toHaveBeenCalled()
  })

  test('a workspace that cannot be prepared pauses setup with its exact problem code and no master session', async () => {
    const root = temporary('workspace-invalid-')
    const occupied = join(root, 'occupied')
    mkdirSync(occupied)
    writeFileSync(join(occupied, 'notes.txt'), 'not empty\n')
    const target = join(root, 'target')
    writeFileSync(target, 'not a directory\n')

    for (const [path, code] of [[occupied, 'workspaceNotEmpty'], [target, 'workspaceInvalid']] as const) {
      const host = await startRuntime(store => {
        const current = store.settings()
        store.saveSettings({ ...current, workspace: { path } })
      })
      cleanups.push(() => void host.stop())
      const state = (await host.api('GET', 'state')).body as { setup: { problem: { code: string }; workspace: unknown }
        health: { runtime: Record<string, unknown> } }
      expect(state.setup.problem.code).toBe(code)
      expect(state.setup.workspace).toBeNull()
      expect(state.health.runtime).toMatchObject({ state: 'paused', code: 'setupPending' })
      expect(host.registry.create).not.toHaveBeenCalled()
      expect(host.controller.create).not.toHaveBeenCalled()
    }
  })

  test('the setup wizard refuses to skip before a workspace is selected', async () => {
    const host = await withoutWorkspace()
    const refused = await host.api('PUT', 'wizard', { skipped: true })
    expect(refused.status).toBe(400)
    expect((refused.body as { setup: unknown }).setup).toMatchObject({ place: 'execution', code: 'workspaceRequired' })
    expect(await host.api('GET', 'state')).toMatchObject({ body: { wizard: { firstRun: true } } })
  })
})

describe('workspace identity in a running host', () => {
  test('the master session lives in the user workspace, registered under its explicit DSH title', async () => {
    const host = await startRuntime()
    cleanups.push(() => void host.stop())
    const settings = host.runtime.store.settings()

    expect(settings.workspace.path).not.toBe('')
    expect(settings.workspace.path).not.toBe(host.directory)
    expect(host.registry.create).toHaveBeenCalledWith(settings.workspace.path, `dsh-superagent-further · ${settings.workspace.path.split(/[\\/]/).at(-1)}`)
    expect(host.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: host.runtime.masterId, workspaceId: settings.workspace.path }))
  })

  test('a stored legacy master id is replaced by the workspace-derived id without deleting the old session', async () => {
    const host = await startRuntime(store => { store.set(KV.runtime.masterId, 'orchestrator-legacy') })
    cleanups.push(() => void host.stop())
    const settings = host.runtime.store.settings()

    expect(host.runtime.masterId).toBe(`orchestrator-${key(settings.workspace.path)}`)
    expect(host.runtime.store.get(KV.runtime.masterId)).toBe(host.runtime.masterId)
    // The legacy registration of the state directory is retired, but no session is deleted: retirement only archives.
    expect(host.registry.delete).toHaveBeenCalled()
    expect(host.registry.archiveSession.mock.calls.every(([, options]) => options === undefined || options.stopActivity === true)).toBe(true)
  })

  test('the panel exposes the workspace title in state and the workspace block in settings', async () => {
    const host = await startRuntime()
    cleanups.push(() => void host.stop())
    const settings = host.runtime.store.settings()

    const state = (await host.api('GET', 'state')).body as { setup: { workspace: unknown } }
    expect(state.setup.workspace).toMatchObject({
      path: settings.workspace.path, title: `dsh-superagent-further · ${settings.workspace.path.split(/[\\/]/).at(-1)}` })
    const view = (await host.api('GET', 'settings')).body as { blocks: Record<string, { value: unknown; revision: number }> }
    expect(view.blocks.workspace!.value).toEqual({ path: settings.workspace.path })
  })

  test('the workspace settings block validates through the same rules and persists the canonical path', async () => {
    const host = await startRuntime()
    cleanups.push(() => void host.stop())
    const view = (await host.api('GET', 'settings')).body as { blocks: Record<string, { revision: number }> }
    const revision = view.blocks.workspace!.revision

    const refused = await host.api('PUT', 'settings/workspace', { value: { path: 'relative/dir' }, revision })
    expect(refused.status).toBe(400)
    expect(refused.body.setup).toMatchObject({ code: 'workspaceInvalid' })

    const root = temporary('workspace-save-')
    const accepted = await host.api('PUT', 'settings/workspace', { value: { path: join(root, 'agent-home') }, revision })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ restarting: true })
    const saved = (await host.api('GET', 'settings')).body as { blocks: Record<string, { value: { path: string } }> }
    expect(saved.blocks.workspace!.value.path).toBe(join(realpathSync.native(root), 'agent-home'))
  })
})

describe('startup-order guard', () => {
  const source = (name: string) => readFileSync(new URL(`../src/app/${name}`, import.meta.url), 'utf8')

  test('no code path hands the state directory to a DSH workspace registration or a master session', () => {
    for (const file of ['runtime.ts', 'sessions.ts', 'setup.ts', 'settings.ts']) {
      const text = source(file)
      expect(text, file).not.toMatch(/workspaceRegistry\.create\([^)]*stateDir/)
      expect(text, file).not.toMatch(/sessions\.ensure\([^)]*stateDir/)
      expect(text, file).not.toMatch(/ensure\(\s*[^,]+,\s*[^,]*stateDir/)
    }
    // Project Leads run in their declared project workspace; the state directory's work scratch is system-owned.
    expect(source('sessions.ts')).toContain('ensureLead(project.id, project.workspace')
  })

  test('the setup workspace is validated before deployment resolution and before any session starts', () => {
    const setup = source('setup.ts')
    expect(setup).toContain('instanceof WorkspaceSetupError')
    const resolution = setup.slice(setup.indexOf('private async resolve'))
    expect(resolution.indexOf('prepareWorkspace')).toBeGreaterThan(-1)
    expect(resolution.indexOf('prepareWorkspace')).toBeLessThan(resolution.indexOf("SetupError('projectUnset')"))

    const runtime = source('runtime.ts')
    const initialize = runtime.slice(runtime.indexOf('private async initialize'))
    expect(initialize.indexOf('this.setup.run(')).toBeGreaterThan(-1)
    expect(initialize.indexOf('this.setup.run(')).toBeLessThan(initialize.indexOf('this.sessions.install()'))
    expect(initialize.indexOf('this.setup.run(')).toBeLessThan(initialize.indexOf('this.sessions.ensure('))
    expect(initialize.indexOf('registerWorkspace(')).toBeGreaterThan(-1)
    expect(initialize.indexOf('registerWorkspace(')).toBeLessThan(initialize.indexOf('this.sessions.ensure('))
  })
})
