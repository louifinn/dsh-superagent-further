/**
 * Tests for scripts/dsh-superagent-further.
 *
 * The service manager is dependency-free Node ESM and derives its checkout root from its own location. These tests copy
 * it into a temporary checkout whose path contains spaces (so path handling is exercised), and inject its two test
 * seams: `DSH_SUPERAGENT_PROCESS_TABLE` (a JSON fake process table instead of `ps`/CIM) and `DSH_SUPERAGENT_LAUNCH`
 * (a Node fake launcher instead of `dsh`). The management API is a `node:http` server started by each test. No fake
 * `ps`, `tmux`, `dsh` or shell scripts are involved, so the suite runs on POSIX and Windows.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

/** Node fake launcher written into the temporary checkout: records its arguments and behaves like a live service. */
const FAKE_LAUNCHER = `import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : ''
writeFileSync(process.env.DSH_TEST_LAUNCH_RECORD, JSON.stringify({ argv: args, cwd: process.cwd(), pid: process.pid }))
appendFileSync(process.env.DSH_TEST_LAUNCHER_PIDS, process.pid + '\\n')
writeFileSync(process.env.DSH_SUPERAGENT_PROCESS_TABLE, JSON.stringify([
  { pid: process.pid, name: 'node', args: ['node', '/opt/my tools/dsh/lib/cli.js', '--profile', profile, '--no-open'] },
]))
process.stdout.write('fake launcher stdout\\n')
process.stderr.write('fake launcher stderr\\n')
setInterval(() => {}, 1000)
`

interface ProcessEntry { pid: number; name?: string; args?: string[] }
interface Result { code: number; stdout: string; stderr: string; killed: boolean }
interface Mock {
  url: string
  requests: string[]
}
interface MockOptions {
  state?: unknown
  /** Answer the state route with 503 until a launcher has started, like a service that is still booting. */
  gated?: boolean
  /** What POST /orchestrator/api/shutdown does: omit the route (404), acknowledge only, or run a callback first. */
  shutdown?: 'absent' | 'ignore' | (() => void)
}

const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
let root: string
let servers: Server[] = []
let children: ChildProcess[] = []

const tablePath = () => join(root, 'processes.json')
const launchRecord = () => join(root, 'launch.json')
const launcherPids = () => join(root, 'launcher-pids.txt')
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)

/** Spawn a real Node process whose PID can appear in the fake process table; ignoreInterrupt is no longer needed. */
function sleeper(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  return child.pid!
}

const service = (pid: number, profile = 'superagent'): ProcessEntry => ({
  pid, name: 'node', args: ['node', '/opt/my tools/dsh/lib/cli.js', '--profile', profile, '--no-open'],
})

/** Replace the injected process table. Entries whose PIDs have exited are ignored by the script, like a real scan. */
function processes(...entries: ProcessEntry[]): void {
  writeFileSync(tablePath(), JSON.stringify(entries))
}

function tableEntries(): ProcessEntry[] {
  return JSON.parse(readFileSync(tablePath(), 'utf8')) as ProcessEntry[]
}

/** Start a mock management API; returns its URL and the requests it saw as `METHOD path x-orchestrator-request`. */
async function answering(options: MockOptions = {}): Promise<Mock> {
  const requests: string[] = []
  // A service that acknowledged a graceful shutdown stops answering until a launcher starts it again.
  let stopped = false
  const up = () => existsSync(launchRecord())
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]!
    requests.push(`${request.method} ${path} ${String(request.headers['x-orchestrator-request'])}`)
    if (request.method === 'POST' && path === '/orchestrator/api/shutdown') {
      if (options.shutdown === 'absent') { response.writeHead(404).end(); return }
      if (typeof options.shutdown === 'function') options.shutdown()
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stopping: true }))
      if (typeof options.shutdown === 'function') stopped = true
      return
    }
    if ((options.gated === true || stopped) && !up()) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(options.state ?? READY))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

function runEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    DSH_SUPERAGENT_PROFILE: '',
    DSH_SUPERAGENT_URL: '',
    DSH_SUPERAGENT_PROCESS_TABLE: tablePath(),
    DSH_SUPERAGENT_LAUNCH: JSON.stringify([process.execPath, join(root, 'fake-launcher.mjs')]),
    DSH_TEST_LAUNCH_RECORD: launchRecord(),
    DSH_TEST_LAUNCHER_PIDS: launcherPids(),
    ...overrides,
  }
}

function runWith(overrides: Record<string, string>, ...args: string[]): Promise<Result> {
  // A cold Windows runner can spend over twenty seconds in the real CIM scan this suite asks for, so the helper waits
  // longer than the per-test deadline; a run it had to kill must never look like a command that exited 0.
  return new Promise(resolve => execFile(process.execPath, [join(root, 'scripts', 'dsh-superagent-further'), ...args],
    { env: runEnv(overrides), timeout: 60_000 },
    (error, stdout, stderr) => resolve({
      code: typeof error?.code === 'number' ? error.code : error?.killed === true ? -1 : 0,
      killed: error?.killed === true,
      stdout, stderr })))
}

const run = (...args: string[]): Promise<Result> => runWith({}, ...args)

const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'bin'))
  // An extensionless ESM entry needs the checkout's module type, as the real repository has.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent-further'), join(root, 'scripts', 'dsh-superagent-further'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent-further.cmd'), join(root, 'scripts', 'dsh-superagent-further.cmd'))
  writeFileSync(join(root, 'fake-launcher.mjs'), FAKE_LAUNCHER)
  writeFileSync(launcherPids(), '')
  processes()
})

afterEach(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()))
  servers = []
  for (const child of children) { try { child.kill() } catch { /* already exited */ } }
  children = []
  const pids = new Set<number>()
  try { for (const entry of tableEntries()) pids.add(entry.pid) } catch { /* table already gone */ }
  try {
    for (const line of readFileSync(launcherPids(), 'utf8').split('\n')) {
      const pid = Number.parseInt(line, 10)
      if (Number.isInteger(pid)) pids.add(pid)
    }
  } catch { /* no launcher started */ }
  for (const pid of pids) { try { process.kill(pid) } catch { /* already exited */ } }
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true })
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
})

it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
  processes(service(sleeper()), { pid: sleeper(), name: 'node', args: ['node', '/opt/dsh/lib/cli.js', '--profile=superagent'] })
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent-further processes found') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
}, 20_000)
it('keeps a stop per profile', async () => {
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  const skipped = await run('--respect-stop', 'start', '--profile', 'one')
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
}, 20_000)
it('takes no `dsh plugin` command of the profile for its service', async () => {
  const running = sleeper()
  processes({ pid: sleeper(), name: 'node', args: ['node', '/opt/my tools/dsh/lib/cli.js', 'plugin', '--profile', 'superagent', 'add', 'link:/x'] },
    service(running))
  expect(await status('superagent')).toMatchObject({ pids: [running] })
}, 20_000)
it('records the service PID at start, and still refuses a second instance the scan finds', async () => {
  const mock = await answering({ gated: true })
  const start = await run('start', '--url', mock.url, '--timeout', '10')
  const pid = tableEntries()[0]!.pid
  expect(start).toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // The launcher was started in the checkout root with the documented arguments, and both output streams went to the log.
  const launch = JSON.parse(readFileSync(launchRecord(), 'utf8')) as { argv: string[]; cwd: string }
  expect(launch.argv).toEqual(['--profile', 'superagent', '--no-open'])
  expect(launch.cwd).toBe(realpathSync(root))
  const logName = readdirSync(join(root, '.artifacts')).find(name => /^dsh-superagent-further-superagent-\d{8}-\d{6}-\d+\.log$/.test(name))!
  const log = readFileSync(join(root, '.artifacts', logName), 'utf8')
  expect(log).toContain('fake launcher stdout')
  expect(log).toContain('fake launcher stderr')
  const second = sleeper()
  processes({ pid, name: 'node', args: ['node', '/opt/my tools/dsh/lib/cli.js', '--profile', 'superagent', '--no-open'] }, service(second))
  const again = await run('start', '--url', mock.url, '--timeout', '10')
  expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent-further processes') })
  expect(await status('superagent', mock.url)).toMatchObject({ pids: [pid, second] })
}, 20_000)
it('waits only for the process it stopped', async () => {
  const pid = sleeper()
  // Another instance shows up once the stopped one ended.
  const replacement = sleeper()
  processes(service(pid))
  const mock = await answering({ shutdown: () => { processes(service(replacement)); try { process.kill(pid) } catch { /* already gone */ } } })
  expect(await run('stop', '--url', mock.url, '--stop-timeout', '5'))
    .toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent-further stopped') })
}, 20_000)
it('keeps only the newest logs it wrote for the profile', async () => {
  const mock = await answering({ gated: true })
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (const profile of ['superagent', 'other']) {
    for (let index = 0; index < 25; index++) {
      const log = join(root, '.artifacts', `dsh-superagent-further-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
      writeFileSync(log, '')
      utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
    }
  }
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-further-20260901-000000-1.log'), '')
  expect(await run('start', '--url', mock.url, '--timeout', '10')).toMatchObject({ code: 0 })
  const logs = readdirSync(join(root, '.artifacts'))
  const own = logs.filter(name => name.startsWith('dsh-superagent-further-superagent-')).sort()
  expect(own).toHaveLength(20)
  // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
  expect(own).not.toContain('dsh-superagent-further-superagent-20260901-000000-1.log')
  expect(own.filter(name => !name.startsWith('dsh-superagent-further-superagent-20260901-'))).toHaveLength(1)
  expect(logs.filter(name => name.startsWith('dsh-superagent-further-other-'))).toHaveLength(25)
  expect(logs).toContain('dsh-superagent-further-20260901-000000-1.log')
}, 20_000)
it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  processes(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', (await answering({ state: feishu })).url)).toMatchObject({ code: 0 })
  expect(await run('status', '--url', (await answering({ state: { health: { runtime: { state: 'ready' } } } })).url))
    .toMatchObject({ code: 0 })
  expect(await run('status', '--url', (await answering({ state: { health: { runtime: { state: 'error' } } } })).url))
    .toMatchObject({ code: 1 })
}, 20_000)
it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  processes(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const mock = await answering({ state: github })
  const checked = await run('status', '--url', mock.url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  expect(await run('start', '--url', mock.url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
}, 20_000)
it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  processes(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const mock = await answering({ state: waiting })
  expect(await run('status', '--url', mock.url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', mock.url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
}, 20_000)
it('restarts the service, and a restart whose graceful stop timed out does not keep recovery off', async () => {
  const old = sleeper()
  processes(service(old))
  const mock = await answering({ shutdown: () => { try { process.kill(old) } catch { /* already gone */ } } })
  const restarted = await run('restart', '--url', mock.url, '--timeout', '10', '--stop-timeout', '5')
  const pid = tableEntries()[0]!.pid
  expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent-further stopped.') })
  expect(restarted.stdout).not.toContain('Automatic recovery is paused')
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // A service that does not stop in time is left running, and the next check may restart it.
  processes(service(sleeper()))
  const ignoring = await answering({ shutdown: 'ignore' })
  expect(await run('restart', '--url', ignoring.url, '--timeout', '10', '--stop-timeout', '1'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(await status('superagent', ignoring.url)).toMatchObject({ manually_stopped: false })
}, 20_000)
it('refuses a second control operation while one holds the profile\'s lock', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const held = join(root, 'held')
  const holder = spawn(process.execPath, ['-e', `const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(join(control('superagent'), 'operation.lock'))}, JSON.stringify({ pid: process.pid }))
fs.writeFileSync(${JSON.stringify(held)}, '')
setInterval(() => {}, 1000)`], { stdio: 'ignore' })
  children.push(holder)
  while (!existsSync(held)) await new Promise(resolve => setTimeout(resolve, 50))
  expect(await run('status')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Another dsh-superagent-further control operation is in progress') })
}, 20_000)
it('refuses to start a service while no process runs it but something answers at its URL', async () => {
  const mock = await answering({ state: READY })
  expect(await run('start', '--url', mock.url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('An existing orchestrator answers at this URL') })
  // No launcher was started at all.
  expect(existsSync(launchRecord())).toBe(false)
}, 20_000)
it('starts a profile whose scan is empty while another profile\'s service runs', async () => {
  processes(service(sleeper(), 'other'))
  const mock = await answering({ gated: true })
  expect(await run('start', '--url', mock.url, '--timeout', '10')).toMatchObject({ code: 0 })
  expect(JSON.parse(readFileSync(launchRecord(), 'utf8')) as { argv: string[] }).toMatchObject({ argv: ['--profile', 'superagent', '--no-open'] })
}, 20_000)
it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
  const pid = tableEntries()[0]!.pid
  expect(() => process.kill(pid, 0)).not.toThrow()
}, 20_000)
it('repeats the host\'s own reason when another host keeps the state directory, and stops the host it started for nothing', async () => {
  writeFileSync(join(root, 'fake-launcher.mjs'), `import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : ''
writeFileSync(process.env.DSH_TEST_LAUNCH_RECORD, JSON.stringify({ argv: args, cwd: process.cwd(), pid: process.pid }))
appendFileSync(process.env.DSH_TEST_LAUNCHER_PIDS, process.pid + '\\n')
writeFileSync(process.env.DSH_SUPERAGENT_PROCESS_TABLE, JSON.stringify([
  { pid: process.pid, name: 'node', args: ['node', '/opt/my tools/dsh/lib/cli.js', '--profile', profile, '--no-open'] },
]))
process.stderr.write('dsh-superagent-further (dsh-superagent-further): Error: dsh-superagent-further is already hosted for C:/state\\n')
process.stderr.write('Error: Lock file is already being held\\n')
setInterval(() => {}, 1000)
`)
  const result = await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2')
  expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('already hosted for C:/state') })
  // The refused host had no runtime to offer: this start took it down again instead of leaving it holding the port.
  const pid = tableEntries()[0]!.pid
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(() => process.kill(pid, 0)).toThrow()
}, 20_000)

it('does not force a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const other = sleeper()
  processes({ pid: other, name: 'node', args: ['node', '-e', 'setInterval(() => {}, 1000)'] })
  writeFileSync(join(control('superagent'), 'service.pid'), `${other}\n`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
  // A service that does not stop in time keeps the stop, so recovery does not start it again.
  rmSync(join(control('superagent'), 'manually-stopped'))
  processes(service(sleeper()))
  const ignoring = await answering({ shutdown: 'ignore' })
  expect(await run('stop', '--url', ignoring.url, '--stop-timeout', '1'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(true)
}, 20_000)
it('stops through the authenticated shutdown route and waits for the service to exit', async () => {
  const pid = sleeper()
  processes(service(pid))
  mkdirSync(control('superagent'), { recursive: true })
  writeFileSync(join(control('superagent'), 'service.pid'), `${pid}\n`)
  const mock = await answering({ shutdown: () => { try { process.kill(pid) } catch { /* already gone */ } } })
  expect(await run('stop', '--url', mock.url, '--stop-timeout', '5'))
    .toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  // The management contract is POST /orchestrator/api/shutdown with the same-origin management header.
  expect(mock.requests).toContain('POST /orchestrator/api/shutdown 1')
  expect(existsSync(join(control('superagent'), 'service.pid'))).toBe(false)
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(true)
}, 20_000)
it('falls back to a forceful stop when the shutdown route is absent or the service is unreachable', async () => {
  const absent = sleeper()
  processes(service(absent))
  const mock = await answering({ shutdown: 'absent' })
  expect(await run('stop', '--url', mock.url, '--stop-timeout', '5'))
    .toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent-further stopped') })
  expect(mock.requests).toContain('POST /orchestrator/api/shutdown 1')
  expect(() => process.kill(absent, 0)).toThrow()
  const unreachable = sleeper()
  processes(service(unreachable))
  expect(await run('stop', '--url', 'http://127.0.0.1:9', '--stop-timeout', '5')).toMatchObject({ code: 0 })
  expect(() => process.kill(unreachable, 0)).toThrow()
}, 20_000)
it('discovers the real process table without crashing when no fake table is injected', async () => {
  const result = await runWith({ DSH_SUPERAGENT_PROCESS_TABLE: '', DSH_SUPERAGENT_LAUNCH: '' },
    'status', '--profile', 'nosuchprofile12345', '--url', 'http://127.0.0.1:9')
  expect(result.killed).toBe(false)
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout) as { pids: number[]; cwd: string }).toMatchObject({ pids: [], cwd: realpathSync(root) })
}, 60_000)
it('reports a stopped service cleanly when the recorded PID has exited', async () => {
  // `status` and `stop` check a recorded PID with a per-process query: `ps -p <dead pid>` exits 1 and CIM returns no row,
  // so neither may turn a cleanly exited service into a failed command. The profile name is unique so a service an operator
  // runs while the suite runs (`--profile superagent`) is not mistaken for the dead one.
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const dead = exited.pid!
  await new Promise<void>(resolve => exited.once('exit', () => resolve()))
  const profile = `stopped-pid-${process.pid}`
  mkdirSync(control(profile), { recursive: true })
  writeFileSync(join(control(profile), 'service.pid'), String(dead))
  const result = await runWith({ DSH_SUPERAGENT_PROCESS_TABLE: '' }, 'status', '--profile', profile, '--url', 'http://127.0.0.1:9')
  expect(result.stderr).not.toContain('Command failed')
  expect(JSON.parse(result.stdout) as { pids: number[] }).toMatchObject({ pids: [] })
  expect(result.code).toBe(1)
}, 60_000)
it('does not count a run of this script itself as the service, whatever its path spelling', async () => {
  // A `status` or `stop` command carries the same `--profile` words a service does; counting one would let the script see
  // (and on POSIX stop) itself. The Windows branch is saved from that only by also requiring a `cli.js` word.
  processes(
    { pid: sleeper(), name: 'node', args: [process.execPath, join(root, 'scripts', 'dsh-superagent-further'), 'status', '--profile', 'superagent'] },
    { pid: sleeper(), name: 'node', args: ['node', 'C:\\src\\dsh-superagent-further', 'status', '--profile', 'superagent'] },
  )
  expect((await status('superagent')).pids).toEqual([])
}, 20_000)
it('prints usage for --help and exits 2 for invalid arguments', async () => {
  expect(await run('--help')).toMatchObject({ code: 0, stdout: expect.stringContaining('usage: dsh-superagent-further') })
  expect(await run('bogus')).toMatchObject({ code: 2, stderr: expect.stringContaining('invalid choice') })
  expect(await run('--timeout', '0', 'status')).toMatchObject({ code: 2, stderr: expect.stringContaining('must be positive') })
}, 20_000)
it.runIf(process.platform === 'win32')('runs the Windows .cmd wrapper with the same exit codes as node', async () => {
  const result = await new Promise<Result>(resolve => execFile(process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', 'dsh-superagent-further.cmd status'], { cwd: join(root, 'scripts'), env: runEnv(), timeout: 60_000 },
    (error, stdout, stderr) => resolve({
      code: typeof error?.code === 'number' ? error.code : error?.killed === true ? -1 : 0,
      killed: error?.killed === true,
      stdout, stderr })))
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout) as { pids: number[]; cwd: string }).toMatchObject({ pids: [], cwd: realpathSync(root) })
}, 60_000)
it.runIf(process.platform === 'win32')('launches the profile through the Windows dsh.cmd launcher resolved on PATH', async () => {
  writeFileSync(join(root, 'bin', 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${join(root, 'fake-launcher.mjs')}" %*\r\n`)
  const mock = await answering({ gated: true })
  expect(await runWith({ DSH_SUPERAGENT_LAUNCH: '' }, 'start', '--url', mock.url, '--timeout', '10'))
    .toMatchObject({ code: 0 })
  expect(JSON.parse(readFileSync(launchRecord(), 'utf8')) as { argv: string[] })
    .toMatchObject({ argv: ['--profile', 'superagent', '--no-open'] })
}, 20_000)
