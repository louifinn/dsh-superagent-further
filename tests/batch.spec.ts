import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { batchArguments, expandsInBatch, invocation, isBatchFile } from '../src/infra/batch.ts'

const windows = process.platform === 'win32'
const directories: string[] = []
const temporary = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-batch-'))
  directories.push(directory)
  return directory
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('runs a native program directly and a batch file through cmd.exe', () => {
  expect(invocation(process.execPath, ['-e', '1'])).toEqual({ program: process.execPath, args: ['-e', '1'], verbatim: false })
  // Node cannot start a `.cmd` file with an argument array at all, so it must go through `cmd.exe`; only Windows has batch files.
  expect(isBatchFile('C:\\tools\\gh.cmd')).toBe(windows)
  expect(isBatchFile('gh.exe')).toBe(false)
  expect(invocation('C:\\tools\\gh.cmd', ['a b'])).toEqual(windows
    ? { program: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\tools\\gh.cmd" "a b""'], verbatim: true }
    : { program: 'C:\\tools\\gh.cmd', args: ['a b'], verbatim: false })
})

it('knows which arguments cmd.exe would rewrite instead of passing through', () => {
  expect(expandsInBatch(['%PATH%'])).toBe(true)
  expect(expandsInBatch(['a\nb'])).toBe(true)
  // A lone `%` that does not start a variable name survives a command line.
  expect(expandsInBatch(['100%', 'p%q', '{"x": 1}'])).toBe(false)
  expect(batchArguments('fake.cmd', ['a b', 'e"f'])).toEqual(['/d', '/s', '/c', '""fake.cmd" "a b" "e\\"f""'])
})

it.skipIf(!windows)('keeps every argument intact through the invocation it builds', () => {
  const directory = temporary()
  const echo = join(directory, 'echo.cjs')
  writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const fake = join(directory, 'fake.cmd')
  writeFileSync(fake, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`)
  const run = (args: string[]) => {
    const { program, args: argv, verbatim } = invocation(fake, args)
    return spawnSync(program, argv, { windowsVerbatimArguments: verbatim, encoding: 'utf8' })
  }
  const args = ['a b', 'c&d', 'e"f', ';', '=', '{"x": 1}', '中文', '']
  const result = run(args)
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout.trim())).toEqual(args)
})
