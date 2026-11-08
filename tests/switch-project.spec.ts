import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/switch-project', import.meta.url))
const temporary: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-switch-'))
  temporary.push(root)
  return root
}

/** Writes a profile that installs dsh-superagent-further, with a patch naming the port and state directory. */
function profile(home: string, name: string, port?: number): void {
  const directory = join(home, 'profiles', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh-base': 'link:base', 'dsh-superagent-further': 'link:F:/src/dsh-superagent-further' },
  }, null, 2))
  writeFileSync(join(directory, 'cordis.patch.yml'), [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    ...port === undefined ? [] : [`    port: ${port}`],
    '- id: dsh-superagent-further',
    '  config:',
    `    stateDir: C:/Users/me/.dsh/state/${name}`,
  ].join('\n'))
}

/** Writes the control file the service script leaves for a running host. */
function hostedAt(artifacts: string, name: string, pid = process.pid): void {
  const directory = join(artifacts, 'control', 'profiles', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'service.pid'), `${pid}\n`)
}

/** A fake service script that records its calls and answers with a chosen status. */
function fakeService(root: string): { path: string; calls: string; startStatus: number } {
  const path = join(root, 'fake-service.mjs')
  const calls = join(root, 'calls.jsonl')
  writeFileSync(path, [
    "import { appendFileSync } from 'node:fs'",
    "const [command, ...rest] = process.argv.slice(2)",
    "appendFileSync(process.env.DSH_SWITCH_CALLS, JSON.stringify([command, ...rest]) + '\\n')",
    "process.exit(command === 'start' ? Number(process.env.DSH_SWITCH_START_STATUS ?? 0) : 0)",
  ].join('\n'))
  return { path, calls, startStatus: 0 }
}

interface Ran { status: number | null; stdout: string; stderr: string }

function run(root: string, fake: ReturnType<typeof fakeService>, artifacts: string, args: string[], extra: Record<string, string> = {}): Ran {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: root,
      DSH_SWITCH_SERVICE: fake.path,
      DSH_SWITCH_ARTIFACTS: artifacts,
      DSH_SWITCH_CALLS: fake.calls,
      ...extra,
    },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function calls(path: string): string[][] {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) } catch { return [] }
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('switch-project', () => {
  it('stops the other hosted project and starts the one asked for, printing its panel URL', () => {
    const root = workspace()
    const artifacts = join(root, '.artifacts')
    profile(root, 'alpha', 3082)
    profile(root, 'beta', 3083)
    hostedAt(artifacts, 'alpha')
    writeFileSync(join(artifacts, 'dsh-superagent-further-beta-20261107-090000-1.log'),
      'dsh web: http://127.0.0.1:3083/?token=panel-token\n')
    const fake = fakeService(root)
    const result = run(root, fake, artifacts, ['beta', '--json'])
    expect(result.status).toBe(0)
    expect(calls(fake.calls)).toEqual([
      ['stop', '--profile', 'alpha', '--url', 'http://127.0.0.1:3082'],
      ['start', '--profile', 'beta', '--url', 'http://127.0.0.1:3083'],
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      project: 'beta', url: 'http://127.0.0.1:3083', stopped: ['alpha'],
      panel: 'http://127.0.0.1:3083/?token=panel-token', status: 0,
    })
  })

  it('treats a host that waits for setup as started, and says so in plain text', () => {
    const root = workspace()
    const artifacts = join(root, '.artifacts')
    profile(root, 'beta', 3083)
    const fake = fakeService(root)
    const result = run(root, fake, artifacts, ['beta'], { DSH_SWITCH_START_STATUS: '3' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No other project was running.')
    expect(result.stdout).toContain('Started beta at http://127.0.0.1:3083 (waiting for setup).')
    expect(result.stdout).toContain('One project runs at a time')
  })

  it('refuses an unknown project and names the profiles it knows', () => {
    const root = workspace()
    const fake = fakeService(root)
    const result = run(root, fake, join(root, '.artifacts'), ['gamma'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('No project profile "gamma" installs dsh-superagent-further. Known projects: ')
    expect(calls(fake.calls)).toEqual([])
  })

  it('refuses a project whose panel port is unknown, before stopping anything', () => {
    const root = workspace()
    const artifacts = join(root, '.artifacts')
    profile(root, 'alpha', 3082)
    profile(root, 'beta')
    hostedAt(artifacts, 'alpha')
    const fake = fakeService(root)
    const result = run(root, fake, artifacts, ['beta'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sets no webserver port')
    expect(calls(fake.calls)).toEqual([])
  })

  it('refuses to stop a hosted project whose port is unknown, and says how to stop it by hand', () => {
    const root = workspace()
    const artifacts = join(root, '.artifacts')
    profile(root, 'alpha', 3082)
    profile(root, 'beta')
    hostedAt(artifacts, 'beta')
    const fake = fakeService(root)
    const result = run(root, fake, artifacts, ['alpha'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('beta is hosted (PID')
    expect(result.stderr).toContain('node scripts/dsh-superagent-further stop --profile beta')
    expect(calls(fake.calls)).toEqual([])
  })

  it('prints usage for --help and refuses an unknown argument', () => {
    const root = workspace()
    const fake = fakeService(root)
    const help = run(root, fake, join(root, '.artifacts'), ['--help'])
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('Usage: node scripts/switch-project <profile>')
    const unknown = run(root, fake, join(root, '.artifacts'), ['beta', '--nope'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('Unknown argument: --nope')
  })
})
