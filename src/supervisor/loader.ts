/**
 * Dynamic loading of a versioned runtime bundle.
 *
 * The import specifier is computed at run time from the verified entry path (`pathToFileURL` of a variable), so the build
 * never sees a static import it could inline: the packaged supervisor keeps its own copy of the runtime loader, and the
 * deployed runtime is a self-contained file beneath the state directory. A module is validated before anything is created:
 * it must export the frozen host API, `createRuntime`, a schema version, and a handle with `ready`/`drain`/`dispose`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  HOST_API, PACKAGED_RUNTIME_MANIFEST, type RuntimeDescriptor, type RuntimeHandle, type RuntimeHost, type RuntimeModule,
} from '../runtime-host.ts'
import { readDescriptorFile, safeEntry, sha256File } from './versions.ts'

/** The runtime the package itself ships, used when no deployed version verifies. */
export interface PackagedRuntime {
  readonly descriptor: RuntimeDescriptor
  readonly entry: string
}

/** A loaded and validated runtime bundle. */
export interface LoadedRuntime {
  readonly handle: RuntimeHandle
  /** The database schema the bundle supports; equal to the bundle's exported `SCHEMA_VERSION`. */
  readonly schema: number
}

/** Find the package root by walking up to a `package.json` named `dsh-superagent-further`. */
export function packageRoot(start = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let directory = start
  for (let depth = 0; depth < 4; depth++) {
    try {
      const value = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
      if (value.name === 'dsh-superagent-further') return directory
    } catch {
      // No package manifest here; try the parent.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Describe the packaged runtime, which is always a built `lib/runtime-manifest.json` plus the bundled `lib/runtime-entry.js`.
 * There is deliberately no source-checkout fallback: Node's default TypeScript support cannot load `src/runtime-entry.ts`
 * (it uses parameter properties), so an unbuilt package is a packaging error that names the build command rather than a
 * runtime that fails on import. The packaged entry is verified by hash exactly like a deployed one; a corrupt package is a
 * packaging error too, not a fallback.
 */
export function packagedRuntime(root = packageRoot()): PackagedRuntime {
  if (root === undefined) {
    throw new Error('dsh-superagent-further cannot locate its package root, so it cannot load its packaged runtime; run pnpm build')
  }
  const lib = join(root, 'lib')
  const manifestPath = join(lib, PACKAGED_RUNTIME_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new Error(`The packaged runtime manifest ${manifestPath} does not exist; run pnpm build to create lib/runtime-manifest.json and lib/runtime-entry.js`)
  }
  const read = readDescriptorFile(manifestPath)
  if (read.descriptor === undefined) {
    throw new Error(`The packaged runtime manifest ${manifestPath} is invalid: ${read.reason ?? 'unknown reason'}; run pnpm build`)
  }
  const safe = safeEntry(lib, read.descriptor.entry)
  if (safe.path === undefined) {
    throw new Error(`The packaged runtime manifest ${manifestPath} names an unsafe entry: ${safe.reason ?? 'unknown reason'}; run pnpm build`)
  }
  const entry = safe.path
  if (!existsSync(entry)) throw new Error(`The packaged runtime entry ${entry} does not exist; run pnpm build`)
  const actual = sha256File(entry)
  if (actual !== read.descriptor.sha256) {
    throw new Error(`The packaged runtime entry ${entry} has hash ${actual}, not ${read.descriptor.sha256}; run pnpm build`)
  }
  return { descriptor: read.descriptor, entry }
}

/** Whether a value can be awaited. */
function thenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

/**
 * Import and validate one verified runtime entry, then call its `createRuntime(host)`.
 * The module must match this host API, support at least `databaseSchema` (never a downgrade), and return a handle with
 * a thenable `ready` plus `drain` and `dispose` functions.
 */
export async function loadRuntime(options: { host: RuntimeHost; entry: string; databaseSchema?: number }): Promise<LoadedRuntime> {
  const specifier = pathToFileURL(options.entry).href
  let module: RuntimeModule
  try {
    module = await import(specifier) as RuntimeModule
  } catch (error) {
    throw new Error(`The runtime at ${options.entry} could not be imported: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (module.HOST_API !== HOST_API) {
    throw new Error(`The runtime at ${options.entry} declares host API ${String(module.HOST_API)}, but this supervisor implements ${HOST_API}`)
  }
  if (typeof module.createRuntime !== 'function') {
    throw new Error(`The runtime at ${options.entry} does not export createRuntime`)
  }
  const schema = module.SCHEMA_VERSION
  if (typeof schema !== 'number' || !Number.isInteger(schema)) {
    throw new Error(`The runtime at ${options.entry} does not export an integer SCHEMA_VERSION`)
  }
  if (options.databaseSchema !== undefined && schema < options.databaseSchema) {
    throw new Error(`Unsupported orchestrator database version ${options.databaseSchema}: the runtime at ${options.entry} supports schema ${schema}; a downgrade is never attempted`)
  }
  let value: unknown
  try {
    value = (module.createRuntime as (host: RuntimeHost) => unknown)(options.host)
  } catch (error) {
    throw new Error(`The runtime at ${options.entry} failed to initialize: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (typeof value !== 'object' || value === null) throw new Error(`The runtime at ${options.entry} returned no handle`)
  const handle = value as Partial<RuntimeHandle>
  if (!thenable(handle.ready) || typeof handle.drain !== 'function' || typeof handle.dispose !== 'function') {
    throw new Error(`The runtime at ${options.entry} returned a handle without ready, drain, and dispose`)
  }
  return { handle: handle as RuntimeHandle, schema }
}
