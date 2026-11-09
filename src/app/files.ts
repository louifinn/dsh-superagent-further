/** Resolves a workspace-relative file for delivery, refusing paths that could leave the workspace. */
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'

/** A readable file inside a project workspace: what a Source kind needs to deliver it. */
export interface LocalFile { directory: string; name: string; size: number; mtimeMs: number }

const SEGMENTS = /[\\/]+/
/** Repeated separators would collapse an empty segment that the checks below never see. */
const SEPARATORS = /[\\/]{2}/

/**
 * Resolve `path` inside `workspace` to a regular file. The path must be relative, must not contain `..`, `.` or empty
 * segments, and the resolved file must remain under the workspace, so a tool can never deliver a file outside it.
 */
export async function localFile(workspace: string, path: string): Promise<LocalFile> {
  const relative = path.trim()
  if (relative === '') throw new Error('A workspace-relative file path is required')
  if (isAbsolute(relative)) throw new Error(`The file path must be relative to the project workspace: ${relative}`)
  if (SEPARATORS.test(relative)) throw new Error(`The file path must name a file inside the project workspace: ${relative}`)
  const segments = relative.split(SEGMENTS)
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`The file path must name a file inside the project workspace: ${relative}`)
  }
  const root = resolve(workspace)
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`The file path must name a file inside the project workspace: ${relative}`)
  }
  const info = await stat(target).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw new Error(`No such file in the project workspace: ${relative}`)
  return { directory: dirname(target), name: basename(target), size: info.size, mtimeMs: info.mtimeMs }
}
