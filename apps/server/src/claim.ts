import { ACTIVE_RUN_STATES, LEASE_DURATION_MS, transition, type Actor, type TaskStatus } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, count, eq, inArray, isNull, ne, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { toTaskState } from './tasks.ts'

const { agents, auditLog, projects, runs, taskDependencies, tasks } = schema

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

// Atomically gives a developer agent the next task to work on, or null if
// there's nothing eligible or the agent is at capacity (flows.md step 2).
//
// Developer runs pick up Ready tasks (→ In progress) and In progress tasks
// with no lease, e.g. after changes were requested (D10). Two claims can't take
// the same task: the candidate row is locked with SKIP LOCKED, so a parallel
// claim moves on to the next task instead of waiting for this one. Locking
// the agent row first means its concurrency limit can't be overshot either.
// This is only meaningful on Postgres; PGlite runs one transaction at a time (D14).
export async function claimNextTask(db: Executor, agentId: string, now = new Date()): Promise<Claim | null> {
  return db.transaction(async (tx) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
    if (!agent) throw new Error(`Unknown agent ${agentId}`)
    // Reviewer claims need review verdicts per commit, which arrive with the reviewer
    if (agent.role !== 'developer') throw new Error(`claimNextTask only handles developer agents, not ${agent.role}`)
    if (agent.paused || (agent.pausedUntil && agent.pausedUntil > now)) return null

    const [active] = await tx.select({ n: count() }).from(runs)
      .where(and(eq(runs.agentId, agentId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    if (active!.n >= agent.concurrency) return null

    const dependency = alias(tasks, 'dependency')
    const [candidate] = await tx.select({ task: tasks })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(
        inArray(tasks.status, ['ready', 'in_progress']),
        isNull(tasks.leaseRunId),
        isNull(tasks.deletedAt),
        eq(tasks.paused, false),
        eq(projects.paused, false),
        // Every dependency Merged (D10: Ready tasks wait on them)
        notExists(tx.select({ one: sql`1` }).from(taskDependencies)
          .innerJoin(dependency, eq(dependency.id, taskDependencies.dependsOnId))
          .where(and(eq(taskDependencies.taskId, tasks.id), ne(dependency.status, 'merged'))))
      ))
      // Enum order: urgent first
      .orderBy(asc(tasks.priority), asc(tasks.createdAt))
      .limit(1)
      .for('update', { of: tasks, skipLocked: true })
    if (!candidate) return null
    const task = candidate.task

    // Ready → In progress goes through core like every status change; an
    // In progress task keeps its status and just gets a lease
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
      role: 'developer',
      leaseEpoch,
      queuedAt: now
    }).returning()

    await tx.update(tasks).set({
      status,
      leaseEpoch,
      leaseRunId: run!.id,
      leaseRole: 'developer',
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
