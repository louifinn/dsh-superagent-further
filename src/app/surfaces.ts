/**
 * The model-facing surface inventory (issue #6, docs/015 D1): what each role's model actually sees, read from the
 * runtime's own registrations instead of a hand list. Step 2 of the migration order moves the test-only `collect()`
 * sweep here; the declarative `SURFACES` record, the projection table and the generated budgets arrive in the next
 * steps.
 */
import { RESOURCES } from './resources.ts'

/** Every role whose model-facing surface the design has to account for; the Lead and reviewer gap is declared below. */
export type RoleId = 'orchestrator' | 'worker' | 'lead' | 'reviewer'
export const ROLE_IDS: readonly RoleId[] = ['orchestrator', 'worker', 'lead', 'reviewer']

/**
 * Roles the runtime assembles and registers today. `promptParts` composes only the Orchestrator and the worker; the
 * Lead's prompt is composed by its own function and the reviewer has no prompt of its own yet, so neither appears in
 * the inventory. Step 3 of docs/015 closes this gap; until then the pair is declared, not silently omitted.
 */
export const COLLECTED_ROLES: readonly RoleId[] = ['orchestrator', 'worker']
export const UNCOLLECTED_ROLES: readonly RoleId[] = ['lead', 'reviewer']

/** One composed prompt part, as `promptParts` returns it. */
export interface SurfacePart { readonly name: string; readonly text: string }
/** One registered application tool, reduced to the text its model reads. */
export interface SurfaceTool { readonly name: string; readonly description: string; readonly parameters: unknown }
/** One registered skill, as a Session sees it. */
export interface SurfaceSkill { readonly name: string; readonly description: string; readonly content: string }

/** What a running runtime registered for one role, as opposed to what docs/015 declares it should register. */
export interface RoleRegistration {
  readonly role: RoleId
  readonly parts: readonly SurfacePart[]
  /** Prompt text the runtime generates beyond the parts: revision, environment, the projects a Lead owns. */
  readonly generated: string
  readonly tools: readonly SurfaceTool[]
  readonly skills: readonly SurfaceSkill[]
}

/** One model-facing text in the inventory. */
export interface SurfaceText { readonly role: RoleId; readonly where: string; readonly text: string }

/**
 * The model-facing text of every registered role: one entry per prompt part, one for the generated part, one per tool
 * description and one per skill. The inventory is a function of the runtime's registrations, so the tests, the panel
 * and (later) the reference generator can read the same answer instead of each keeping its own list.
 */
export function collectSurfaces(registrations: readonly RoleRegistration[]): SurfaceText[] {
  const surfaces: SurfaceText[] = []
  for (const registration of registrations) {
    for (const part of registration.parts) surfaces.push({ role: registration.role, where: `${registration.role} prompt ${part.name}`, text: part.text })
    if (registration.generated !== '') surfaces.push({ role: registration.role, where: `${registration.role} prompt from the runtime`, text: registration.generated })
    for (const tool of registration.tools) surfaces.push({ role: registration.role, where: `${registration.role} tool ${tool.name}`, text: tool.description })
    for (const skill of registration.skills) surfaces.push({ role: registration.role, where: `skill ${skill.name}`, text: `${skill.description}\n${skill.content}` })
  }
  return surfaces
}

/** The declared roles a set of registrations leaves out; the Lead and reviewer are expected until docs/015 step 3. */
export function uncollectedRoles(registered: readonly RoleId[]): RoleId[] {
  const seen = new Set(registered)
  return ROLE_IDS.filter(role => !seen.has(role))
}

/** The resource grammar, as the inventory snapshots it: name, what it holds, and whether only an Executor may read it. */
export const RESOURCE_GRAMMAR: readonly { name: string; holds: string; executor: boolean }[] =
  RESOURCES.map(({ name, holds, executor }) => ({ name, holds, executor: executor === true }))
