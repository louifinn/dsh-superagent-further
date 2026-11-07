/** Validation of project registrations: one local workspace and one remote repository per project. */
import { describe, expect, it } from 'vitest'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { ProjectSchema, ProjectsSchema, projectByRepository, projectOf } from '../src/projects.ts'

/** An absolute path in the spelling of the platform the tests run on. */
const workspace = (name: string): string => process.platform === 'win32' ? `C:/src/${name}` : `/src/${name}`
const project = (overrides: Record<string, unknown> = {}) => ({ id: 'app', name: 'App', workspace: workspace('app'),
  repository: 'owner/app', branch: 'main', ...overrides })

describe('looking a project up', () => {
  it('finds the project by id, and by repository ignoring case and surrounding space', () => {
    const projects = ProjectsSchema.parse([project(), project({ id: 'web', name: 'Web', workspace: workspace('web'),
      repository: 'Owner/Web' })])
    expect(projectOf(projects, 'web')?.name).toBe('Web')
    expect(projectOf(projects, undefined)).toBeUndefined()
    expect(projectByRepository(projects, 'owner/app')?.id).toBe('app')
    expect(projectByRepository(projects, ' OWNER/WEB ')?.id).toBe('web')
    expect(projectByRepository(projects, 'owner/other')).toBeUndefined()
    expect(projectByRepository(projects, undefined)).toBeUndefined()
  })
})

describe('a project', () => {
  it('names a local workspace and a remote repository, and defaults the branch to the repository default', () => {
    expect(ProjectSchema.parse(project())).toEqual({ id: 'app', name: 'App', workspace: workspace('app'), repository: 'owner/app',
      branch: 'main' })
    expect(ProjectSchema.parse(project({ branch: undefined })).branch).toBe('')
  })
  it('requires a lowercase slug, an absolute workspace and an owner/name repository', () => {
    expect(() => ProjectSchema.parse(project({ id: 'App' }))).toThrow()
    expect(() => ProjectSchema.parse(project({ id: '2app' }))).not.toThrow()
    expect(() => ProjectSchema.parse(project({ workspace: 'src/app' }))).toThrow(/absolute path/)
    expect(() => ProjectSchema.parse(project({ repository: 'owner' }))).toThrow(/owner\/name/)
    expect(() => ProjectSchema.parse(project({ branch: 'bad branch' }))).toThrow()
    expect(() => ProjectSchema.parse(project({ name: ' ' }))).toThrow()
  })
  it('rejects unknown fields so a typo cannot silently disable a setting', () => {
    expect(() => ProjectSchema.parse(project({ workspaces: workspace('other') }))).toThrow()
  })
})

describe('the project list', () => {
  it('rejects duplicate IDs and a workspace shared by two projects', () => {
    expect(() => ProjectsSchema.parse([project(), project({ name: 'Other' })])).toThrow(/Duplicate project IDs/)
    expect(() => ProjectsSchema.parse([project(), project({ id: 'other', repository: 'owner/other' })])).toThrow(/share a local workspace/)
    expect(() => ProjectsSchema.parse([project(), project({ id: 'other', repository: 'owner/other', workspace: workspace('other') })])).not.toThrow()
  })
  it('finds a project by ID and ignores an unknown one', () => {
    const projects = ProjectsSchema.parse([project()])
    expect(projectOf(projects, 'app')?.repository).toBe('owner/app')
    expect(projectOf(projects, 'missing')).toBeUndefined()
    expect(projectOf(projects, undefined)).toBeUndefined()
  })
})

describe('executor settings', () => {
  it('start with no projects and keep registered ones', () => {
    expect(ExecutorConfigSchema.parse({}).projects).toEqual([])
    const parsed = ExecutorConfigSchema.parse({ projects: [project()] })
    expect(parsed.projects).toEqual([project()])
  })
  it('refuse a second project in the same workspace', () => {
    expect(() => ExecutorConfigSchema.parse({ projects: [project(), project({ id: 'again', repository: 'owner/again',
      workspace: workspace('app') })] })).toThrow(/share a local workspace/)
  })
})
