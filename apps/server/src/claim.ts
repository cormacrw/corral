import { ACTIVE_RUN_STATES, LEASE_DURATION_MS, transition, type Actor, type TaskStatus } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, ne, notInArray, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { toTaskState, type TaskRow } from './tasks.ts'

const { agents, auditLog, projects, reviews, runs, epicDependencies, taskDependencies, tasks } = schema

// How many candidate tasks a placing claim locks and tries at a time
export const PLACE_BATCH = 50

const scheduler: Actor = { kind: 'system', component: 'scheduler' }

export interface Claim {
  taskId: string
  runId: string
  runNumber: number
  // The fencing token every write from this run must carry
  leaseEpoch: number
  leaseExpiresAt: Date
  status: TaskStatus
  // Where the run goes; null only when the caller placed nothing
  runnerId: string | null
}

// Atomically gives an agent the next task to work on, or null if there's
// nothing eligible or the agent is at capacity (flows.md step 2).
//
// Developer runs pick up Ready tasks (→ In progress) and In progress tasks
// with no lease, e.g. after changes were requested (D10). Priority wins first,
// then In progress before Ready, then oldest createdAt and id. Reviewer runs pick
// up Agent review tasks with no verdict since their latest submission (flows.md
// step 6). Two claims can't take the same task: the candidate row is locked
// with SKIP LOCKED, so a parallel claim moves on to the next task instead of
// waiting for this one. Locking the agent row first means its concurrency
// limit can't be overshot either. This is only meaningful on Postgres; PGlite
// runs one transaction at a time (D14).
//
// `only` limits the claim to those tasks, for an agent still inside its
// wake interval that an event about them may start anyway. `skip` leaves
// those tasks out, e.g. ones whose run couldn't start earlier in the pass.
//
// `place` picks the runner for a candidate task, or null when none can take
// it now: that task is skipped without a lease and the next one is tried.
export type Place = (tx: Executor, task: TaskRow) => Promise<string | null>

export async function claimNextTask(db: Executor, agentId: string, now = new Date(), only?: readonly string[], skip: readonly string[] = [], place?: Place): Promise<Claim | null> {
  if (only?.length === 0) return null
  return db.transaction(async (tx) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
    if (!agent) throw new Error(`Unknown agent ${agentId}`)
    if (agent.role === 'pm') throw new Error('PM turns are not claimed; they run when the human sends a message (D9)')
    if (agent.paused || (agent.pausedUntil && agent.pausedUntil > now)) return null

    const [active] = await tx.select({ n: count() }).from(runs)
      .where(and(eq(runs.agentId, agentId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    if (active!.n >= agent.concurrency) return null

    const dependency = alias(tasks, 'dependency')
    const epicTask = alias(tasks, 'epic_task')
    const eligible = agent.role === 'developer'
      ? and(
          inArray(tasks.status, ['ready', 'in_progress']),
          // Every dependency Merged (D10: Ready tasks wait on them)
          notExists(tx.select({ one: sql`1` }).from(taskDependencies)
            .innerJoin(dependency, eq(dependency.id, taskDependencies.dependsOnId))
            .where(and(eq(taskDependencies.taskId, tasks.id), ne(dependency.status, 'merged')))),
          notExists(tx.select({ one: sql`1` }).from(epicDependencies)
            .innerJoin(epicTask, eq(epicTask.epicId, epicDependencies.dependsOnEpicId))
            .where(and(eq(epicDependencies.epicId, tasks.epicId), isNull(epicTask.deletedAt),
              notInArray(epicTask.status, ['draft', 'backlog', 'merged']))))
        )
      : and(
          eq(tasks.status, 'agent_review'),
          isNotNull(tasks.headSha),
          // A human resolving Blocked resets the round counter (D10), so
          // even this head and round may have a verdict from an older submission.
          // Use existing history so already-stranded tasks recover too.
          notExists(tx.select({ one: sql`1` }).from(reviews)
            .where(and(eq(reviews.taskId, tasks.id), eq(reviews.headSha, tasks.headSha), eq(reviews.round, tasks.reviewRounds),
              notExists(tx.select({ one: sql`1` }).from(auditLog).where(and(
                eq(auditLog.taskId, tasks.id),
                eq(auditLog.action, 'task.transition'),
                sql`${auditLog.detail}->>'from' = 'in_progress'`,
                sql`${auditLog.detail}->>'to' = 'agent_review'`,
                gt(auditLog.createdAt, reviews.createdAt)
              ))))))
        )
    const batch = (offset: number) => tx.select({ task: tasks })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(
        eligible,
        only && inArray(tasks.id, [...only]),
        skip.length > 0 ? notInArray(tasks.id, [...skip]) : undefined,
        isNull(tasks.leaseRunId),
        isNull(tasks.deletedAt),
        eq(tasks.paused, false),
        eq(projects.paused, false)
      ))
      // Priority enum: urgent first. The explicit status rank avoids enum order;
      // createdAt and id keep each status group stable across placement pages.
      .orderBy(asc(tasks.priority), ...(agent.role === 'developer'
        ? [asc(sql`case when ${tasks.status} = 'in_progress' then 0 else 1 end`)]
        : []), asc(tasks.createdAt), asc(tasks.id))
      .limit(place ? PLACE_BATCH : 1)
      .offset(offset)
      .for('update', { of: tasks, skipLocked: true })
    let task: TaskRow | null = null
    let runnerId: string | null = null
    // Without placement the first candidate wins. With it, tasks no runner
    // can take now are skipped, and the scan carries on past them batch by
    // batch so that a long line of waiting tasks can't hide placeable work.
    // Rows this transaction already locked stay visible to it, so the offset
    // walks the same ordering.
    for (let offset = 0; !task; offset += PLACE_BATCH) {
      const candidates = await batch(offset)
      for (const candidate of candidates) {
        runnerId = place ? await place(tx, candidate.task) : null
        if (place && !runnerId) continue
        task = candidate.task
        break
      }
      if (!place || candidates.length < PLACE_BATCH) break
    }
    if (!task) return null

    // Ready → In progress goes through core like every status change; an
    // In progress or Agent review task keeps its status and just gets a lease
    let status = task.status
    if (task.status === 'ready') {
      // The query only returns tasks whose dependencies are all Merged
      const result = transition(toTaskState(task), { type: 'claim', dependencyStatuses: [] }, scheduler)
      if (!result.ok) throw new Error(`Claim rejected by core: ${result.error.code}`)
      status = result.task.status
    }

    const leaseEpoch = task.leaseEpoch + 1
    const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS)
    const [run] = await tx.insert(runs).values({
      agentId,
      projectId: task.projectId,
      taskId: task.id,
      role: agent.role,
      runnerId,
      leaseEpoch,
      queuedAt: now
    }).returning()

    await tx.update(tasks).set({
      status,
      leaseEpoch,
      leaseRunId: run!.id,
      leaseRole: agent.role,
      leaseAcquiredAt: now,
      leaseHeartbeatAt: now,
      leaseExpiresAt,
      updatedAt: now
    }).where(eq(tasks.id, task.id))

    await tx.insert(auditLog).values({
      projectId: task.projectId,
      taskId: task.id,
      actor: scheduler,
      action: 'task.claimed',
      detail: { runId: run!.id, agentId, leaseEpoch, from: task.status, to: status }
    })

    return { taskId: task.id, runId: run!.id, runNumber: run!.number, leaseEpoch, leaseExpiresAt, status, runnerId }
  })
}
