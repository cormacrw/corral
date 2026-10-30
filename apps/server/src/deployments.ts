import type { CreateDeploymentInput, Deployment } from '@corral/contracts'
import { schema, type Executor } from '@corral/db'
import { and, eq, sql } from 'drizzle-orm'
import { ApiFailure } from './errors.ts'

const { deployments, projects } = schema

function toDeployment(row: typeof deployments.$inferSelect): Deployment {
  return {
    id: row.id,
    projectId: row.projectId,
    fromSha: row.fromSha,
    toSha: row.toSha,
    commits: row.commits,
    notes: row.notes,
    notesStatus: row.notesStatus,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  }
}

// Records what a deploy shipped (D16). The project is found by its GitHub
// repository, ignoring case as GitHub does. A toSha already recorded for the
// project returns that record unchanged, so the deploy script can retry.
export async function recordDeployment(db: Executor, input: CreateDeploymentInput): Promise<{ deployment: Deployment, created: boolean }> {
  const [project] = await db.select({ id: projects.id }).from(projects)
    .where(sql`lower(${projects.repository}) = ${input.repository.toLowerCase()}`)
  if (!project) throw new ApiFailure(404, { code: 'not_found' })
  const [inserted] = await db.insert(deployments)
    .values({ projectId: project.id, fromSha: input.fromSha, toSha: input.toSha, commits: input.commits })
    .onConflictDoNothing({ target: [deployments.projectId, deployments.toSha] })
    .returning()
  if (inserted) return { deployment: toDeployment(inserted), created: true }
  const [existing] = await db.select().from(deployments)
    .where(and(eq(deployments.projectId, project.id), eq(deployments.toSha, input.toSha)))
  return { deployment: toDeployment(existing!), created: false }
}
