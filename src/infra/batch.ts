/**
 * Windows runs a `.cmd`/`.bat` program only through `cmd.exe`, and Node cannot start one with an argument array: `spawn` and
 * `execFile` fail with EINVAL. A configured CLI (gh, lark-cli) may be installed that way, so every place that starts one
 * builds its invocation with these helpers instead of passing the path to `spawn` directly.
 */
const BATCH_FILE = /\.(?:cmd|bat)$/i
/**
 * What `cmd.exe` rewrites inside a command line: `%VAR%` expands (there is no escape outside a batch file) and a line break
 * starts a new command. An argument matching this cannot reach the CLI unchanged and must be refused.
 */
const EXPANSION = /%[^%]*%|[\r\n]/
/** Whether `program` is a batch file, which only `cmd.exe` can run. */
export const isBatchFile = (program: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' && BATCH_FILE.test(program)
/** Whether an argument cannot cross a `cmd.exe` command line unchanged. */
export const expandsInBatch = (args: readonly string[]): boolean => args.some(arg => EXPANSION.test(arg))
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
