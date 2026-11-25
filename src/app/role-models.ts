/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { RuntimeHostValues } from '../runtime-host.ts'
import type { RoleModel } from '../policy.ts'

/** The model a managed Session last selected, or undefined while it runs on the host default (issue #24). */
export function sessionModel(agent: Agent): ModelSelection | undefined {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'model/selection') continue
    const data = event.data as unknown as Record<string, unknown> | null
    if (!data || typeof data !== 'object' || typeof data.provider !== 'string' || typeof data.model !== 'string') return undefined
    return { provider: data.provider, model: data.model,
      ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort as ModelSelection['reasoningEffort'] } : {}) }
  }
  return undefined
}

/**
 * Switch a managed Session to another model for its next request (issue #24). The selection is appended so the switch is
 * durable, and a one-shot override hands it to the next assembled request; DSH re-reads the appended selection afterwards.
 * This is a recovery step, not an authorization change: the Mandate, Policy and every other Session setting stay as they are.
 */
export async function switchSessionModel(ctx: Context, agent: Agent, selection: ModelSelection): Promise<void> {
  agent.session.append('model/selection', selection)
  let armed = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        if (!armed) return next()
        const result = await next()
        armed = false
        assembled = selection
        return { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } }
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        const switched = { ...rest, ...assembled }
        assembled = undefined
        return switched
      }, { prepend: true }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel, values: Pick<RuntimeHostValues, 'ReasoningEffortId'>): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: values.ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null,
  values: Pick<RuntimeHostValues, 'ReasoningEffortId'>): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  const selected = await resolveRoleModel(ctx, model, values)
  // Avoid selectModel because it mutates the global DSH default; inject the selection for the initial request only.
  agent.session.append('model/selection', selected)
  let initial = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}
