import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { apply as applyFeishu } from '../src/sources/feishu.ts'
import { apply as applyGithub } from '../src/sources/github.ts'
import { SOURCES_STOP_EVENT } from '../src/sources/stop.ts'

const probe: SourceKind<{ interval: number }> = {
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  fields: [{ key: 'interval', type: 'number', min: 1, max: 60, label: { zh: '间隔', en: 'Interval' } }],
}

/**
 * The 2026-11-12 host crash (crash-2026-11-12T00-27-44-715Z-host.log): an update drain closed the store while the
 * Feishu watch plugin's five-second check still asked the registry for a configuration, `store.settings()` threw
 * `database is not open` inside a timer callback, and DSH treated that uncaught exception as fatal. Every way a Source
 * asks the registry for state must answer "nothing" once the runtime is closing, never touch the closed store.
 */
describe('Source registry while the runtime closes', () => {
  const closing = () => {
    let closed = false
    const sources = new SourceRegistry(() => {
      if (closed) throw new Error('database is not open')
      return SettingsSchema.parse({ sources: { probe: { enabled: true, config: { interval: 7 } } } })
    }, new HealthBoard(), () => () => {}, () => closed)
    sources.register(probe)
    return { sources, close: () => { closed = true } }
  }

  it('answers no instance instead of reading a closed store, so a watcher tick sees the Source as off', () => {
    const { sources, close } = closing()
    expect(sources.instance('probe')?.config).toEqual({ interval: 7 })
    close()
    expect(() => sources.instance('probe')).not.toThrow()
    expect(sources.instance('probe')).toBeUndefined()
  })

  it('lists no instances, no environments and no channel once the runtime closes', () => {
    const { sources, close } = closing()
    close()
    expect(() => sources.instances()).not.toThrow()
    expect(sources.instances()).toEqual([])
    expect(sources.environments()).toEqual([])
    expect(sources.channelAllowed({ source: 'probe', address: {} })).toBe(false)
    expect(sources.scope({ source: 'probe', meta: {} })).toEqual({ listened: false, reason: 'source_disabled' })
    expect(sources.policyPart('probe')).toBeUndefined()
    expect(sources.threadContext({ id: 'x' } as never)).toBeUndefined()
  })

  it('keeps declarations readable, because they do not depend on stored settings', () => {
    const { sources, close } = closing()
    close()
    expect(() => sources.declarations()).not.toThrow()
  })
})

/**
 * The 2026-11-12 post-mortem (issue #42): the drain that closed the Store was started by the supervisor, which has no
 * handle on the sibling Source plugin entries. It therefore asks them to stop through one broadcast, and both Source
 * plugins must listen and abort the loops they own before the Store closes.
 */
describe('Source plugins stop on the supervisor\'s broadcast', () => {
  /** A context that records listeners and effects without running either, so no polling loop starts in this test. */
  function recorder(): { listeners: (() => void)[]; ctx: unknown } {
    const listeners: (() => void)[] = []
    const ctx = {
      effect: () => () => {},
      on: (name: string, listener: () => void) => { if (name === SOURCES_STOP_EVENT) listeners.push(listener); return () => {} },
    }
    return { listeners, ctx }
  }

  it('registers one stop listener per Source plugin, and firing it is safe before any loop owns a controller', () => {
    const feishu = recorder()
    const github = recorder()
    applyFeishu(feishu.ctx as never)
    applyGithub(github.ctx as never)
    expect(feishu.listeners).toHaveLength(1)
    expect(github.listeners).toHaveLength(1)
    for (const listener of [...feishu.listeners, ...github.listeners]) expect(() => listener()).not.toThrow()
  })
})

