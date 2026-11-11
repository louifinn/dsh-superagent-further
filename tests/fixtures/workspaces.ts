/**
 * A functional stand-in for `@deepseek-ai/dsh-workspace`'s registry in tests. The real registry canonicalizes paths and keeps
 * titles, session lists, pins and archived ids; these tests need the protocol the runtime uses (create with an explicit title,
 * title repair, lookup by path, delete of a legacy registration, archive on retirement), so the fake keeps a directory-keyed
 * map and exposes its spies to assertions. A workspace's id is its path, like the production registry's stable id, so a
 * Session's `workspaceId` in a test reads as the directory it was created in.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

export interface FakeWorkspace {
  id: string
  path: string
  title: string
  setTitle(title: string): Promise<void>
}

export interface FakeWorkspaceRegistry {
  create(path: string, title?: string): Promise<FakeWorkspace>
  resolveByPath(path: string): Promise<FakeWorkspace | undefined>
  delete(id: string): Promise<boolean>
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
}

/** A fresh directory for an operator's workspace, outside every test's state directory. */
export function workspaceDirectory(prefix = 'orchestrator-workspace-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export interface FakeWorkspaces {
  registry: FakeWorkspaceRegistry & {
    create: ReturnType<typeof vi.fn>
    resolveByPath: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    archiveSession: ReturnType<typeof vi.fn>
  }
  /** The workspaces currently registered, for tests that inspect the map instead of the spies. */
  registered: Map<string, FakeWorkspace>
  /** Registers a workspace directly, as an earlier build's state-directory registration would exist on an upgrade. */
  seed(path: string, title?: string): FakeWorkspace
}

/**
 * Builds the fake registry. `legacy` seeds a registration for an older build's state directory, so retirement has something
 * to delete on the first start of a migrated install.
 */
export function fakeWorkspaces(legacy?: string): FakeWorkspaces {
  const registered = new Map<string, FakeWorkspace>()
  const seed = (path: string, title = path): FakeWorkspace => {
    const workspace: FakeWorkspace = { id: path, path, title, setTitle: async next => { workspace.title = next } }
    registered.set(path, workspace)
    return workspace
  }
  if (legacy !== undefined) seed(legacy, 'legacy state directory')
  const create = vi.fn(async (path: string, title?: string) => registered.get(path) ?? seed(path, title))
  const resolveByPath = vi.fn(async (path: string) => registered.get(path))
  const remove = vi.fn(async (id: string) => {
    for (const [path, workspace] of registered) {
      if (workspace.id === id) { registered.delete(path); return true }
    }
    return false
  })
  const archiveSession = vi.fn(async (_sessionId: string, _options?: { stopActivity?: boolean }) => {})
  return { registry: { create, resolveByPath, delete: remove, archiveSession }, registered, seed }
}
