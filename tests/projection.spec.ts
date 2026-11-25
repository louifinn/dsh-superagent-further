/**
 * The projection policy (docs/015 D2): one pure function bounds every model-facing field, so the four invariants hold
 * without a model call. These tests exercise the table itself and the function over generated text, not one call site.
 */
import { describe, expect, it } from 'vitest'
import {
  FIELD_KEYS, PROJECTION_POLICIES, PROJECTION_POLICY, PROJECTION_STYLES, field, project,
  type FieldKey,
} from '../src/app/projection.ts'

/** Deterministic generator, so a failure is reproducible from its seed. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}
const sample = (random: () => number, length: number) =>
  Array.from({ length }, () => 'abcdefgh ijklmnop 你好\n'[Math.floor(random() * 25)]).join('')

describe('projection policy', () => {
  it('covers every field exactly once and gives each policy a width it respects', () => {
    expect(Object.keys(PROJECTION_POLICY).sort()).toEqual([...FIELD_KEYS].sort())
    for (const key of FIELD_KEYS) {
      const rule = PROJECTION_POLICY[key]
      expect(PROJECTION_POLICIES).toContain(rule.policy)
      if (rule.style !== undefined) expect(PROJECTION_STYLES).toContain(rule.style)
      if (rule.policy === 'inline' || rule.policy === 'pointer') continue
      // A bounded field needs an inline width and a display style; the policy is what the reason documents.
      expect(rule.width).toBeGreaterThan(0)
      expect(rule.style).toBeDefined()
      expect(rule.reason).toBeTruthy()
    }
    const unbounded = FIELD_KEYS.filter(key => PROJECTION_POLICY[key].policy === 'pointer')
    expect(unbounded).toEqual(['worker.prompt'])
  })

  it('is deterministic and never widens the inline text past its policy width', () => {
    const random = mulberry32(7)
    for (const key of FIELD_KEYS) {
      const rule = PROJECTION_POLICY[key]
      for (const length of [0, 1, 40, 50, 80, 100, 160, 200, 400, 600, 1200, 1500, 4000, 5000]) {
        const text = sample(random, length) || 'x'
        const once = project(field(key, rule.resource === undefined ? undefined : { resource: rule.resource, id: '42' }), text)
        const twice = project(field(key, rule.resource === undefined ? undefined : { resource: rule.resource, id: '42' }), text)
        expect(once).toEqual(twice)
        if (rule.policy === 'pointer') expect(once.inline).toBe('')
        if (rule.policy !== 'pointer' && rule.width !== undefined && text.length <= rule.width) {
          // A collapse field normalizes whitespace even when the text fits, as the preview it replaced did.
          expect(once.inline).toBe(rule.style === 'collapse' ? text.replace(/\s+/g, ' ') : text)
        }
        if (rule.policy !== 'pointer' && rule.width !== undefined) {
          const bound = rule.style === 'ellipsis' ? rule.width + 1 : rule.width
          expect([...once.inline].length).toBeLessThanOrEqual(bound)
        }
      }
    }
  })

  it('keeps the original length of a cut text and follows it to the resource when the policy is followable', () => {
    const random = mulberry32(11)
    for (const key of FIELD_KEYS) {
      const rule = PROJECTION_POLICY[key]
      if (rule.width === undefined) continue
      const text = sample(random, rule.width + 37)
      const target = field(key, rule.resource === undefined ? undefined : { resource: rule.resource, id: '7' })
      const projection = project(target, text)
      if (text.length <= rule.width) continue
      expect(projection.chars).toBe(text.length)
      expect(projection.inline).not.toBe(text)
      if (rule.resource === undefined) expect(projection.read).toBeUndefined()
      else expect(projection.read).toBe(`${rule.resource}/7`)
    }
  })

  it('collapses a one-line preview without inventing a read pointer it was not given', () => {
    const key = 'card.trigger'
    const rule = PROJECTION_POLICY[key]
    const text = `${'a '.repeat(200)}\nsecond line`
    expect(project(field(key), text)).toMatchObject({ chars: text.length })
    expect(project(field(key), text).inline).not.toContain('\n')
    expect(project(field(key), text).read).toBeUndefined()
    expect(project(field(key, { resource: 'trigger', id: 't-1' }), text).read).toBe('trigger/t-1')
    expect(rule.style).toBe('collapse')
  })

  it('names the pointer field without inlining its prompt', () => {
    const projection = project(field('worker.prompt', { resource: 'ticket', id: 't-1' }), 'a long assignment prompt')
    expect(projection).toEqual({ inline: '', chars: 'a long assignment prompt'.length, read: 'ticket/t-1' })
  })
})

// The table is typed over FieldKey, so this keeps a future field from being added to one side only at compile time.
export type ProjectedKeys = readonly FieldKey[]
