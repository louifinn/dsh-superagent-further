/** The Lead-session invariant: a project with open work always has a usable Lead Session. */
import { expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

it('unarchives the project Lead before handing it back to a worker', async () => {
  const h = await startRuntime()
  try {
    await h.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
    const project = h.runtime.store.settings().executor.projects.find(item => item.id === 'default')!
    expect(h.agents.has('lead-default')).toBe(true)

    await h.registry.archiveSession('lead-default', { stopActivity: true })
    expect(h.workspaces.archived.has('lead-default')).toBe(true)

    const lead = await h.runtime.sessions.ensureLead(project.id, project.workspace, `Lead · ${project.name}`)
    expect(lead.id).toBe('lead-default')
    expect(h.workspaces.archived.has('lead-default')).toBe(false)

    // DSH gates every model step of an archived Session; unarchived, the Lead accepts a prompt again.
    await expect(h.runtime.sessions.prompt('lead-default', 'lead-invariant:1', 'Where is #162?', 'queue')).resolves.toBeUndefined()
  } finally { await h.stop() }
})

it('gives every project with an open ticket a Lead Session at startup', async () => {
  const first = await startRuntime(undefined, { keep: true })
  const accepted = await first.acceptedTicket(feishu('2', '@bot 看一下日志'), 'answer')
  expect(first.agents.has('lead-default')).toBe(true)
  // The next start finds no loaded Lead, as after a restart that lost the session graph while the Ticket stayed open.
  first.agents.delete('lead-default')
  await first.stop()
  const h = await startRuntime(undefined, { directory: first.directory, workspace: first.workspaceRoot,
    workspaces: first.workspaces, agents: first.agents, keep: true })
  try {
    expect(accepted.ticket.project).toBe('default')
    expect(h.agents.has('lead-default')).toBe(true)
    expect(h.runtime.store.get(KV.lead.sessions('default'))).toBe('lead-default')
    await expect(h.runtime.sessions.prompt('lead-default', 'lead-invariant:2', 'Resume #162.', 'queue')).resolves.toBeUndefined()
  } finally { await h.stop() }
})

it('refuses to remove a project that still has open tickets', async () => {
  const h = await startRuntime()
  try {
    const accepted = await h.acceptedTicket(feishu('3', '@bot 修一下回归'), 'answer')
    const settings = h.runtime.store.settings()
    const without = { ...settings.executor, projects: settings.executor.projects.filter(item => item.id !== 'default') }
    await expect(h.runtime.settings.save('executor', without, h.runtime.store.blockRevision('executor'), 'panel'))
      .rejects.toThrow(/still has \d+ open Ticket/)
    expect(h.runtime.store.settings().executor.projects.some(item => item.id === 'default')).toBe(true)

    // Once the ticket has ended, the project holds no open work and may be removed.
    h.runtime.engine.stopTicket(accepted.ticket.id, 'No longer needed.')
    await h.runtime.settings.save('executor', without, h.runtime.store.blockRevision('executor'), 'panel')
    expect(h.runtime.store.settings().executor.projects.some(item => item.id === 'default')).toBe(false)
  } finally { await h.stop() }
})
