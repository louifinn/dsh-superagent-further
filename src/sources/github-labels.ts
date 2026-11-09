/** Adds and removes existing labels on the GitHub Issue or pull request a Trigger names; labels are never created. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceLabelChange, SourceLabelResult } from './kind.ts'
import { SOURCE } from './github-trigger.ts'

/** One page of labels; the list endpoints return arrays of these objects. */
const LabelSchema = z.object({ name: z.string() }).loose()
const LabelsSchema = z.array(LabelSchema)
/** A label change accepts at most this many names in each direction, keeping the request small and reviewable. */
export const GITHUB_LABEL_LIMIT = 10

/** The repository and number an Issue or pull request Trigger names; undefined when it names neither. */
export function githubLabelTarget(trigger: Trigger, deployment: Pick<Deployment, 'repository'>): { repository: string; number: number } | undefined {
  if (trigger.source !== SOURCE) return undefined
  const number = Number(trigger.meta.number)
  if (!Number.isInteger(number) || number <= 0) return undefined
  const repository = typeof trigger.meta.repository === 'string' && trigger.meta.repository !== '' ? trigger.meta.repository : deployment.repository
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return undefined
  return { repository, number }
}
/** Trims, de-duplicates and validates label names; a comma or control character is refused because GitHub treats them as paths or text. */
function clean(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (name === '') throw new Error('A label name cannot be empty')
    if (name.length > 100) throw new Error(`A label name has at most 100 characters: ${name.slice(0, 40)}…`)
    if (/[,\u0000-\u001f]/.test(name)) throw new Error(`A label name cannot contain a comma or control character: ${name}`)
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    result.push(name)
  }
  return result
}
/** Returns the labels currently on an Issue or pull request, in GitHub's order. */
async function issueLabels(commands: Pick<Commands, 'gh'>, repository: string, number: number): Promise<string[]> {
  const labels = LabelsSchema.parse(await commands.gh(['api', `repos/${repository}/issues/${number}/labels?per_page=100`]))
  return labels.map(label => label.name)
}
/** Returns every label the repository defines, so an add can be checked and spelled the way GitHub stores it. */
async function repositoryLabels(commands: Pick<Commands, 'gh'>, repository: string): Promise<string[]> {
  const labels = LabelsSchema.parse(await commands.gh(['api', `repos/${repository}/labels?per_page=100`]))
  return labels.map(label => label.name)
}
/**
 * Adds and removes existing labels on the Issue or pull request `trigger` names, in `deployment`'s primary repository or
 * the Trigger's own project repository. Every added label must already exist in the repository; every removed label must
 * currently be on the target. Labels are applied in one batch per direction and the target's labels are reread before the
 * result is returned. Nothing else about the Issue is changed.
 * @throws when the Trigger names no labelable GitHub work, a name is invalid, or GitHub refuses the write.
 */
export async function setGithubLabels(commands: Pick<Commands, 'gh' | 'apiWrite'>, deployment: Pick<Deployment, 'repository'>,
  trigger: Trigger, change: SourceLabelChange): Promise<SourceLabelResult> {
  const target = githubLabelTarget(trigger, deployment)
  if (target === undefined) throw new Error('Only a GitHub Issue or pull request Trigger can change labels')
  if (trigger.meta.ci === true) throw new Error('A CI Trigger names no Issue or pull request to label')
  const add = clean(change.add ?? [])
  const remove = clean(change.remove ?? [])
  if (add.length === 0 && remove.length === 0) throw new Error('A label change needs at least one label to add or remove')
  if (add.length > GITHUB_LABEL_LIMIT || remove.length > GITHUB_LABEL_LIMIT) throw new Error(`A label change accepts at most ${GITHUB_LABEL_LIMIT} labels to add and ${GITHUB_LABEL_LIMIT} to remove`)
  const overlap = add.filter(name => remove.some(other => other.toLowerCase() === name.toLowerCase()))
  if (overlap.length > 0) throw new Error(`A label cannot be added and removed in one call: ${overlap.join(', ')}`)

  const { repository, number } = target
  const current = await issueLabels(commands, repository, number)
  const existing = await repositoryLabels(commands, repository)
  const byLower = new Map(existing.map(name => [name.toLowerCase(), name]))
  const canonicalAdd = add.map(name => {
    const canonical = byLower.get(name.toLowerCase())
    if (canonical === undefined) throw new Error(`The repository has no label named “${name}”; labels are never created`)
    return canonical
  })
  const currentLower = new Set(current.map(name => name.toLowerCase()))
  const onIssue = remove.map(name => {
    const match = current.find(item => item.toLowerCase() === name.toLowerCase())
    if (match === undefined) throw new Error(`The target has no label named “${name}” to remove`)
    return match
  })
  const added = canonicalAdd.filter(name => !currentLower.has(name.toLowerCase()))
  if (added.length > 0) await commands.apiWrite(repository, 'POST', `issues/${number}/labels`, { labels: added })
  for (const name of onIssue) await commands.apiWrite(repository, 'DELETE', `issues/${number}/labels/${encodeURIComponent(name)}`)
  return { added, removed: onIssue, labels: await issueLabels(commands, repository, number) }
}
