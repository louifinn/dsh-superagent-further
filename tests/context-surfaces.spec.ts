/**
 * The production surface inventory (issue #6, docs/015 D1): the pure collector reads a role's own registration, and the
 * declared role set names the Lead/reviewer gap instead of omitting it.
 */
import { describe, expect, it } from 'vitest'
import { COLLECTED_ROLES, RESOURCE_GRAMMAR, ROLE_IDS, UNCOLLECTED_ROLES, collectSurfaces, uncollectedRoles, type RoleRegistration } from '../src/app/surfaces.ts'
import { RESOURCES } from '../src/app/resources.ts'

const registration = (role: RoleRegistration['role']): RoleRegistration => ({
  role,
  parts: [{ name: 'runtime/shared', text: 'shared rules' }, { name: 'runtime/orchestrator', text: 'orchestrator rules' }],
  generated: 'revision 3',
  tools: [{ name: `${role}_tool`, description: 'does the thing', parameters: { type: 'object' } }],
  skills: [{ name: 'skill-a', description: 'a skill', content: 'body' }],
})

describe('context surface inventory', () => {
  it('collects one entry per prompt part, generated part, tool description and skill', () => {
    const surfaces = collectSurfaces([registration('orchestrator'), registration('worker')])
    expect(surfaces.map(({ role, where }) => `${role} ${where}`)).toEqual([
      'orchestrator orchestrator prompt runtime/shared',
      'orchestrator orchestrator prompt runtime/orchestrator',
      'orchestrator orchestrator prompt from the runtime',
      'orchestrator orchestrator tool orchestrator_tool',
      'orchestrator skill skill-a',
      'worker worker prompt runtime/shared',
      'worker worker prompt runtime/orchestrator',
      'worker worker prompt from the runtime',
      'worker worker tool worker_tool',
      'worker skill skill-a',
    ])
    expect(surfaces.find(surface => surface.where === 'skill skill-a')!.text).toBe('a skill\nbody')
  })

  it('strings an empty generated part out of the inventory', () => {
    expect(collectSurfaces([{ ...registration('worker'), generated: '' }]).some(surface => surface.where.endsWith('from the runtime'))).toBe(false)
  })

  it('declares the roles the runtime registers, and the Lead/reviewer gap between them', () => {
    expect([...COLLECTED_ROLES]).toEqual(['orchestrator', 'worker'])
    expect([...UNCOLLECTED_ROLES]).toEqual(['lead', 'reviewer'])
    expect(uncollectedRoles(COLLECTED_ROLES)).toEqual(['lead', 'reviewer'])
    expect(uncollectedRoles(ROLE_IDS)).toEqual([])
    expect(uncollectedRoles(['orchestrator', 'worker', 'lead', 'reviewer', 'lead'])).toEqual([])
  })

  it('mirrors the resource grammar the model reads, with Executor-only visibility explicit', () => {
    expect(RESOURCE_GRAMMAR).toEqual(RESOURCES.map(({ name, holds, executor }) => ({ name, holds, executor: executor === true })))
  })
})
