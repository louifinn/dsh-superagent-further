import { describe, expect, it, vi } from 'vitest'
import { LeadDispatch } from '../src/app/lead-dispatch.ts'
import { startRuntime } from './fixtures/host.ts'

describe('startup readiness', () => {
  it('reports ready before a slow Lead prompt reconciliation finishes', async () => {
    // A real state directory can hold hundreds of unanswered prompts; restoring them is durable and idempotent but must
    // never sit on the supervisor's 30-second readiness path (issue #43).
    const pending = new Promise<void>(() => {})
    const reconcile = vi.spyOn(LeadDispatch.prototype, 'reconcile').mockReturnValue(pending)
    const host = await startRuntime()
    try {
      expect(host.runtime.health.runtime).toMatchObject({ state: 'ready' })
    } finally {
      reconcile.mockRestore()
      await host.stop()
    }
  })
})
