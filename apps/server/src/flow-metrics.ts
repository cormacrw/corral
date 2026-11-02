import { AGENT_ROLES, TASK_STATUSES, type TaskStatus } from '@corral/core'
import type { FlowMetrics, FlowMetricsQuery, FlowPercentiles } from '@corral/contracts'
import { weightedRunCost } from '@corral/contracts/client'
import { schema, type Executor } from '@corral/db'
import { and, asc, eq, gte, inArray, isNull, lte, min } from 'drizzle-orm'
import { auditText } from './audit.ts'

// Continuous percentiles: interpolate between adjacent sorted observations.
export function percentiles(values: number[]): FlowPercentiles {
  const sorted = values.toSorted((a, b) => a - b)
  const at = (p: number) => {
    if (!sorted.length) return 0
    const position = (sorted.length - 1) * p
    const low = Math.floor(position)
    return sorted[low]! + (sorted[Math.ceil(position)]! - sorted[low]!) * (position - low)
  }
  return { medianMs: at(0.5), p90Ms: at(0.9) }
}

// A developer's outcomes that hand work over for review
const SUBMISSIONS = ['pr_opened', 'commit_submitted', 'findings_reported', 'design_submitted'] as const

const validStatus = (value: unknown): value is TaskStatus => TASK_STATUSES.includes(value as TaskStatus)
const waiting = (status: TaskStatus) => status === 'draft' || status === 'backlog' || status === 'ready'

export async function flowMetrics(db: Executor, project: Pick<typeof schema.projects.$inferSelect, 'id' | 'prefix'>, window: FlowMetricsQuery['window'], now = new Date()): Promise<FlowMetrics> {
  const since = new Date(now.getTime() - Number.parseInt(window) * 86_400_000)
  const tasks = await db.select({ id: schema.tasks.id, number: schema.tasks.number, createdAt: schema.tasks.createdAt, mergedAt: schema.tasks.mergedAt }).from(schema.tasks).where(and(
    eq(schema.tasks.projectId, project.id), eq(schema.tasks.status, 'merged'), isNull(schema.tasks.deletedAt),
    gte(schema.tasks.mergedAt, since), lte(schema.tasks.mergedAt, now)
  ))
  const ids = tasks.map(task => task.id)
  const [transitions, runs] = ids.length
    ? await Promise.all([
        db.select({ taskId: schema.auditLog.taskId, createdAt: schema.auditLog.createdAt, from: auditText('task.transition', 'from'), to: auditText('task.transition', 'to') }).from(schema.auditLog)
          .where(and(inArray(schema.auditLog.taskId, ids), eq(schema.auditLog.action, 'task.transition')))
          .orderBy(asc(schema.auditLog.createdAt), asc(schema.auditLog.id)),
        db.select({ taskId: schema.runs.taskId, role: schema.runs.role, queuedAt: schema.runs.queuedAt, startedAt: schema.runs.startedAt, endedAt: schema.runs.endedAt }).from(schema.runs).where(inArray(schema.runs.taskId, ids))
      ])
    : [[], []]
  const histories = Map.groupBy(transitions, entry => entry.taskId)
  const taskRuns = Map.groupBy(runs, run => run.taskId)
  const leads: number[] = []
  const cycles: number[] = []
  const statusSamples = new Map<TaskStatus, number[]>(TASK_STATUSES.map(status => [status, []]))
  const slowest: FlowMetrics['slowestTasks'] = []
  let developerRuns = 0

  for (const task of tasks) {
    const created = task.createdAt.getTime()
    const merged = task.mergedAt!.getTime()
    const history = (histories.get(task.id) ?? []).filter(entry => entry.createdAt.getTime() >= created && entry.createdAt.getTime() <= merged)
    const from = history[0]?.from
    let status: TaskStatus = validStatus(from) ? from : 'backlog'
    let cursor = created
    let cycleStart: number | null = waiting(status) ? null : created
    const spent = new Map<TaskStatus, number>()
    // Merged is terminal, not time spent waiting. The audit row uses the
    // transaction's start time, so it can fall just before mergedAt.
    const accrue = (end: number) => {
      if (status !== 'merged') spent.set(status, (spent.get(status) ?? 0) + Math.max(0, end - cursor))
      cursor = end
    }
    for (const entry of history) {
      const { to } = entry
      if (!validStatus(to)) continue
      accrue(entry.createdAt.getTime())
      if (cycleStart === null && waiting(status) && !waiting(to) && to !== 'merged') cycleStart = cursor
      status = to
    }
    accrue(merged)
    const leadTimeMs = Math.max(0, merged - created)
    leads.push(leadTimeMs)
    // A direct merge with no recorded work has zero observable cycle time.
    cycles.push(cycleStart === null ? 0 : Math.max(0, merged - cycleStart))
    for (const [key, duration] of spent) statusSamples.get(key)!.push(duration)
    const dominantStatus = [...spent].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'backlog'
    slowest.push({ ref: `${project.prefix}-${task.number}`, leadTimeMs, dominantStatus })
    developerRuns += (taskRuns.get(task.id) ?? []).filter(run => run.role === 'developer' && run.queuedAt.getTime() <= merged).length
  }

  const byRole: FlowMetrics['runsByRole'] = []
  for (const role of AGENT_ROLES) {
    const queue: number[] = []
    const duration: number[] = []
    for (const task of tasks) {
      for (const run of taskRuns.get(task.id) ?? []) {
        if (run.role !== role || run.queuedAt > task.mergedAt!) continue
        if (run.startedAt && run.startedAt <= task.mergedAt! && run.startedAt >= run.queuedAt) queue.push(run.startedAt.getTime() - run.queuedAt.getTime())
        if (run.startedAt && run.endedAt && run.endedAt >= run.startedAt) duration.push(run.endedAt.getTime() - run.startedAt.getTime())
      }
    }
    if (queue.length || duration.length) byRole.push({ role, queueWait: percentiles(queue), duration: percentiles(duration) })
  }
  const period = and(eq(schema.runs.projectId, project.id), gte(schema.runs.endedAt, since), lte(schema.runs.endedAt, now))
  const ended = await db.select({ taskId: schema.runs.taskId, epicId: schema.runs.epicId, number: schema.runs.number, role: schema.runs.role, outcome: schema.runs.outcome, reReviewed: schema.runs.reReviewed, sessionStart: schema.runs.sessionStart, cacheWriteTokens: schema.runs.cacheWriteTokens, inputTokens: schema.runs.inputTokens, cacheReadTokens: schema.runs.cacheReadTokens, outputTokens: schema.runs.outputTokens }).from(schema.runs)
    .where(and(period, inArray(schema.runs.role, ['developer', 'reviewer'])))
  const touched = [...new Set(ended.flatMap(run => run.role === 'developer' && run.taskId ? [run.taskId] : []))]
  // A task's first build ends at its first submission, which may be older
  const submitted = touched.length
    ? await db.select({ taskId: schema.runs.taskId, number: min(schema.runs.number) }).from(schema.runs).where(and(inArray(schema.runs.taskId, touched), eq(schema.runs.role, 'developer'), inArray(schema.runs.outcome, SUBMISSIONS))).groupBy(schema.runs.taskId)
    : []
  const firstSubmission = new Map(submitted.map(row => [row.taskId, row.number!]))
  const tokens = { firstBuild: 0, followUp: 0 }
  for (const run of ended) {
    if (run.role !== 'developer') continue
    const used = (run.inputTokens ?? 0) + (run.cacheWriteTokens ?? 0) + (run.cacheReadTokens ?? 0) + (run.outputTokens ?? 0)
    const first = run.taskId ? firstSubmission.get(run.taskId) : undefined
    if (run.taskId && (first === undefined || run.number <= first)) tokens.firstBuild += used
    else tokens.followUp += used
  }
  const sessions: FlowMetrics['sessions'] = []
  for (const sessionStart of ['resumed_warm', 'resumed_cold', 'fresh'] as const) {
    const group = ended.filter(run => run.role === 'developer' && run.sessionStart === sessionStart)
    if (group.length === 0) continue
    const sum = (read: (run: typeof group[number]) => number | null) => group.reduce((total, run) => total + (read(run) ?? 0), 0)
    const costs = group.flatMap((run) => {
      const cost = weightedRunCost(run)
      return cost === null ? [] : [cost]
    })
    sessions.push({
      sessionStart, runs: group.length, inputTokens: sum(run => run.inputTokens), cacheWriteTokens: sum(run => run.cacheWriteTokens),
      cacheReadTokens: sum(run => run.cacheReadTokens), outputTokens: sum(run => run.outputTokens), costedRuns: costs.length, weightedCost: costs.reduce((total, cost) => total + cost, 0)
    })
  }
  const epicReviews = ended.filter(run => run.role === 'reviewer' && run.epicId && (run.outcome === 'approved' || run.outcome === 'changes_requested'))
  const reviewedEpics = new Set(epicReviews.map(run => run.epicId)).size
  return {
    fixes: {
      reReviewed: ended.filter(run => run.reReviewed === true).length,
      skippedReview: ended.filter(run => run.reReviewed === false).length,
      epicDeveloperRuns: ended.filter(run => run.role === 'developer' && run.epicId).length
    },
    epicReviews: { reviews: epicReviews.length, epics: reviewedEpics, perEpic: reviewedEpics ? epicReviews.length / reviewedEpics : 0 },
    tokens,
    sessions,
    window, mergedTaskCount: tasks.length,
    leadTime: percentiles(leads), cycleTime: percentiles(cycles),
    timeInStatus: TASK_STATUSES.flatMap((status) => {
      const values = statusSamples.get(status)!
      return values.length ? [{ status, ...percentiles(values) }] : []
    }),
    runsByRole: byRole,
    averageDeveloperRuns: tasks.length ? developerRuns / tasks.length : 0,
    slowestTasks: slowest.sort((a, b) => b.leadTimeMs - a.leadTimeMs || a.ref.localeCompare(b.ref)).slice(0, 10)
  }
}
