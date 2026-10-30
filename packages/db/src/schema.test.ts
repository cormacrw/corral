import type { Actor } from '@corral/core'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database, DatabaseHandle } from './client.ts'
import { agents, attachments, epicDependencies, epics, planEpics, planMessages, planSessions, planTasks, plans, projects, runs, taskDependencies, tasks, users } from './schema.ts'
import { createTestDatabase, postgresAvailable } from './testing.ts'

const human: Actor = { kind: 'human', userId: '00000000-0000-4000-8000-000000000001' }

// The same checks run on PGlite everywhere and on Postgres when
// CORRAL_DATABASE_URL is set (CI), so the two drivers can't drift apart (D14)
describe.each([
  { driver: 'pglite' as const, enabled: true },
  { driver: 'postgres' as const, enabled: postgresAvailable }
])('schema on $driver', ({ driver, enabled }) => {
  let handle: DatabaseHandle
  let db: Database

  beforeAll(async () => {
    if (!enabled) return
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

  it.skipIf(!enabled)('requires both avatar columns on inserts and updates for users and agents', async () => {
    for (const table of [users, agents]) {
      const base = { name: 'Avatar owner', role: 'developer' as const }
      const constraint = table === users ? 'users_avatar_paired' : 'agents_avatar_paired'
      await expectViolation(db.insert(table).values({ ...base, avatarBlob: 'image' }), constraint)
      await expectViolation(db.insert(table).values({ ...base, avatarContentType: 'image/png' }), constraint)
      const [row] = await db.insert(table).values(base).returning()
      await db.update(table).set({ avatarBlob: 'image', avatarContentType: 'image/png' }).where(eq(table.id, row!.id))
      await expectViolation(db.update(table).set({ avatarBlob: null }).where(eq(table.id, row!.id)), constraint)
      await expectViolation(db.update(table).set({ avatarContentType: null }).where(eq(table.id, row!.id)), constraint)
      await db.update(table).set({ avatarBlob: 'replacement', avatarContentType: 'image/jpeg' }).where(eq(table.id, row!.id))
      await db.update(table).set({ avatarBlob: null, avatarContentType: null }).where(eq(table.id, row!.id))
    }
  })

  it.skipIf(!enabled)('checks approval tuples and preserves approval when superseded', async () => {
    const project = await insertProject()
    const [session] = await db.insert(planSessions).values({ projectId: project.id, title: 'Plan', createdBy: human }).returning()
    const base = { sessionId: session!.id, projectId: project.id, title: 'Plan', version: 1 }
    const insert = (values: Partial<typeof plans.$inferInsert>) => db.insert(plans).values({ ...base, ...values })
    await expectViolation(insert({ status: 'approved' }), 'plans_approval_tuple')
    await expectViolation(insert({ status: 'approved', approvedBy: human }), 'plans_approval_tuple')
    await expectViolation(insert({ status: 'approved', approvedAt: new Date() }), 'plans_approval_tuple')
    await expectViolation(insert({ approvedBy: human }), 'plans_approval_tuple')
    const approvedAt = new Date('2026-10-30T12:00:00Z')
    const [approved] = await db.insert(plans).values({ ...base, status: 'approved', approvedBy: human, approvedAt }).returning()
    await expectViolation(db.update(plans).set({ approvedAt: null }).where(eq(plans.id, approved!.id)), 'plans_approval_tuple')
    await db.update(plans).set({ status: 'superseded' }).where(eq(plans.id, approved!.id))
    expect((await db.select().from(plans).where(eq(plans.id, approved!.id)))[0]).toMatchObject({ status: 'superseded', approvedBy: human, approvedAt })
    await insert({ version: 2, status: 'superseded' })
    await insert({ version: 3, status: 'discarded' })
  })

  it.skipIf(!enabled)('allows staged revisions on active diffs and retains nullable deleted references', async () => {
    const project = await insertProject()
    const task = await insertTask(project.id, 1)
    const [epic] = await db.insert(epics).values({ projectId: project.id, title: 'Epic', createdBy: human }).returning()
    const [session] = await db.insert(planSessions).values({ projectId: project.id, title: 'Plan', createdBy: human }).returning()
    const [plan] = await db.insert(plans).values({ sessionId: session!.id, projectId: project.id, epicId: epic!.id, version: 1, title: 'Plan' }).returning()
    const revision = { title: 'Staged', description: '', type: 'task' as const, priority: 'medium' as const, humanReview: false, acceptanceCriteria: [], epicId: epic!.id, dependsOn: [] }
    for (const change of ['added', 'changed', 'unchanged'] as const) {
      await db.insert(planTasks).values({ planId: plan!.id, key: change, taskId: task.id, change, position: 0, revision })
    }
    await expectViolation(db.insert(planTasks).values({ planId: plan!.id, key: 'bad', change: 'removed', position: 0, revision }), 'plan_tasks_revision_change')
    await expectViolation(db.update(planTasks).set({ change: 'removed' }).where(eq(planTasks.key, 'added')), 'plan_tasks_revision_change')
    await db.insert(planTasks).values({ planId: plan!.id, key: 'removed', change: 'removed', position: 3 })
    await db.insert(planEpics).values({ planId: plan!.id, key: 'epic', epicId: epic!.id, position: 0 })
    await db.delete(tasks).where(eq(tasks.id, task.id))
    await db.delete(epics).where(eq(epics.id, epic!.id))
    const items = await db.select().from(planTasks).where(eq(planTasks.planId, plan!.id))
    expect(items).toHaveLength(4)
    expect(items.every(item => item.taskId === null)).toBe(true)
    expect(items.filter(item => item.revision !== null)).toHaveLength(3)
    expect((await db.select().from(planEpics).where(eq(planEpics.planId, plan!.id)))[0]!.epicId).toBeNull()
  })

  it.skipIf(!enabled)('keeps plan message roles, kinds and question fields consistent on new rows, without validating history', async () => {
    const project = await insertProject()
    const [session] = await db.insert(planSessions).values({ projectId: project.id, title: 'Plan', createdBy: human }).returning()
    const message = (values: Partial<typeof planMessages.$inferInsert>) => db.insert(planMessages).values({ sessionId: session!.id, role: 'pm', text: 'Hello', ...values })

    await message({ role: 'human' })
    await message({ kind: 'error' })
    await message({ kind: 'question', recommendation: 'Yes', options: ['Yes', 'No'] })
    await expectViolation(message({ role: 'system' as 'pm' }), 'plan_messages_role_kind')
    await expectViolation(message({ kind: 'note' as 'message' }), 'plan_messages_role_kind')
    await expectViolation(message({ role: 'human', kind: 'question' }), 'plan_messages_role_kind')
    await expectViolation(message({ role: 'human', recommendation: 'Yes' }), 'plan_messages_question_fields')
    await expectViolation(message({ role: 'human', options: ['Yes', 'No'] }), 'plan_messages_question_fields')
    await expectViolation(message({ kind: 'error', recommendation: 'Yes' }), 'plan_messages_question_fields')

    const constraints = await db.execute(sql`
      select conname, convalidated from pg_constraint
      where conrelid = 'plan_messages'::regclass and contype = 'c' order by conname`) as unknown as { rows: { conname: string, convalidated: boolean }[] }
    expect(constraints.rows).toEqual([
      { conname: 'plan_messages_question_fields', convalidated: false },
      { conname: 'plan_messages_role_kind', convalidated: false }
    ])
  })

  it.skipIf(!enabled)('applies migrations to an empty database', async () => {
    // Both drivers return { rows }; the shared Database type can't say so
    const result = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`) as unknown as { rows: { table_name: string }[] }
    expect(result.rows.map(r => r.table_name)).toEqual([
      'acceptance_criteria', 'agents', 'attachments', 'audit_log', 'comments', 'deployments', 'design_versions', 'epic_dependencies', 'epics', 'evidence', 'plan_epics', 'plan_messages', 'plan_sessions', 'plan_tasks', 'plans',
      'projects', 'reviews', 'runs', 'settings', 'task_dependencies', 'task_design_pins', 'tasks', 'users'
    ])
  })

  it.skipIf(!enabled)('constrains epic dependencies and cascades deletion of either epic', async () => {
    const project = await insertProject()
    const [a, b, c] = await db.insert(epics).values(['A', 'B', 'C'].map(title => ({
      projectId: project.id, title, createdBy: human
    }))).returning()
    const edge = { projectId: project.id, epicId: b!.id, dependsOnEpicId: a!.id }
    await db.insert(epicDependencies).values(edge)
    await expectViolation(db.insert(epicDependencies).values(edge), 'epic_dependencies_epic_id_depends_on_epic_id_pk')
    await expectViolation(db.insert(epicDependencies).values({ projectId: project.id, epicId: a!.id, dependsOnEpicId: a!.id }), 'epic_dependencies_not_self')
    await db.delete(epics).where(eq(epics.id, a!.id))
    expect(await db.select().from(epicDependencies).where(eq(epicDependencies.epicId, b!.id))).toEqual([])
    await db.insert(epicDependencies).values({ projectId: project.id, epicId: b!.id, dependsOnEpicId: c!.id })
    await db.delete(epics).where(eq(epics.id, b!.id))
    expect(await db.select().from(epicDependencies).where(eq(epicDependencies.dependsOnEpicId, c!.id))).toEqual([])
  })

  it.skipIf(!enabled)('fills in project defaults', async () => {
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

  it.skipIf(!enabled)('lets only one project use a repository (D13)', async () => {
    await insertProject({ repository: 'owner/shared' })
    await expectViolation(insertProject({ repository: 'owner/shared' }), 'projects_repository_unique')
  })

  it.skipIf(!enabled)('keeps task ID prefixes unique and 2–5 capital letters (D13)', async () => {
    await insertProject({ prefix: 'COR' })
    await expectViolation(insertProject({ prefix: 'COR' }), 'projects_prefix_unique')
    await expectViolation(insertProject({ prefix: 'cor' }), 'projects_prefix_format')
    await expectViolation(insertProject({ prefix: 'TOOLONG' }), 'projects_prefix_format')
  })

  it.skipIf(!enabled)('numbers tasks per project', async () => {
    const a = await insertProject()
    const b = await insertProject()
    await insertTask(a.id, 1)
    await insertTask(b.id, 1)
    await expectViolation(insertTask(a.id, 1), 'tasks_project_number_unique')
  })

  it.skipIf(!enabled)('starts tasks in Backlog with no lease', async () => {
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

  it.skipIf(!enabled)('requires reasons only for blocked and failed tasks, including direct writes', async () => {
    const task = await insertTask((await insertProject()).id, 1)
    for (const status of ['blocked', 'failed'] as const) {
      for (const statusReason of [null, '', ' ', '\t\r\n', '\u00a0\u2003\ufeff']) {
        await expectViolation(db.update(tasks).set({ status, statusReason }).where(eq(tasks.id, task.id)), 'tasks_status_reason')
      }
      await db.update(tasks).set({ status, statusReason: 'Human decision needed' }).where(eq(tasks.id, task.id))
      await expectViolation(db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, task.id)), 'tasks_status_reason')
      await db.update(tasks).set({ status: 'ready', statusReason: null }).where(eq(tasks.id, task.id))
    }
  })

  it.skipIf(!enabled)('requires complete PR pairs without requiring a PR or a lease for a status', async () => {
    const task = await insertTask((await insertProject()).id, 1)
    await expectViolation(db.update(tasks).set({ prNumber: 123 }).where(eq(tasks.id, task.id)), 'tasks_pr_complete')
    await expectViolation(db.update(tasks).set({ prUrl: 'https://github.com/cormacrw/test-app/pull/123' }).where(eq(tasks.id, task.id)), 'tasks_pr_complete')
    await db.update(tasks).set({ prNumber: 123, prUrl: 'https://github.com/cormacrw/test-app/pull/123' }).where(eq(tasks.id, task.id))
    await expectViolation(db.update(tasks).set({ prNumber: null }).where(eq(tasks.id, task.id)), 'tasks_pr_complete')
    await db.update(tasks).set({ status: 'in_progress', prNumber: null, prUrl: null }).where(eq(tasks.id, task.id))
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'in_progress', leaseRunId: null })
    for (const type of ['spike', 'design'] as const) {
      await db.update(tasks).set({ status: 'merged', type }).where(eq(tasks.id, task.id))
      expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'merged', type, prNumber: null, prUrl: null })
    }
  })

  it.skipIf(!enabled)('rejects a half-set lease', async () => {
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

  it.skipIf(!enabled)('requires a task for every run except PM turns', async () => {
    const project = await insertProject()
    const [agent] = await db.insert(agents).values({ name: `Juno ${project.id}`, role: 'pm' }).returning()
    await db.insert(runs).values({ agentId: agent!.id, projectId: project.id, role: 'pm' })
    await expectViolation(
      db.insert(runs).values({ agentId: agent!.id, projectId: project.id, role: 'developer' }),
      'runs_task_unless_pm'
    )
  })

  it.skipIf(!enabled)('rejects a task depending on itself', async () => {
    const task = await insertTask((await insertProject()).id, 1)
    await expectViolation(
      db.insert(taskDependencies).values({ projectId: task.projectId, taskId: task.id, dependsOnId: task.id }),
      'task_dependencies_not_self'
    )
  })

  it.skipIf(!enabled)('keeps epic membership and dependency edges inside one project', async () => {
    const [a, b] = [await insertProject(), await insertProject()]
    const [epicA, otherEpicA] = await db.insert(epics).values(['A1', 'A2'].map(title => ({ projectId: a.id, title, createdBy: human }))).returning()
    const [epicB] = await db.insert(epics).values({ projectId: b.id, title: 'B', createdBy: human }).returning()
    const [taskA, otherTaskA, taskB] = [await insertTask(a.id, 1), await insertTask(a.id, 2), await insertTask(b.id, 1)]

    await expectViolation(db.update(tasks).set({ epicId: epicB!.id }).where(eq(tasks.id, taskA.id)), 'tasks_epic_same_project_fk')
    await expectViolation(db.insert(tasks).values({ projectId: a.id, number: 3, epicId: epicB!.id, title: 'T', type: 'task', createdBy: human }), 'tasks_epic_same_project_fk')
    // Whichever project an edge claims, one of its ends is outside it
    for (const projectId of [a.id, b.id]) {
      await expectViolation(db.insert(taskDependencies).values({ projectId, taskId: taskA.id, dependsOnId: taskB.id }), projectId === a.id ? 'task_dependencies_depends_on_same_project_fk' : 'task_dependencies_task_same_project_fk')
      await expectViolation(db.insert(epicDependencies).values({ projectId, epicId: epicA!.id, dependsOnEpicId: epicB!.id }), projectId === a.id ? 'epic_dependencies_depends_on_same_project_fk' : 'epic_dependencies_epic_same_project_fk')
    }
    // A task can't leave for another project with its epic or edges behind
    await db.update(tasks).set({ epicId: epicA!.id }).where(eq(tasks.id, taskA.id))
    await expectViolation(db.update(tasks).set({ projectId: b.id, number: 9 }).where(eq(tasks.id, taskA.id)), 'tasks_epic_same_project_fk')

    // Tasks in different epics of one project can depend on each other
    await db.update(tasks).set({ epicId: otherEpicA!.id }).where(eq(tasks.id, otherTaskA.id))
    await db.insert(taskDependencies).values({ projectId: a.id, taskId: taskA.id, dependsOnId: otherTaskA.id })
    await db.insert(epicDependencies).values({ projectId: a.id, epicId: epicA!.id, dependsOnEpicId: otherEpicA!.id })
  })

  it.skipIf(!enabled)('nulls only the epic when an epic goes, and cascades edges and projects', async () => {
    const project = await insertProject()
    const [epic] = await db.insert(epics).values({ projectId: project.id, title: 'E', createdBy: human }).returning()
    const [first, second, third] = [await insertTask(project.id, 1), await insertTask(project.id, 2), await insertTask(project.id, 3)]
    await db.update(tasks).set({ epicId: epic!.id }).where(eq(tasks.id, first.id))
    await db.insert(taskDependencies).values([
      { projectId: project.id, taskId: first.id, dependsOnId: second.id },
      { projectId: project.id, taskId: second.id, dependsOnId: third.id }
    ])

    await db.delete(epics).where(eq(epics.id, epic!.id))
    const [kept] = await db.select().from(tasks).where(eq(tasks.id, first.id))
    expect(kept).toMatchObject({ epicId: null, projectId: project.id })

    // Either end of an edge
    await db.delete(tasks).where(eq(tasks.id, third.id))
    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.taskId, second.id))).toEqual([])
    await db.delete(tasks).where(eq(tasks.id, first.id))
    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.projectId, project.id))).toEqual([])

    // A whole project, with an epic that still holds a task and an edge
    const [left, right] = await db.insert(epics).values(['L', 'R'].map(title => ({ projectId: project.id, title, createdBy: human }))).returning()
    await db.insert(epicDependencies).values({ projectId: project.id, epicId: left!.id, dependsOnEpicId: right!.id })
    await db.update(tasks).set({ epicId: left!.id }).where(eq(tasks.id, second.id))
    await db.delete(projects).where(eq(projects.id, project.id))
    expect(await db.select().from(tasks).where(eq(tasks.projectId, project.id))).toEqual([])
    expect(await db.select().from(epics).where(eq(epics.projectId, project.id))).toEqual([])
    expect(await db.select().from(epicDependencies).where(eq(epicDependencies.projectId, project.id))).toEqual([])
  })

  it.skipIf(!enabled)('removes a project\'s attachments with the project', async () => {
    const project = await insertProject()
    const other = await insertProject()
    const file = { blob: 'a'.repeat(64), mimeType: 'image/png', fileName: 'shot.png', byteSize: 10, createdBy: human }
    await db.insert(attachments).values([{ projectId: project.id, ...file }, { projectId: project.id, ...file }, { projectId: other.id, ...file }])
    await db.delete(projects).where(eq(projects.id, project.id))
    expect(await db.select().from(attachments).where(eq(attachments.projectId, project.id))).toEqual([])
    expect(await db.select().from(attachments).where(eq(attachments.projectId, other.id))).toHaveLength(1)
  })
})
