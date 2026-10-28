import type { Agent, Evidence, Run } from '@corral/contracts'
import { ACTIVE_RUN_STATES, taskRef } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { notFound } from './errors.ts'

const { agents, evidence, projects, runs, tasks } = schema

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
  prefix: string
  taskNumber: number | null
  taskTitle: string | null
}

function toRun({ run, agentName, prefix, taskNumber, taskTitle }: RunJoin): Run {
  return {
    id: run.id,
    number: run.number,
    agentId: run.agentId,
    agentName,
    role: run.role,
    projectId: run.projectId,
    taskId: run.taskId,
    taskRef: taskNumber === null ? null : taskRef(prefix, taskNumber),
    taskTitle,
    state: run.state,
    outcome: run.outcome,
    summary: run.summary,
    error: run.error,
    headSha: run.headSha,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    rateLimitResetAt: run.rateLimitResetAt?.toISOString() ?? null,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null
  }
}

export async function listRuns(db: Executor, filter: { agentId?: string, taskId?: string, active?: boolean }, limit = 50): Promise<Run[]> {
  const where: SQL[] = []
  if (filter.agentId) where.push(eq(runs.agentId, filter.agentId))
  if (filter.taskId) where.push(eq(runs.taskId, filter.taskId))
  if (filter.active) where.push(inArray(runs.state, [...ACTIVE_RUN_STATES]))
  const rows = await db.select(runColumns).from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(...where))
    .orderBy(desc(runs.number))
    .limit(limit)
  return rows.map(toRun)
}

export async function getRun(db: Executor, runId: string): Promise<Run> {
  const [row] = await db.select(runColumns).from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId))
  if (!row) throw notFound()
  return toRun(row)
}

export async function listAgents(db: Executor): Promise<Agent[]> {
  const rows = await db.select().from(agents).orderBy(agents.createdAt)
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
    pausedUntil: a.pausedUntil?.toISOString() ?? null,
    activeRuns: active.find(x => x.agentId === a.id)?.n ?? 0
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
    url: `/api/evidence/${row.id}/file`,
    createdAt: row.createdAt.toISOString()
  }
}

export async function listEvidence(db: Executor, taskId: string): Promise<Evidence[]> {
  const rows = await db.select().from(evidence).where(eq(evidence.taskId, taskId)).orderBy(desc(evidence.createdAt))
  return rows.map(toEvidence)
}
