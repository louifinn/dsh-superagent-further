import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localFile } from '../src/app/files.ts'

describe('workspace file resolution for delivery', () => {
  let root = ''
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'decisions.md'), '# Decision\n')
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('resolves a relative file inside the workspace and names its directory and file', async () => {
    const file = await localFile(root, 'docs/decisions.md')
    expect(file).toMatchObject({ directory: join(root, 'docs'), name: 'decisions.md' })
    expect(file.size).toBeGreaterThan(0)
    expect(file.mtimeMs).toBeGreaterThan(0)
  })

  it('accepts backslash-separated paths', async () => {
    const file = await localFile(root, 'docs\\decisions.md')
    expect(file.name).toBe('decisions.md')
  })

  it('refuses absolute paths, traversal, empty segments and directories', async () => {
    for (const path of ['', join(root, 'docs', 'decisions.md'), '../decisions.md', 'docs/../decisions.md',
      'docs/./decisions.md', 'docs//decisions.md', 'docs']) {
      await expect(localFile(root, path), path).rejects.toThrow()
    }
  })

  it('refuses a missing file', async () => {
    await expect(localFile(root, 'docs/missing.md')).rejects.toThrow('No such file')
  })
})
