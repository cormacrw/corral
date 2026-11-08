import { schema, type Executor } from '@corral/db'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'

const { planEpics, planSessions, planTasks, plans } = schema

// Plan items and parents a human added, which a PM's revision never touches
export const HUMAN_PLAN_KEY = 'human-'

// The Plan session each Draft belongs to: the session of the latest proposed
// plan version that includes it, so a plan in another session that revises
// it by ref takes it over. A Draft no proposed plan includes falls back to
// the latest plan that does, so it's never orphaned.
export async function draftSessions(db: Executor, taskIds: string[]): Promise<Map<string, { id: string, title: string }>> {
  const owners = new Map<string, { id: string, title: string }>()
  if (taskIds.length === 0) return owners
  const rows = await db.select({ taskId: planTasks.taskId, id: planSessions.id, title: planSessions.title })
    .from(planTasks)
    .innerJoin(plans, eq(plans.id, planTasks.planId))
    .innerJoin(planSessions, eq(planSessions.id, plans.sessionId))
    .where(and(inArray(planTasks.taskId, taskIds), ne(planTasks.change, 'removed')))
    .orderBy(desc(sql`${plans.status} = 'proposed'`), desc(plans.createdAt), desc(plans.version))
  for (const row of rows) {
    if (row.taskId && !owners.has(row.taskId)) owners.set(row.taskId, { id: row.id, title: row.title })
  }
  return owners
}

// The plan's parent item for `epicId`, unless it has one
async function addParentItem(tx: Executor, planId: string, epicId: string): Promise<void> {
  const [known] = await tx.select({ key: planEpics.key }).from(planEpics).where(and(eq(planEpics.planId, planId), eq(planEpics.epicId, epicId)))
  if (known) return
  const [{ position } = { position: 0 }] = await tx.select({ position: sql<number>`coalesce(max(${planEpics.position}) + 1, 0)` }).from(planEpics).where(eq(planEpics.planId, planId))
  await tx.insert(planEpics).values({ planId, key: `${HUMAN_PLAN_KEY}parent-${epicId}`, epicId, position })
}

const proposedPlans = (tx: Executor) => tx.select({ id: plans.id }).from(plans).where(eq(plans.status, 'proposed'))

// A Draft belongs to its plan, so sub-tasks made from one stay Drafts in that
// plan: approving it adds them to the board and discarding it removes them.
// `subId` joins the plan holding `draftId` as a new item, under the parent.
// False when no proposed plan holds the Draft.
export async function joinDraftPlan(tx: Executor, epicId: string, subId: string, draftId: string): Promise<boolean> {
  const [plan] = await tx.select({ planId: planTasks.planId }).from(planTasks).where(and(eq(planTasks.taskId, draftId), inArray(planTasks.planId, proposedPlans(tx))))
  if (!plan) return false
  if (draftId === subId) return true
  const [{ next } = { next: 0 }] = await tx.select({ next: sql<number>`coalesce(max(${planTasks.position}) + 1, 0)` }).from(planTasks).where(eq(planTasks.planId, plan.planId))
  await tx.insert(planTasks).values({ planId: plan.planId, taskId: subId, key: `${HUMAN_PLAN_KEY}${subId}`, change: 'added', position: next })
  await addParentItem(tx, plan.planId, epicId)
  return true
}

// A Draft that gains subtasks hands its plan item to its first one, which the
// plan then shows under the new parent. False when no proposed plan holds it.
export async function handDraftToSubtask(tx: Executor, epicId: string, draftId: string, subId: string): Promise<boolean> {
  await tx.update(planTasks).set({ taskId: subId, key: `${HUMAN_PLAN_KEY}${subId}` }).where(and(eq(planTasks.taskId, draftId), inArray(planTasks.planId, proposedPlans(tx))))
  const [plan] = await tx.select({ planId: planTasks.planId }).from(planTasks).where(eq(planTasks.taskId, subId)).limit(1)
  if (!plan) return false
  await addParentItem(tx, plan.planId, epicId)
  return true
}
