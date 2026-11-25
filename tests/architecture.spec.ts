/** The layering check (`scripts/check-architecture.mjs`) against synthetic source trees. */
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain Node script without a declaration file
import { violations } from '../scripts/check-architecture.mjs'

const check = (file: string, text: string) => violations(new Map([[file, text]]))

describe('architecture', () => {
  it('allows the intended import direction', () => {
    expect(check('src/core/engine.ts', "import { key } from './model.ts'\nimport { format } from '../infra/text.ts'")).toEqual([])
    expect(check('src/client/text.ts', "import type { Localized } from '../sources/kind.ts'\nimport type { Api } from '../app/api.ts'")).toEqual([])
    expect(check('src/client/locales.ts', "import { HEALTH_TEXT } from '../sources/host.ts'")).toEqual([])
    expect(check('src/app/runtime.ts', "import { Engine } from '../core/index.ts'")).toEqual([])
  })
  it('reports a core module importing a layer above it', () => {
    expect(check('src/core/engine.ts', "import { Store } from '../app/store.ts'")).toEqual([
      { file: 'src/core/engine.ts', line: 1, imported: '../app/store.ts', rule: 'core imports the layer above it' },
    ])
  })
  it('reports the client importing a server module or a Node built-in', () => {
    expect(check('src/client/ticket.tsx', "import { Store } from '../app/store.ts'").map((item: { rule: string }) => item.rule))
      .toEqual(['the client imports a server module other than the HTTP contract'])
    expect(check('src/client/ticket.tsx', "import { readFileSync } from 'node:fs'").map((item: { rule: string }) => item.rule))
      .toEqual(['the client imports a Node built-in'])
  })
  it('reports src importing development tooling', () => {
    expect(check('src/app/runtime.ts', "import { boot } from '../tests/fixtures/host.ts'").map((item: { rule: string }) => item.rule))
      .toEqual(['src imports development tooling'])
  })
  it('reports a bare instanceof CliError outside its own module', () => {
    expect(check('src/sources/github.ts', 'if (!(error instanceof CliError)) throw error')).toEqual([
      { file: 'src/sources/github.ts', line: 1, imported: 'CliError', rule: 'instanceof CliError is bundle-local; classify CLI failures with isCliError' },
    ])
    expect(check('src/infra/commands.ts', 'return error instanceof CliError')).toEqual([])
  })
  it('reports model-facing text cut at a call site instead of through the projection policy', () => {
    expect(check('src/app/notices.ts', 'const text = summary.slice(0, 600)').map((item: { rule: string }) => item.rule))
      .toEqual(['model-facing text is bounded by a docs/context-policy.md field, not a call-site slice'])
    expect(check('src/app/assessment.ts', 'const TRIGGER_CHARS = 4000').map((item: { rule: string }) => item.rule))
      .toEqual(['model-facing text is bounded by a docs/context-policy.md field, not a truncation constant'])
    // The policy table itself keeps the widths; the two internal texts are exempt with their reason.
    expect(check('src/app/projection.ts', 'const text = summary.slice(0, 600)')).toEqual([])
    expect(check('src/app/outbox.ts', 'const detail = error.slice(0, 160)')).toEqual([])
  })
})
