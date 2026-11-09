import type { CreateProjectInput, PatchProjectInput, Project } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema, type Executor, type ProjectRow } from '@corral/db'
import { asc, eq, sql } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { blobVersion } from './blob-store.ts'
import { notFound } from './errors.ts'

// How the Inbox names a project on an item
export function projectTag(project: Pick<ProjectRow, 'id' | 'slug' | 'name' | 'thumbnailColor' | 'thumbnailBlob'>) {
  return { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: thumbnailUrl(project) }
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    prefix: row.prefix,
    thumbnailColor: row.thumbnailColor,
    thumbnailUrl: thumbnailUrl(row),
    nextTaskNumber: row.nextTaskNumber,
    repository: row.repository,
    defaultBranch: row.defaultBranch,
    mergeMethod: row.mergeMethod,
    requiredChecks: row.requiredChecks,
    paused: row.paused,
    humanReviewDefault: row.humanReviewDefault,
    epicReviewModeDefault: row.epicReviewModeDefault,
    reviewRoundCap: row.reviewRoundCap,
    failedRunCap: row.failedRunCap,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

// The title part of a branch name Corral creates
export function branchSlug(title: string): string {
  return slugify(title).slice(0, 40).replace(/-+$/, '')
}

export async function listProjects(db: Executor): Promise<Project[]> {
  const rows = await db.select().from(schema.projects).orderBy(asc(schema.projects.name))
  return rows.map(toProject)
}

export async function findProjectBySlug(db: Executor, slug: string): Promise<ProjectRow> {
  const [row] = await db.select().from(schema.projects).where(eq(schema.projects.slug, slug))
  if (!row) throw notFound()
  return row
}

// design/project-settings.md: one PATCH on Save. Existing tasks keep their
// IDs when the prefix changes (the ref is computed from the current prefix,
// so they're renamed; see the open question there).
export async function patchProject(db: Executor, project: ProjectRow, input: PatchProjectInput, actor: Actor): Promise<Project> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(schema.projects).set({ ...input, updatedAt: new Date() }).where(eq(schema.projects.id, project.id)).returning()
    const changed = Object.keys(input)
    const event = input.paused === undefined || changed.length > 1
      ? auditEvent('project.updated', { changed })
      : input.paused ? auditEvent('project.paused', { changed }) : auditEvent('project.resumed', { changed })
    await appendAudit(tx, { projectId: project.id, actor }, event)
    return toProject(row!)
  })
}

// Uniqueness of slug, prefix and repository (D13) is enforced by the database
export async function createProject(db: Executor, input: CreateProjectInput, actor: Actor): Promise<Project> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.projects).values({
      name: input.name,
      slug: input.slug ?? slugify(input.name),
      prefix: input.prefix,
      repository: input.repository,
      defaultBranch: input.defaultBranch,
      ...(input.mergeMethod && { mergeMethod: input.mergeMethod }),
      ...(input.humanReviewDefault !== undefined && { humanReviewDefault: input.humanReviewDefault }),
      ...(input.epicReviewModeDefault && { epicReviewModeDefault: input.epicReviewModeDefault })
    }).returning()
    await appendAudit(tx, { projectId: row!.id, actor }, auditEvent('project.created', {}))
    return toProject(row!)
  })
}

// Content hashes version the URL without adding a second source of truth.
function thumbnailUrl(project: Pick<ProjectRow, 'slug' | 'thumbnailBlob'>): string | null {
  return project.thumbnailBlob ? `/api/projects/${encodeURIComponent(project.slug)}/thumbnail?v=${blobVersion(project.thumbnailBlob)}` : null
}

export async function setProjectThumbnail(db: Executor, project: ProjectRow, blob: string | null, actor: Actor): Promise<Project> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(schema.projects).set({ thumbnailBlob: blob, updatedAt: new Date() }).where(eq(schema.projects.id, project.id)).returning()
    await appendAudit(tx, { projectId: project.id, actor }, auditEvent('project.updated', { changed: ['thumbnailBlob'] }))
    return toProject(row!)
  })
}

// The project's next task number. Takes the project row lock, which is what
// keeps numbers sequential under concurrent creates.
export async function allocateTaskNumber(tx: Executor, projectId: string): Promise<number> {
  const [allocated] = await tx.update(schema.projects)
    .set({ nextTaskNumber: sql`${schema.projects.nextTaskNumber} + 1` })
    .where(eq(schema.projects.id, projectId))
    .returning({ number: sql<number>`${schema.projects.nextTaskNumber} - 1` })
  return allocated!.number
}
