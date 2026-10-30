import type { Agent, CreateAgentInput, Evidence, PatchAgentInput, Review, Run } from '@corral/contracts'
import { ACTIVE_RUN_STATES, taskRef, type Actor, type RunState } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { ApiFailure, notFound } from './errors.ts'
import { avatarUrl } from './avatars.ts'

const { agents, auditLog, evidence, projects, reviews, runs, tasks } = schema

const runColumns = {
  run: runs,
  agentName: agents.name,
  prefix: projects.prefix,
  taskNumber: tasks.number,
  taskTitle: tasks.title
}

type RunJoin = {
  run: typeof runs.$inferSelect
  agentName: string
  prefix: string | null
  taskNumber: number | null
  taskTitle: string | null
}

function toRun({ run, agentName, prefix, taskNumber, taskTitle }: RunJoin): Run {
  return {
    id: run.id,
    runnerId: run.runnerId,
    runnerName: run.runnerName,
    number: run.number,
    agentId: run.agentId,
    agentName,
    role: run.role,
    projectId: run.projectId,
    taskId: run.taskId,
    taskRef: taskNumber === null ? null : taskRef(prefix!, taskNumber),
    taskTitle,
    state: run.state,
    outcome: run.outcome,
    summary: run.summary,
    error: run.error,
    headSha: run.headSha,
    inputTokens: run.inputTokens,
    cacheReadTokens: run.cacheReadTokens,
    outputTokens: run.outputTokens,
    rateLimitResetAt: run.rateLimitResetAt?.toISOString() ?? null,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null
  }
}

export async function listRuns(db: Executor, filter: { agentId?: string, taskId?: string, projectId?: string, state?: RunState, active?: boolean }, limit = 50): Promise<Run[]> {
  const where: SQL[] = []
  if (filter.agentId) where.push(eq(runs.agentId, filter.agentId))
  if (filter.taskId) where.push(eq(runs.taskId, filter.taskId))
  if (filter.projectId) where.push(eq(runs.projectId, filter.projectId))
  if (filter.state) where.push(eq(runs.state, filter.state))
  if (filter.active) where.push(inArray(runs.state, [...ACTIVE_RUN_STATES]))
  const rows = await db.select(runColumns).from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(...where))
    .orderBy(desc(runs.number))
    .limit(limit)
  return rows.map(toRun)
}

export async function getRun(db: Executor, runId: string): Promise<Run> {
  const [row] = await db.select(runColumns).from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId))
  if (!row) throw notFound()
  return toRun(row)
}

export async function listAgents(db: Executor): Promise<Agent[]> {
  // PM, developer, reviewer, then by age: the default agents share one
  // creation time, so that alone would let them shuffle
  const order = { pm: 0, developer: 1, reviewer: 2 } as const
  const rows = (await db.select().from(agents).orderBy(agents.createdAt, agents.name)).sort((a, b) => order[a.role] - order[b.role])
  const active = await db.select({ agentId: runs.agentId, n: count() }).from(runs)
    .where(inArray(runs.state, [...ACTIVE_RUN_STATES]))
    .groupBy(runs.agentId)
  return rows.map(a => ({
    id: a.id,
    name: a.name,
    role: a.role,
    runtime: a.runtime,
    concurrency: a.concurrency,
    paused: a.paused,
    wakeIntervalSeconds: a.wakeIntervalSeconds,
    pausedUntil: a.pausedUntil?.toISOString() ?? null,
    activeRuns: active.find(x => x.agentId === a.id)?.n ?? 0,
    avatarUrl: avatarUrl(`agents/${a.id}`, a.avatarBlob)
  }))
}

export function toEvidence(row: typeof evidence.$inferSelect): Evidence {
  return {
    id: row.id,
    taskId: row.taskId,
    criterionId: row.criterionId,
    runId: row.runId,
    round: row.round,
    kind: row.kind,
    note: row.note,
    fileName: row.fileName,
    contentType: row.contentType,
    size: row.size,
    url: row.blob ? `/api/evidence/${row.id}/file` : null,
    createdAt: row.createdAt.toISOString()
  }
}

// A new developer or reviewer (design/settings.md). The scheduler treats it
// like the defaults: any free agent of the role claims the next task.
export async function createAgent(db: Executor, input: CreateAgentInput, actor: Actor): Promise<Agent> {
  const [row] = await db.insert(agents).values(input).returning()
  await db.insert(auditLog).values({ actor, action: 'agent.created', detail: { agentId: row!.id, role: row!.role, runtime: row!.runtime } })
  return (await listAgents(db)).find(a => a.id === row!.id)!
}

// Agent pause, concurrency, wake interval and runtime (PRD §7.11 control panel, design/settings.md)
export async function patchAgent(db: Executor, agentId: string, input: PatchAgentInput, actor: Actor): Promise<Agent> {
  await db.transaction(async (tx) => {
    // Locked like claimNextTask does, so no run starts while the runtime changes
    const [current] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
    if (!current) throw notFound()
    // PM turns are limited only to one per Plan session (D9, D13), and start
    // when the human writes, never on the tick
    if ((input.concurrency !== undefined || input.wakeIntervalSeconds !== undefined) && current.role === 'pm') throw new ApiFailure(400, { code: 'concurrency_not_applicable' })
    if (input.runtime !== undefined && input.runtime !== current.runtime) {
      // A queued or running run was started for the old runtime
      const [active] = await tx.select({ n: count() }).from(runs)
        .where(and(eq(runs.agentId, agentId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      if (active!.n > 0) throw new ApiFailure(409, { code: 'conflict', constraint: 'agent_has_active_runs' })
    }
    await tx.update(agents).set({ ...input, updatedAt: new Date() }).where(eq(agents.id, agentId))
    await tx.insert(auditLog).values({ actor, action: input.paused !== undefined ? (input.paused ? 'agent.paused' : 'agent.resumed') : 'agent.updated', detail: { agentId, changed: Object.keys(input) } })
  })
  return (await listAgents(db)).find(a => a.id === agentId)!
}

export function toReview(row: typeof reviews.$inferSelect): Review {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    round: row.round,
    headSha: row.headSha,
    verdict: row.verdict,
    summary: row.summary,
    criteria: row.criteria,
    author: row.author,
    createdAt: row.createdAt.toISOString()
  }
}

export async function listReviews(db: Executor, taskId: string): Promise<Review[]> {
  const rows = await db.select().from(reviews).where(eq(reviews.taskId, taskId)).orderBy(desc(reviews.createdAt))
  return rows.map(toReview)
}

export async function listEvidence(db: Executor, taskId: string): Promise<Evidence[]> {
  const rows = await db.select().from(evidence).where(eq(evidence.taskId, taskId)).orderBy(desc(evidence.createdAt))
  return rows.map(toEvidence)
}
