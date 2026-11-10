/**
 * Mounted-surface contract: the tools, skills, presets and bundle rows a running dsh-superagent-further installs.
 *
 * The tool and skill sets are read from real Sessions mounted on the in-memory DSH host (the same fixture runtime.spec.ts
 * uses), never from a plan; the preset and bundle rows are read from the bundle patch that DSH composes. `scripts/check-pack.mjs`
 * separately proves those files reach the published tarball, and the macOS smoke boots the real host once.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkills } from '../src/app/skill-files.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as
  { dsh: { bundle: { patch: string }; client: { inject: string[] } }; files: string[] }

const listings = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map(match => match[1] as string)

describe('mounted surface', () => {
  let host: Host | undefined
  afterEach(async () => { await host?.stop(); host = undefined })

  it('registers exactly the tools each role documents', async () => {
    host = await startRuntime()
    const settings = host.runtime.store.settings()
    const workspace = join(host.directory, 'app')
    host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
      projects: [...settings.executor.projects, { id: 'app', name: 'App', workspace, repository: 'acme/app', branch: 'main' }] } })
    await host.runtime.sessions.ensureLead('app', workspace, 'Project App')
    const { ticket } = await host.acceptedTicket(feishu('1', 'Please review the tiny change.'), 'answer')

    const main = [...host.tools.get(host.runtime.masterId)!.keys()].sort()
    const lead = [...host.tools.get('lead-app')!.keys()].sort()
    const worker = [...host.tools.get(`worker-${ticket.id}`)!.keys()].sort()
    expect({ main, lead, worker }).toEqual({
      // The main Session: routing and evaluation, communication, configuration, memory, and the raise/escalation channels.
      main: ['memory_forget', 'memory_search', 'memory_write', 'orchestrator_escalation_decide', 'orchestrator_escalations',
        'orchestrator_eval', 'orchestrator_eval_decide', 'orchestrator_eval_read', 'orchestrator_label', 'orchestrator_policy_sync',
        'orchestrator_prompts_save', 'orchestrator_read', 'orchestrator_reply', 'orchestrator_request_create', 'orchestrator_route',
        'orchestrator_send_file', 'orchestrator_settings_propose', 'orchestrator_settings_save', 'orchestrator_thread_unsubscribe',
        'orchestrator_ticket_note', 'orchestrator_ticket_request_status', 'orchestrator_ticket_retry', 'orchestrator_trigger_requeue'],
      // A project Lead: its project's requests and messages, plus the memories scoped to its project.
      lead: ['lead_notify_worker', 'lead_request_approval', 'lead_request_approve', 'lead_request_complete', 'lead_request_create', 'lead_request_decide',
        'lead_request_escalate', 'lead_request_reply', 'lead_requests', 'lead_review', 'lead_review_record', 'lead_status', 'memory_forget',
        'memory_search', 'memory_write'],
      // An Executor Session: report, read what reached it, follow or detach Threads, and hand a Trigger back.
      worker: ['orchestrator_ack', 'orchestrator_read', 'orchestrator_report', 'orchestrator_thread_follow', 'orchestrator_thread_unrelated',
        'orchestrator_trigger_handback', 'request_create'],
    })
  })

  it('bundles the five skills the package ships', () => {
    expect(Object.keys(bundledSkills).sort()).toEqual(['feishu', 'github', 'project-request', 'release', 'triage'])
  })

  it('ships one bundle layer, four presets and the client injection its manifest names', () => {
    expect(packageJson.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(packageJson.files).toEqual(expect.arrayContaining(['lib', 'cordis.patch.yml', 'locale/*.json', 'prompts', 'skills']))
    expect(packageJson.dsh.client.inject.length).toBe(6)
    expect(listings(patch, /^\s+- id: (dsh-superagent-further(?:-[\w-]+)?)$/gm)).toEqual([
      'dsh-superagent-further',
      'dsh-superagent-further-github',
      'dsh-superagent-further-feishu',
      'dsh-superagent-further-worker-preset',
      'dsh-superagent-further-router-preset',
      'dsh-superagent-further-lead-preset',
      'dsh-superagent-further-reviewer-preset',
    ])
    expect(listings(patch, /^\s+id: (dsh-superagent-further-(?:worker|router|lead|reviewer))$/gm)).toEqual([
      'dsh-superagent-further-worker',
      'dsh-superagent-further-router',
      'dsh-superagent-further-lead',
      'dsh-superagent-further-reviewer',
    ])
    expect(patch).toContain('name: dsh-superagent-further/github-watch')
    expect(patch).toContain('name: dsh-superagent-further/feishu-watch')
    expect(patch).toContain('disabled: true')
  })
})
