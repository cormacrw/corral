import type { CreateProjectInput, PatchProjectInput, Project } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { asc, eq } from 'drizzle-orm'
import { notFound } from './errors.ts'

type ProjectRow = typeof schema.projects.$inferSelect

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    prefix: row.prefix,
    thumbnailColor: row.thumbnailColor,
    nextTaskNumber: row.nextTaskNumber,
    repository: row.repository,
    defaultBranch: row.defaultBranch,
    mergeMethod: row.mergeMethod,
    requiredChecks: row.requiredChecks,
    paused: row.paused,
    humanReviewDefault: row.humanReviewDefault,
    reviewRoundCap: row.reviewRoundCap,
    failedRunCap: row.failedRunCap,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
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
    await tx.insert(schema.auditLog).values({
      projectId: project.id,
      actor,
      action: input.paused !== undefined && changed.length === 1 ? (input.paused ? 'project.paused' : 'project.resumed') : 'project.updated',
      detail: { changed }
    })
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
      ...(input.humanReviewDefault !== undefined && { humanReviewDefault: input.humanReviewDefault })
    }).returning()
    await tx.insert(schema.auditLog).values({ projectId: row!.id, actor, action: 'project.created', detail: {} })
    return toProject(row!)
  })
}
