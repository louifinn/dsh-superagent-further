import { describe, expect, it } from 'vitest'
import { defaultPrompts } from '../src/app/prompts.ts'
import { composeSkill } from '../src/app/prompts.ts'
import { OPERATIONAL_SKILLS, bundledSkills } from '../src/app/skill-files.ts'

describe('the operational skills bundled with the plugin', () => {
  it('loads each one with a frontmatter description and instructions', () => {
    for (const name of OPERATIONAL_SKILLS) {
      const { name: loaded, description, content } = bundledSkills[name]
      expect(loaded).toBe('dsh-superagent-further-' + name)
      expect(description.length).toBeGreaterThan(20)
      expect(content.length).toBeGreaterThan(200)
    }
  })
  it('composes them from the bundle, never from an editable custom skill', () => {
    const config = defaultPrompts()
    for (const name of OPERATIONAL_SKILLS) {
      expect(composeSkill({ ...config, skills: { ...config.skills, [name]: 'team text wins' } }, name)).toBe(bundledSkills[name].content)
    }
    expect(composeSkill({ ...config, skills: { custom: 'Use the github section.' } }, 'custom')).toBe('Use the github section.')
  })
})
