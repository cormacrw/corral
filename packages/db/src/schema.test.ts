import type { Actor } from '@corral/core'
import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import type { Database, DatabaseHandle } from './client.ts'
import { agents, attachments, epicDependencies, epics, projects, runs, taskDependencies, tasks } from './schema.ts'
import { createTestDatabase, databaseFixture } from './testing.ts'

const human: Actor = { kind: 'human', userId: '00000000-0000-4000-8000-000000000001' }

// The same checks run on PGlite everywhere and on Postgres when
// CORRAL_DATABASE_URL is set (CI), so the two drivers can't drift apart (D14)
describe.each([
  { driver: 'pglite' as const },
  { driver: 'postgres' as const }
])('schema on $driver', ({ driver }) => {
  let handle: DatabaseHandle
  let db: Database

  databaseFixture(driver, async () => {
    const opened = driver === 'pglite' ? await createTestDatabase('pglite') : await createTestDatabase('postgres')
    if (!opened) throw new Error('CORRAL_DATABASE_URL is set but no database was created')
    handle = opened
    db = handle.db
  })

  afterAll(async () => {
    await handle?.close()
  })

  let projectCount = 0
  async function insertProject(overrides: Partial<typeof projects.$inferInsert> = {}) {
    projectCount++
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const [project] = await db.insert(projects).values({
      name: `Project ${projectCount}`,
      slug: `project-${projectCount}`,
      prefix: `P${letters[projectCount % 26]}${letters[Math.floor(projectCount / 26) % 26]}`,
      repository: `owner/repo-${projectCount}`,
      defaultBranch: 'main',
      ...overrides
    }).returning()
    return project!
  }

  async function insertTask(projectId: string, number: number) {
    const [task] = await db.insert(tasks).values({
      projectId,
      number,
      title: `Task ${number}`,
      type: 'task',
      createdBy: human
    }).returning()
    return task!
  }

  // Postgres wraps the constraint error; the constraint name is on the cause
  async function expectViolation(promise: Promise<unknown>, constraint: string) {
    const error = await promise.then(() => null, (e: unknown) => e)
    expect(error, `expected ${constraint} to be violated`).not.toBeNull()
    const cause = (error as { cause?: { constraint?: string } }).cause
    expect(cause?.constraint ?? String(error)).toContain(constraint)
  }

  it('applies migrations to an empty database', async () => {
    // Both drivers return { rows }; the shared Database type can't say so
    const result = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`) as unknown as { rows: { table_name: string }[] }
    expect(result.rows.map(r => r.table_name)).toEqual([
      'acceptance_criteria', 'agents', 'attachments', 'audit_log', 'comments', 'deployments', 'design_versions', 'epic_dependencies', 'epics', 'evidence', 'plan_epics', 'plan_messages', 'plan_sessions', 'plan_tasks', 'plans',
      'projects', 'reviews', 'runs', 'settings', 'task_dependencies', 'task_design_pins', 'tasks', 'users'
    ])
  })

  it('constrains epic dependencies and cascades deletion of either epic', async () => {
    const project = await insertProject()
    const [a, b, c] = await db.insert(epics).values(['A', 'B', 'C'].map(title => ({
      projectId: project.id, title, createdBy: human
    }))).returning()
    const edge = { epicId: b!.id, dependsOnEpicId: a!.id }
    await db.insert(epicDependencies).values(edge)
    await expectViolation(db.insert(epicDependencies).values(edge), 'epic_dependencies_epic_id_depends_on_epic_id_pk')
    await expectViolation(db.insert(epicDependencies).values({ epicId: a!.id, dependsOnEpicId: a!.id }), 'epic_dependencies_not_self')
    await db.delete(epics).where(eq(epics.id, a!.id))
    expect(await db.select().from(epicDependencies).where(eq(epicDependencies.epicId, b!.id))).toEqual([])
    await db.insert(epicDependencies).values({ epicId: b!.id, dependsOnEpicId: c!.id })
    await db.delete(epics).where(eq(epics.id, b!.id))
    expect(await db.select().from(epicDependencies).where(eq(epicDependencies.dependsOnEpicId, c!.id))).toEqual([])
  })

  it('fills in project defaults', async () => {
    const project = await insertProject()
    expect(project).toMatchObject({
      nextTaskNumber: 1,
      mergeMethod: 'squash',
      requiredChecks: [],
      paused: false,
      humanReviewDefault: false,
      reviewRoundCap: 5,
      failedRunCap: 3
    })
  })

  it('lets only one project use a repository (D13)', async () => {
    await insertProject({ repository: 'owner/shared' })
    await expectViolation(insertProject({ repository: 'owner/shared' }), 'projects_repository_unique')
  })

  it('keeps task ID prefixes unique and 2–5 capital letters (D13)', async () => {
    await insertProject({ prefix: 'COR' })
    await expectViolation(insertProject({ prefix: 'COR' }), 'projects_prefix_unique')
    await expectViolation(insertProject({ prefix: 'cor' }), 'projects_prefix_format')
    await expectViolation(insertProject({ prefix: 'TOOLONG' }), 'projects_prefix_format')
  })

  it('numbers tasks per project', async () => {
    const a = await insertProject()
    const b = await insertProject()
    await insertTask(a.id, 1)
    await insertTask(b.id, 1)
    await expectViolation(insertTask(a.id, 1), 'tasks_project_number_unique')
  })

  it('starts tasks in Backlog with no lease', async () => {
    const task = await insertTask((await insertProject()).id, 1)
    expect(task).toMatchObject({
      status: 'backlog',
      priority: 'medium',
      reviewRounds: 0,
      failedRuns: 0,
      leaseEpoch: 0,
      leaseRunId: null,
      createdBy: human
    })
  })

  it('rejects a half-set lease', async () => {
    const project = await insertProject()
    const task = await insertTask(project.id, 1)
    const [agent] = await db.insert(agents).values({ name: `Atlas ${project.id}`, role: 'developer' }).returning()
    const [run] = await db.insert(runs).values({ agentId: agent!.id, projectId: project.id, taskId: task.id, role: 'developer' }).returning()

    await expectViolation(
      db.update(tasks).set({ leaseRunId: run!.id }).where(eq(tasks.id, task.id)),
      'tasks_lease_complete'
    )
    const [leased] = await db.update(tasks)
      .set({ leaseRunId: run!.id, leaseRole: 'developer', leaseExpiresAt: new Date(), leaseEpoch: 1 })
      .where(eq(tasks.id, task.id))
      .returning()
    expect(leased).toMatchObject({ leaseRunId: run!.id, leaseEpoch: 1 })
    expect(run!.number).toBeGreaterThan(0)
  })

  it('requires a task for every run except PM turns', async () => {
    const project = await insertProject()
    const [agent] = await db.insert(agents).values({ name: `Juno ${project.id}`, role: 'pm' }).returning()
    await db.insert(runs).values({ agentId: agent!.id, projectId: project.id, role: 'pm' })
    await expectViolation(
      db.insert(runs).values({ agentId: agent!.id, projectId: project.id, role: 'developer' }),
      'runs_task_unless_pm'
    )
  })

  it('rejects a task depending on itself', async () => {
    const task = await insertTask((await insertProject()).id, 1)
    await expectViolation(
      db.insert(taskDependencies).values({ taskId: task.id, dependsOnId: task.id }),
      'task_dependencies_not_self'
    )
  })

  it('removes a project\'s attachments with the project', async () => {
    const project = await insertProject()
    const other = await insertProject()
    const file = { blob: 'a'.repeat(64), mimeType: 'image/png', fileName: 'shot.png', byteSize: 10, createdBy: human }
    await db.insert(attachments).values([{ projectId: project.id, ...file }, { projectId: project.id, ...file }, { projectId: other.id, ...file }])
    await db.delete(projects).where(eq(projects.id, project.id))
    expect(await db.select().from(attachments).where(eq(attachments.projectId, project.id))).toEqual([])
    expect(await db.select().from(attachments).where(eq(attachments.projectId, other.id))).toHaveLength(1)
  })
})
