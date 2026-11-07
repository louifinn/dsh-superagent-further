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
      // The Lead's application tool reads its project, its Tickets and its waiting messages.
      const status = await host.runTool('lead-app', 'lead_status', {}) as { project: Record<string, unknown>; tickets: { open: unknown[] };
        messages: unknown[] }
      expect(status.project).toMatchObject({ id: 'app', name: 'App', repository: 'acme/app' })
      expect(status.tickets.open).toEqual([])
      expect(status.messages).toEqual([])
      // After the Session is gone from the host, the recorded Lead is recreated under its own id.
      host.agents.delete('lead-app')
      const recovered = await host.runtime.sessions.adoptLead('app', join(host.directory, 'app'), 'Project App')
      expect(recovered.id).toBe('lead-app')
      expect(host.agents.has('lead-app')).toBe(true)
      expect(host.runtime.store.get(KV.lead.sessions('app'))).toBe('lead-app')
    } finally { await host.stop() }
  })
})
