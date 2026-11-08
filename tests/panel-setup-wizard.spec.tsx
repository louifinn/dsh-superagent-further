// @vitest-environment jsdom
// The first-run setup wizard.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, click, text, field, type } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const wizardButton = (name: string) => find(name, '.dt-wizard button')
const dialog = () => document.querySelector('[role="dialog"]')

it('opens by itself on a first run, once per browser session', async () => {
  server.wizard = { firstRun: true, skipped: false }
  await mount()
  expect(dialog()?.getAttribute('aria-label')).toBe(zh.wizardTitle)
  expect(text()).toContain(zh.wizardWelcome)
  // Closing leaves the server's first-run state alone, but this browser session does not reopen the wizard.
  await click(wizardButton(zh.close))
  expect(all('[role="dialog"]')).toHaveLength(0)
  await remount()
  expect(all('[role="dialog"]')).toHaveLength(0)
})

it('keeps a header entry that reopens the wizard after it was skipped', async () => {
  server.wizard = { firstRun: false, skipped: true }
  await mount()
  expect(all('[role="dialog"]')).toHaveLength(0)
  await click(find(zh.wizardOpen))
  expect(dialog()?.getAttribute('aria-label')).toBe(zh.wizardTitle)
  expect(text()).toContain(zh.wizardWelcome)
})

it('records a skip on the server, so a later load does not open the wizard again', async () => {
  server.wizard = { firstRun: true, skipped: false }
  await mount()
  await click(wizardButton(zh.wizardSkipAll))
  expect(server.wizard).toEqual({ firstRun: false, skipped: true })
  expect(server.requests).toContainEqual({ path: 'wizard', method: 'PUT', body: { skipped: true } })
  expect(all('[role="dialog"]')).toHaveLength(0)
  await remount()
  expect(all('[role="dialog"]')).toHaveLength(0)
  // The header entry still opens the wizard after the skip.
  await click(find(zh.wizardOpen))
  expect(all('[role="dialog"]')).toHaveLength(1)
})

it('registers the first project and continues to the account step', async () => {
  server.wizard = { firstRun: true, skipped: false }
  await mount()
  await click(wizardButton(zh.wizardStart))
  expect(text()).toContain(zh.wizardProjectIntro)
  await type(field<HTMLInputElement>(zh.projectId), 'app')
  await type(field<HTMLInputElement>(zh.projectName), 'App')
  await type(field<HTMLInputElement>(zh.projectWorkspace), '/srv/app')
  await type(field<HTMLInputElement>(zh.projectRepository), 'acme/app')
  await type(field<HTMLInputElement>(zh.projectBranch), 'main')
  await click(wizardButton(zh.wizardSave))
  expect(server.settings.executor.projects).toEqual([{ id: 'app', name: 'App', workspace: '/srv/app', repository: 'acme/app',
    branch: 'main' }])
  expect(server.revisions.executor).toBe(1)
  expect(text()).toContain(zh.wizardAccountIntro)
})

it('moves back and forward, and skips steps without saving them', async () => {
  server.wizard = { firstRun: true, skipped: false }
  await mount()
  await click(wizardButton(zh.wizardStart))
  await click(wizardButton(zh.wizardSkipStep))
  expect(text()).toContain(zh.wizardAccountIntro)
  await click(wizardButton(zh.wizardBack))
  expect(text()).toContain(zh.wizardProjectIntro)
  await click(wizardButton(zh.wizardSkipStep))
  await click(wizardButton(zh.wizardSkipStep))
  expect(text()).toContain(zh.wizardFeishuIntro)
  expect(server.settings.executor.projects).toEqual([])
})

it('turns the Feishu source off from its step', async () => {
  server.wizard = { firstRun: true, skipped: false }
  await mount()
  await click(wizardButton(zh.wizardStart))
  await click(wizardButton(zh.wizardSkipStep))
  await click(wizardButton(zh.wizardSkipStep))
  expect(text()).toContain(zh.wizardFeishuIntro)
  await click(wizardButton(zh.wizardFeishuEnable))
  await click(wizardButton(zh.wizardSave))
  expect(server.settings.sources.feishu?.enabled).toBe(false)
  expect(server.revisions['source:feishu']).toBe(1)
  expect(text()).toContain(zh.wizardLanguageIntro)
})

it('saves the default language and finishes the wizard', async () => {
  server.wizard = { firstRun: true, skipped: false }
  await mount()
  await click(wizardButton(zh.wizardStart))
  for (let index = 0; index < 3; index++) await click(wizardButton(zh.wizardSkipStep))
  expect(text()).toContain(zh.wizardLanguageIntro)
  await type(field<HTMLInputElement>(zh.languageDefaultLabel), 'English (US)')
  await click(wizardButton(zh.wizardSave))
  expect(server.settings.language.default).toBe('English (US)')
  expect(text()).toContain(zh.wizardDoneIntro)
  await click(wizardButton(zh.wizardFinish))
  expect(server.wizard).toEqual({ firstRun: false, skipped: false })
  expect(server.requests).toContainEqual({ path: 'wizard', method: 'PUT', body: { skipped: false } })
  expect(all('[role="dialog"]')).toHaveLength(0)
})
