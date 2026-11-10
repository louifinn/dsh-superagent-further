import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeLeadPrompt, defaultPrompts } from '../src/app/prompts.ts'
import { leadProjectOf, leadSessionId } from '../src/app/sessions.ts'
import type { Project } from '../src/projects.ts'
import { KV } from '../src/kv.ts'
import { startRuntime } from './fixtures/host.ts'

const PROJECT: Project = { id: 'app', name: 'App', workspace: '/src/app', repository: 'acme/app', branch: 'main' }

describe('Lead Sessions', () => {
  it('names a Session id after its project and reads the project back', () => {
    expect(leadSessionId('app')).toBe('lead-app')
    expect(leadProjectOf('lead-app')).toBe('app')
    expect(leadProjectOf('lead-')).toBeUndefined()
    expect(leadProjectOf('worker-ticket-1')).toBeUndefined()
    expect(leadProjectOf('orchestrator-1234')).toBeUndefined()
  })

  it('composes a Lead prompt from the shared rules, the Lead instructions, and its project', () => {
    const prompt = composeLeadPrompt(defaultPrompts(), PROJECT)
    expect(prompt).toContain('You are the Lead of one project')
    expect(prompt).toContain('Project App (app).')
    expect(prompt).toContain('Local clone /src/app; repository acme/app; base branch main.')
    expect(prompt).toContain('## subscriptions')
    expect(prompt).toContain('Execution environment')
    // The Lead's project-request duties are part of its built-in prompt, not only the tools' descriptions.
    expect(prompt).toContain('## project requests')
    expect(prompt).toContain('lead_request_decide')
    expect(prompt).toContain('needs-attention')
  // A Lead's memories arrive in the runtime-context snapshot too, scoped to its project.
  expect(prompt).toContain('runtime-context snapshot')
  expect(prompt).not.toContain('## Memory')
    // The Orchestrator's admission and Policy sections and the worker's work guide do not apply to a Lead.
    expect(prompt).not.toContain('## admission')
    expect(prompt).not.toContain('## Policy')
    expect(prompt).not.toContain('## work')
  })

  it('follows a team override of the Lead section and names the default branch when none is set', () => {
    const config = { ...defaultPrompts(), overrides: { 'runtime/lead': { text: '## lead\nOur own Lead rules.', base: 'previous' } } }
    const prompt = composeLeadPrompt(config, { ...PROJECT, branch: '' })
    expect(prompt).toContain('Our own Lead rules.')
    expect(prompt).toContain('base branch the repository default branch')
  })

  it('ensures one Lead Session per project and recovers it from the Store', async () => {
    const host = await startRuntime()
    try {
      const settings = host.runtime.store.settings()
      host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
        projects: [{ ...PROJECT, workspace: join(host.directory, 'app') }] } })
      const agent = await host.runtime.sessions.ensureLead('app', join(host.directory, 'app'), 'Project App')
      expect(agent.id).toBe('lead-app')
      expect(host.runtime.store.get(KV.lead.sessions('app'))).toBe('lead-app')
      // A second ensure resolves the loaded Session and does not create another one.
      const again = await host.runtime.sessions.ensureLead('app', join(host.directory, 'app'), 'Project App')
      expect(again.id).toBe('lead-app')
      // The Lead's application tools read its project, its Tickets and its waiting messages, and list its requests.
      expect([...host.tools.get('lead-app')!.keys()].sort()).toEqual(['lead_request_approval', 'lead_request_approve',
        'lead_request_complete', 'lead_request_create', 'lead_request_decide', 'lead_request_escalate', 'lead_request_reply', 'lead_requests', 'lead_review',
        'lead_review_record', 'lead_status', 'memory_forget', 'memory_search', 'memory_write'])
      const status = await host.runTool('lead-app', 'lead_status', {}) as { project: Record<string, unknown>; tickets: { open: unknown[] };
        messages: unknown[] }
      expect(status.project).toMatchObject({ id: 'app', name: 'App', repository: 'acme/app' })
      expect(status.tickets.open).toEqual([])
      expect(status.messages).toEqual([])
      expect(await host.runTool('lead-app', 'lead_requests', {})).toMatchObject({ project: 'app', requests: [], unanswered: [], reports: [], attention: [] })
      // A Lead raises the work an automation delivery found; the records name the Lead Session and the automation.
      const raised = await host.runTool('lead-app', 'lead_request_create', { title: 'Fix the flaky Windows test',
        instruction: 'It fails only on Windows; make the wait deterministic.', automation: 'auto-1' }) as
        { id: string; status: string; raised_by: { session: string; automation?: string } }
      expect(raised.status).toBe('pending')
      expect(typeof raised.raised_by.session).toBe('string')
      expect(raised.raised_by.automation).toBe('auto-1')
      const listed = await host.runTool('lead-app', 'lead_requests', {}) as { requests: { id: string }[] }
      expect(listed.requests.map(request => request.id)).toContain(raised.id)
      // A Lead remembers, recalls and forgets only inside its own project; installation-wide memories belong to the
      // Orchestrator, and another project's memories are invisible unless the Lead is given that project.
      const mine = host.runtime.store.memories.save({ kind: 'fact', project: 'app', text: 'The app keeps its release notes in docs.' })
      const other = host.runtime.store.memories.save({ kind: 'fact', project: 'lib', text: 'The lib keeps its release notes in CHANGELOG.' })
      const global = host.runtime.store.memories.save({ kind: 'preference', text: 'The person prefers release notes in Chinese.' })
      const visible = (await host.runTool('lead-app', 'memory_search', { query: 'release' })) as { memories: { id: string }[] }
      expect(visible.memories.map(memory => memory.id)).toEqual([mine.id])
      await expect(host.runTool('lead-app', 'memory_forget', { id: other.id })).rejects.toThrow(/is stored for project app/)
      await expect(host.runTool('lead-app', 'memory_write', { text: 'x', project: 'lib' })).rejects.toThrow(/can only remember project app/)
      const written = (await host.runTool('lead-app', 'memory_write', { text: 'App Tickets run under the lead-app Session.' })) as { project: string }
      expect(written.project).toBe('app')
      // The Orchestrator's own memory tools still span the whole installation.
      const everything = (await host.runTool(host.runtime.masterId, 'memory_search', { query: 'release' })) as { memories: { id: string }[] }
      expect(everything.memories.map(memory => memory.id).sort()).toEqual([mine.id, other.id, global.id].sort())
      // After the Session is gone from the host, the recorded Lead is recreated under its own id.
      host.agents.delete('lead-app')
      const recovered = await host.runtime.sessions.adoptLead('app', join(host.directory, 'app'), 'Project App')
      expect(recovered.id).toBe('lead-app')
      expect(host.agents.has('lead-app')).toBe(true)
      expect(host.runtime.store.get(KV.lead.sessions('app'))).toBe('lead-app')
    } finally { await host.stop() }
  })
})
