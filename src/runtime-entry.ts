/**
 * The versioned domain runtime's entry point.
 *
 * This module is built separately into a self-contained `lib/runtime-entry.js` with no `@deepseek-ai/*` runtime imports. The
 * supervisor imports its built copy (or a deployed copy from `<stateDir>/runtime/<version>/`) and calls `createRuntime(host)`;
 * everything the runtime needs from DSH arrives through the frozen host rather than through static value imports.
 */
import { Runtime } from './app/runtime.ts'
import type { RuntimeHandle, RuntimeHost } from './runtime-host.ts'

/** The host API this bundle implements; the loader refuses a bundle built for another API. */
export { HOST_API } from './runtime-host.ts'
/** The database schema this bundle understands; the loader refuses a bundle older than the database. */
export { SCHEMA_VERSION } from './app/migration.ts'

/** Create the runtime over a frozen host. The supervisor awaits `ready`, then owns `drain`/`dispose`. */
export function createRuntime(host: RuntimeHost): RuntimeHandle {
  return new Runtime(host)
}
