import { taskRef } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { BlobStore } from './blob-store.ts'

const { designVersions, taskDesignPins, tasks } = schema

// A design version as the agents' get_design tool returns it (D20). The
// bundle and screenshots travel as base64; the runner writes them to the
// agent's scratch folder and extracts the bundle there.
export interface DesignForAgent {
  taskRef: string
  title: string
  version: number
  status: string
  branch: string
  commitSha: string
  // design.md, as the developer wrote it
  spec: string
  // The screens a build task is pinned to; null when read from the design task
  pinnedScreens: string[] | null
  screenshots: { fileName: string, contentType: string, dataBase64: string }[]
  // The static bundle, a gzipped tar of index.html and its assets
  bundle: { dataBase64: string }
}

export class DesignNotFound extends Error {}

// Reads a design version by the ref of its design task, or of a build task
// pinned to one. With no version, a design task gives its latest version and
// a build task its pinned one. Only this project's tasks are read.
export async function readDesign(db: Executor, blobs: BlobStore, project: { id: string, prefix: string }, ref: string, version?: number): Promise<DesignForAgent> {
  const match = new RegExp(`^${project.prefix}-(\\d+)$`, 'i').exec(ref.trim())
  const [task] = match
    ? await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), eq(tasks.number, Number(match[1])), isNull(tasks.deletedAt)))
    : []
  if (!task) throw new DesignNotFound(`No task ${ref} in this project (refs look like ${project.prefix}-12)`)

  let designTaskId = task.id
  let pinnedScreens: string[] | null = null
  let wanted = version
  if (task.type !== 'design') {
    const [pin] = await db.select({ screens: taskDesignPins.screens, taskId: designVersions.taskId, version: designVersions.version }).from(taskDesignPins)
      .innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId)).where(eq(taskDesignPins.taskId, task.id))
    if (!pin) throw new DesignNotFound(`${ref} is neither a design task nor pinned to a design`)
    designTaskId = pin.taskId
    pinnedScreens = pin.screens
    wanted ??= pin.version
  }

  const [row] = await db.select().from(designVersions)
    .where(and(eq(designVersions.taskId, designTaskId), wanted === undefined ? undefined : eq(designVersions.version, wanted)))
    .orderBy(desc(designVersions.version)).limit(1)
  if (!row) throw new DesignNotFound(wanted === undefined ? `${ref} has no design versions yet` : `${ref} has no design version v${wanted}`)
  const [designTask] = designTaskId === task.id ? [task] : await db.select().from(tasks).where(eq(tasks.id, designTaskId))

  const read = async (hash: string, what: string) => {
    const data = await blobs.get(hash)
    if (!data) throw new DesignNotFound(`The ${what} of design v${row.version} is missing from the blob store`)
    return Buffer.from(data)
  }
  return {
    taskRef: taskRef(project.prefix, designTask!.number),
    title: designTask!.title,
    version: row.version,
    status: row.status,
    branch: row.branch,
    commitSha: row.commitSha,
    spec: (await read(row.specBlob, 'spec')).toString('utf8'),
    pinnedScreens,
    screenshots: await Promise.all(row.screenshots.map(async s => ({ fileName: s.fileName, contentType: s.contentType, dataBase64: (await read(s.blob, `screenshot ${s.fileName}`)).toString('base64') }))),
    bundle: { dataBase64: (await read(row.bundleBlob, 'bundle')).toString('base64') }
  }
}
