import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeSurfacePrompt, defaultPrompts } from '../src/app/prompts.ts'
import { leadProjectOf, leadSessionId } from '../src/app/sessions.ts'
import type { Project } from '../src/projects.ts'
import { KV } from '../src/kv.ts'
import { feishuTrigger } from '../src/sources/feishu.ts'
import { CHAT, MEMBER, startRuntime } from './fixtures/host.ts'

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
    const prompt = composeSurfacePrompt(defaultPrompts(), 'lead', { project: PROJECT })
    expect(prompt).toContain('You are the Lead of one project')
    expect(prompt).toContain('Project App (app).')
    expect(prompt).toContain('Local clone /src/app; repository acme/app; base branch main.')
    expect(prompt).toContain('## subscriptions')
    expect(prompt).toContain('Execution environment')
    // The Lead's project-request duties are part of its built-in prompt, not only the tools' descriptions.
    expect(prompt).toContain('## project requests')
    expect(prompt).toContain('lead_request_decide')
    expect(prompt).toContain('needs-attention')
    // A superagent-self finding routes through the Lead's own project or an escalation (document 014).
    expect(prompt).toContain('## self-evolution findings')
    expect(prompt).toContain('lead_request_escalate')
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
    const prompt = composeSurfacePrompt(config, 'lead', { project: { ...PROJECT, branch: '' } })
    expect(prompt).toContain('Our own Lead rules.')
    expect(prompt).toContain('base branch the repository default branch')
  })

  it('ensures one Lead Session per project and recovers it from the Store', async () => {
    const host = await startRuntime()
    try {
      const settings = host.runtime.store.settings()
      // Memory is off by default; this test exercises a Lead's memory tools, so it opts in first.
      host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
        projects: [{ ...PROJECT, workspace: join(host.directory, 'app') }] }, memory: { ...settings.memory, enabled: true } })
      const agent = await host.runtime.sessions.ensureLead('app', join(host.directory, 'app'), 'Project App')
      expect(agent.id).toBe('lead-app')
      expect(host.runtime.store.get(KV.lead.sessions('app'))).toBe('lead-app')
      // A second ensure resolves the loaded Session and does not create another one.
      const again = await host.runtime.sessions.ensureLead('app', join(host.directory, 'app'), 'Project App')
      expect(again.id).toBe('lead-app')
      // The Lead's application tools read its project, its Tickets and its waiting messages, and list its requests.
      expect([...host.tools.get('lead-app')!.keys()].sort()).toEqual(['lead_assign', 'lead_fact', 'lead_instruction_reply', 'lead_notice_decide', 'lead_notices', 'lead_notify_worker', 'lead_relay', 'lead_relay_worker', 'lead_report', 'lead_request_approval',
        'lead_request_approve', 'lead_request_complete', 'lead_request_create', 'lead_request_decide', 'lead_request_escalate',
        'lead_request_reply', 'lead_request_user_notice', 'lead_requests', 'lead_review', 'lead_review_record', 'lead_status', 'lead_ticket_attach',
        'lead_ticket_note', 'lead_ticket_request_status', 'lead_ticket_retry', 'lead_ticket_stop', 'memory_forget', 'memory_search',
        'memory_write', 'orchestrator_read'])
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

const feishu = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishuTrigger({
  message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text,
  create_time: String(Date.parse('2026-11-25T00:00:00Z') + Number(id) * 1000), mentions: [{ id: 'ou_bot' }], ...overrides,
}, 'ou_bot', 'cli_bot')!

const parentOf = (host: Awaited<ReturnType<typeof startRuntime>>, sessionId: string): string | undefined =>
  (host.agents.get(sessionId) as unknown as { session: { header: { parentSession?: string } } } | undefined)?.session.header.parentSession

describe('bounded project-request derivation (issue #33)', () => {
  it('derives a follow-up from the project request that produced its Ticket', async () => {
    const host = await startRuntime()
    try {
      const { ticket } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer')
      const root = await host.runTool(`worker-${ticket.id}`, 'request_create',
        { title: 'Decide the status page', instruction: 'The page needs a decision.' }) as { id: string }
      const accepted = await host.runTool('lead-default', 'lead_request_decide',
        { id: root.id, action: 'accept', reply: 'Build it.', deliverables: [{ title: 'Status page' }] }) as { request_id?: string }
      const created = host.runtime.store.requests.get(accepted.request_id!)!
      const first = created.ticketIds[0]!
      await host.assign(first)
      // The follow-up derives from the accepted project request instead of starting a channel-less chain.
      const child = await host.runTool(`worker-${first}`, 'request_create',
        { title: 'Decide the page name', instruction: 'The name needs a decision.' }) as { id: string }
      const derived = host.runtime.store.projectRequests.get(child.id)!
      expect(derived.root).toMatchObject({ project_request_id: root.id, trigger_id: ticket.origin.triggerId })
      expect(host.runtime.store.projectRequests.get(root.id)!.derived).toContain(child.id)
    } finally { await host.stop() }
  })
})

describe('dispatch through the project Lead (issue #12)', () => {
  it('dispatches an Assignment to its Lead, starts it only with lead_assign, and carries the report back through the Lead',
    async () => {
      const host = await startRuntime()
      try {
        const { ticket } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'), 'answer', { assign: false })
        const assignment = ticket.assignments[0]!
        const worker = `worker-${ticket.id}`
        // The Orchestrator only dispatched: one durable assignment message names the Ticket, the Assignment and the worker.
        const grant = host.runtime.store.leads.list('default', 10)
          .find(message => message.requestId === `lead-assignment:${assignment.id}`)!
        expect(grant).toMatchObject({ kind: 'assignment', from: 'orchestrator', to: 'lead', ticketId: ticket.id })
        expect(grant.deliveredAt).toBeDefined()
        expect(host.runtime.store.tickets.get(ticket.id)!.assignments[0]!.state).toBe('pending')
        expect(host.agents.has(worker)).toBe(false)
        expect(host.runtime.effects.pending('launch')).toBe(false)
        expect(host.relays(host.runtime.masterId)).not.toContainEqual(expect.objectContaining({ kind: 'worker_report' }))
        // The Lead grants the dispatch: the worker is the Lead's child and the grant is acknowledged.
        await host.assign(ticket.id)
        expect(host.runtime.store.tickets.get(ticket.id)!.assignments[0]!.state).toBe('running')
        expect(parentOf(host, worker)).toBe('lead-default')
        expect(host.runtime.store.leads.get(grant.id)!.ackAt).toBeDefined()
        // The worker reports to its Lead only; the Orchestrator hears nothing yet.
        await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Fixed the regression.' })
        const report = host.runtime.store.leads.list('default', 10).find(message => message.kind === 'report')!
        expect(report).toMatchObject({ from: 'executor', to: 'lead', ticketId: ticket.id })
        expect(report.requestId).toMatch(/^executor-report:/)
        expect(report.body).toContain('Fixed the regression.')
        expect(host.relays(host.runtime.masterId)).not.toContainEqual(expect.objectContaining({ kind: 'worker_report' }))
        // Only the Lead's lead_report carries it up, with the worker's own report text.
        const reportId = report.requestId.slice('executor-report:'.length)
        await host.runTool('lead-default', 'lead_report', { report_id: reportId })
        await host.runtime.idle()
        const relay = host.relays(host.runtime.masterId).at(-1)!
        expect(relay).toMatchObject({ kind: 'lead_report', ticket: { ticket_id: ticket.id }, report_id: reportId })
        expect(JSON.stringify(relay)).toContain('Fixed the regression.')
      } finally { await host.stop() }
    })

  it('starts no worker for a dispatched Assignment until its Lead grants it', async () => {
    const host = await startRuntime()
    try {
      const { ticket } = await host.acceptedTicket(feishu('2', '@bot 修二'), 'change', { assign: false })
      expect(host.runtime.store.tickets.get(ticket.id)!.assignments[0]!.state).toBe('pending')
      expect(host.agents.has(`worker-${ticket.id}`)).toBe(false)
      expect(host.deliveries.mock.calls.filter(([call]) => call.sessionId === `worker-${ticket.id}`)).toEqual([])
    } finally { await host.stop() }
  })

  it('refuses an Assignment whose dispatch its Lead has no unacknowledged message for, and records the refusal', async () => {
    const host = await startRuntime()
    try {
      const { ticket } = await host.acceptedTicket(feishu('3', '@bot 修三'), 'change', { assign: false })
      const assignment = ticket.assignments[0]!
      const grant = host.runtime.store.leads.list('default', 10)
        .find(message => message.requestId === `lead-assignment:${assignment.id}`)!
      // A message the Lead already answered is no grant; even a stale prompt cannot start the Assignment.
      host.runtime.store.leads.ack(grant.id)
      await expect(host.runTool('lead-default', 'lead_assign', { assignment_id: assignment.id }))
        .rejects.toThrow(new RegExp(`Assignment ${assignment.id} is not waiting for this Lead's dispatch in project default`))
      expect(() => host.runtime.executor.assignForLead(ticket.id, assignment.id))
        .toThrow(/holds no dispatch for Assignment/)
      expect(host.runtime.store.tickets.get(ticket.id)!.assignments[0]!.state).toBe('pending')
      expect(host.agents.has(`worker-${ticket.id}`)).toBe(false)
      expect(host.runtime.logs.list({ scope: 'executor' }).map(entry => entry.message))
        .toContain(`assignment.dispatchRefused ticket=${ticket.id} assignment=${assignment.id} reason=no-grant`)
    } finally { await host.stop() }
  })

  it('refuses a second lead_assign for an Assignment it already started', async () => {
    const host = await startRuntime()
    try {
      const { ticket } = await host.acceptedTicket(feishu('4', '@bot 修四'))
      const assignment = ticket.assignments[0]!
      await expect(host.runTool('lead-default', 'lead_assign', { assignment_id: assignment.id }))
        .rejects.toThrow(new RegExp(`Assignment ${assignment.id} is not waiting for this Lead's dispatch in project default`))
      expect(host.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
      expect(host.runtime.store.tickets.get(ticket.id)!.assignments[0]!.state).toBe('running')
    } finally { await host.stop() }
  })

  it('refuses a Lead that tries to start another project\'s Assignment', async () => {
    const host = await startRuntime()
    try {
      const settings = host.runtime.store.settings()
      host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, projects: [...settings.executor.projects,
        { id: 'lib', name: 'Lib', workspace: join(host.directory, 'lib'), repository: 'acme/lib', branch: '' }] } })
      mkdirSync(join(host.directory, 'lib'), { recursive: true })
      await host.runtime.sessions.ensureLead('lib', join(host.directory, 'lib'), 'Project Lib')
      const { ticket } = await host.acceptedTicket(feishu('5', '@bot 修五'), 'change', { assign: false })
      const assignment = ticket.assignments[0]!
      await expect(host.runTool('lead-lib', 'lead_assign', { assignment_id: assignment.id }))
        .rejects.toThrow(new RegExp(`Assignment ${assignment.id} is not waiting for this Lead's dispatch in project lib`))
      expect(host.agents.has(`worker-${ticket.id}`)).toBe(false)
    } finally { await host.stop() }
  })

  it('refuses to start an Assignment on a Ticket that already ended', async () => {
    const host = await startRuntime()
    try {
      const { ticket } = await host.acceptedTicket(feishu('6', '@bot 修六'), 'change', { assign: false })
      const assignment = ticket.assignments[0]!
      host.runtime.engine.stopTicket(ticket.id)
      await expect(host.runTool('lead-default', 'lead_assign', { assignment_id: assignment.id }))
        .rejects.toThrow(/has ended/)
      expect(host.agents.has(`worker-${ticket.id}`)).toBe(false)
    } finally { await host.stop() }
  })
  it('reads its own project\'s pages and refuses another project\'s, and never the installation lists', async () => {
    const host = await startRuntime()
    try {
      const { ticket } = await host.acceptedTicket(feishu('7', '@bot 修七'), 'answer')
      const page = await host.runTool('lead-default', 'orchestrator_read', { resource: `ticket/${ticket.id}` }) as { ticket_id: string }
      expect(page.ticket_id).toBe(ticket.id)
      await expect(host.runTool('lead-default', 'orchestrator_read', { resource: 'tickets' }))
        .rejects.toThrow(/Unknown context resource/)
      const settings = host.runtime.store.settings()
      host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, projects: [...settings.executor.projects,
        { id: 'lib', name: 'Lib', workspace: join(host.directory, 'lib'), repository: 'acme/lib', branch: '' }] } })
      mkdirSync(join(host.directory, 'lib'), { recursive: true })
      await host.runtime.sessions.ensureLead('lib', join(host.directory, 'lib'), 'Project Lib')
      await expect(host.runTool('lead-lib', 'orchestrator_read', { resource: `ticket/${ticket.id}` }))
        .rejects.toThrow(/inaccessible/)
      // The boundary is operational, not a sandbox: a refused read is still recorded where an operator can find it (#37).
      const refused = host.runtime.store.boundary.list({ outcome: 'refused' })
      expect(refused.find(entry => entry.resource === `ticket/${ticket.id}`)).toMatchObject({ role: 'lead', outcome: 'refused', project: 'lib' })
    } finally { await host.stop() }
  })
})

