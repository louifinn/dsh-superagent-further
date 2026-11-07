/**
 * Projects: the local workspaces and remote repositories this installation works on.
 * A project pairs one local clone with one remote repository; Tickets belong to a project and get their own checkout in
 * that clone, and Sources poll every project's repository.
 */
import { z } from 'zod'
import { isAbsolutePath } from './infra/paths.ts'
import { LIMITS } from './limits.ts'

/** A project identifier: a lowercase slug that appears in Tickets, logs and the panel. */
export const ProjectIdSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/,
  'A lowercase slug of letters, digits and hyphens, at most 40 characters')
/** One project's local workspace and remote repository; `branch` empty means the repository's default branch. */
export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string().trim().min(1).max(LIMITS.projectName),
  workspace: z.string().trim().max(LIMITS.projectPath).refine(path => isAbsolutePath(path),
    'An absolute path to the local clone'),
  repository: z.string().trim().max(LIMITS.projectRepository).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'A repository as owner/name'),
  branch: z.string().trim().max(LIMITS.projectBranch).refine(branch => branch === '' || /^[A-Za-z0-9._/-]+$/.test(branch),
    'A branch name of letters, digits, dots, dashes, underscores or slashes; empty for the repository default').default(''),
}).strict()
export type Project = z.infer<typeof ProjectSchema>
/** All projects, in the order the panel lists them; IDs are unique. */
export const ProjectsSchema = z.array(ProjectSchema).max(LIMITS.projects)
  .refine(projects => new Set(projects.map(project => project.id)).size === projects.length, 'Duplicate project IDs')
  .refine(projects => new Set(projects.map(project => project.workspace)).size === projects.length,
    'Two projects cannot share a local workspace')
export type Projects = z.infer<typeof ProjectsSchema>
/** The project with `id`, or undefined when the installation has none by that ID. */
export const projectOf = (projects: readonly Project[], id: string | undefined): Project | undefined =>
  id === undefined ? undefined : projects.find(project => project.id === id)

/** The project whose repository is `repository` (owner/name, compared case-insensitively), or undefined. */
export const projectByRepository = (projects: readonly Project[], repository: string | undefined): Project | undefined =>
  repository === undefined ? undefined : projects.find(project => project.repository.toLowerCase() === repository.trim().toLowerCase())
