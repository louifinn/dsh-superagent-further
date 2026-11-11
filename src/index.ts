/** Main plugin entry: starts the stable supervisor, which resolves and starts the versioned domain runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Config, machineOf, type DeploymentConfig } from './supervisor/config.ts'
import { Supervisor } from './supervisor/supervisor.ts'

export const name = 'dsh-superagent-further'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent-further. DSH's settings service stops
  // serving this entry while dsh-superagent-further restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent-further restart failed: %s', String(error)) })
  }
  const supervisor = new Supervisor({ context: ctx, machine, restart, exit: code => { process.exit(code) } })
  ctx.effect(() => async () => { await supervisor.stop() })
  await supervisor.start()
  ctx.logger.info(supervisor.configured() ? 'dsh-superagent-further ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent-further is waiting for setup: ${supervisor.setupProblem()?.detail ?? ''}`)
}
export type { Deployment } from './deployment.ts'
export type { DeploymentConfig } from './supervisor/config.ts'
export * from './core/index.ts'
