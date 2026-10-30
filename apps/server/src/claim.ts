import { ACTIVE_RUN_STATES, LEASE_DURATION_MS, transition, type Actor, type TaskStatus } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, notInArray, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { toTaskState } from './tasks.ts'

const { agents, auditLog, projects, reviews, runs, epicDependencies, taskDependencies, tasks } = schema

const scheduler: Actor = { kind: 'system', component: 'scheduler' }

export interface Claim {
  taskId: string
  runId: string
  runNumber: number
  // The fencing token every write from this run must carry
  leaseEpoch: number
  leaseExpiresAt: Date
  status: TaskStatus
}

// Atomically gives an agent the next task to work on, or null if there's
// nothing eligible or the agent is at capacity (flows.md step 2).
//
// Developer runs pick up Ready tasks (→ In progress) and In progress tasks
// with no lease, e.g. after changes were requested (D10). Reviewer runs pick
// up Agent review tasks whose current commit has no verdict yet (flows.md
// step 6). Two claims can't take the same task: the candidate row is locked
// with SKIP LOCKED, so a parallel claim moves on to the next task instead of
// waiting for this one. Locking the agent row first means its concurrency
// limit can't be overshot either. This is only meaningful on Postgres; PGlite
// runs one transaction at a time (D14).
//
// `only` limits the claim to those tasks, for an agent still inside its
// wake interval that an event about them may start anyway. `skip` leaves
// those tasks out, e.g. ones whose run couldn't start earlier in the pass.
export async function claimNextTask(db: Executor, agentId: string, now = new Date(), only?: readonly string[], skip: readonly string[] = []): Promise<Claim | null> {
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
          // No verdict yet for the commit under review
          notExists(tx.select({ one: sql`1` }).from(reviews)
            .where(and(eq(reviews.taskId, tasks.id), eq(reviews.headSha, tasks.headSha))))
        )
    const [candidate] = await tx.select({ task: tasks })
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
      // Enum order: urgent first
      .orderBy(asc(tasks.priority), asc(tasks.createdAt))
      .limit(1)
      .for('update', { of: tasks, skipLocked: true })
    if (!candidate) return null
    const task = candidate.task

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

    return { taskId: task.id, runId: run!.id, runNumber: run!.number, leaseEpoch, leaseExpiresAt, status }
  })
}
