/**
 * Windows runs a `.cmd`/`.bat` program only through `cmd.exe`, and Node cannot start one with an argument array: `spawn` and
 * `execFile` fail with EINVAL. A configured CLI (gh, lark-cli) may be installed that way, so every place that starts one
 * builds its invocation with these helpers instead of passing the path to `spawn` directly.
 */
const BATCH_FILE = /\.(?:cmd|bat)$/i
/**
 * What `cmd.exe` rewrites inside a command line: a `%VAR%` that names a variable in the child's environment expands (there is
 * no escape outside a batch file), and a line break starts a new command. A percent pair that names no variable passes through
 * unchanged, so an encoded value such as `%3A50%3A` is safe: only defined names and line breaks must be refused.
 */
const EXPANSION = /%([^%]*)%/g
const LINE_BREAK = /[\r\n]/
/** Whether `program` is a batch file, which only `cmd.exe` can run. */
export const isBatchFile = (program: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' && BATCH_FILE.test(program)
/** Whether an argument cannot cross a `cmd.exe` command line unchanged, given the environment the CLI inherits. */
export function expandsInBatch(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): boolean {
  const defined = new Set(Object.keys(environment).map(name => name.toUpperCase()))
  return args.some(arg => LINE_BREAK.test(arg)
    || [...arg.matchAll(EXPANSION)].some(match => defined.has((match[1] ?? '').toUpperCase())))
}
/**
 * The `cmd.exe` arguments that run `program` with `args`. `/d` skips AutoRun, and `/s` with one outer quote pair around the
 * quoted command line keeps every token intact; callers must also pass `windowsVerbatimArguments: true`, because otherwise
 * Node quotes the command line a second time.
 */
export function batchArguments(program: string, args: readonly string[]): string[] {
  const quote = (value: string): string => `"${value.replaceAll('"', '\\"')}"`
  return ['/d', '/s', '/c', `"${[program, ...args].map(quote).join(' ')}"`]
}
/** How to start a configured CLI: a batch file goes through `cmd.exe`, anything else runs directly. */
export interface Invocation { program: string; args: string[]; verbatim: boolean }
/** The program, arguments and verbatim flag that start `program` with `args` on the current platform. */
export function invocation(program: string, args: readonly string[]): Invocation {
  if (!isBatchFile(program)) return { program, args: [...args], verbatim: false }
  return { program: 'cmd.exe', args: batchArguments(program, args), verbatim: true }
}
