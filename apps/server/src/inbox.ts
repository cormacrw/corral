import type { Inbox, InboxItem, PlanThreadItem, TaskInboxItem, TaskInboxItemType } from '@corral/contracts'
import { richTextToPlainText, taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { actorLabel } from './orchestrator.ts'
import { thumbnailUrl } from './projects.ts'
import { sessionState } from './plan.ts'

const { agents, auditLog, planMessages, planSessions, plans, planEpics, planTasks, projects, reviews, runs, tasks } = schema

const ACTIVITY_EVENTS = ['pr_opened', 'pr_updated', 'findings_reported', 'design_submitted', 'changes_requested', 'merged', 'ci_failed', 'base_conflict', 'head_moved']

// The Inbox (D11, design/inbox.md): what developer and reviewer runs need
// from the human, plus what they did, and Plan sessions waiting on the human as a Plan
// thread (D11, amended). Items are derived from tasks, Plan sessions and the
// audit log, so there's nothing to keep in sync.
export async function loadInbox(db: Executor, limit = 100): Promise<Inbox> {
  const open = await db.select({ task: tasks, project: projects }).from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(inArray(tasks.status, ['human_review', 'blocked', 'failed']), isNull(tasks.deletedAt)))
  const taskItems = await Promise.all(open.map(({ task, project }) => needsYouItem(db, task, project)))
  const threads = await planThreads(db)
  // One list, newest first by when each item arrived (design/inbox.md)
  const needsYou = [...taskItems, ...threads].sort((a: InboxItem, b: InboxItem) => b.at.localeCompare(a.at))

  const entries = await db.select({ entry: auditLog, task: tasks, project: projects }).from(auditLog)
    .innerJoin(tasks, eq(tasks.id, auditLog.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(inArray(auditLog.action, ['task.transition', 'review.recorded', 'task.deleted']))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit * 3)

  const activity: TaskInboxItem[] = []
  const resolved: TaskInboxItem[] = []
  for (const { entry, task, project } of entries) {
    const detail = entry.detail as Record<string, unknown>
    const event = typeof detail.event === 'string' ? detail.event : typeof detail.event === 'object' && detail.event ? String((detail.event as { type?: string }).type) : null
    const base = { id: String(entry.id), project: projectTag(project), taskId: task.id, taskRef: taskRef(project.prefix, task.number), subject: task.title, prUrl: task.prUrl, at: entry.createdAt.toISOString() }
    if (entry.actor.kind === 'human' && (entry.action === 'task.deleted' || ['resolve', 'human_approve', 'human_request_changes', 'send_back'].includes(event ?? ''))) {
      const resolution = resolutionText(entry.action, event, detail)
      resolved.push({ ...base, type: 'activity', preview: resolution, body: resolution, sender: { name: 'You', role: 'system' }, resolution })
    } else if (entry.action === 'review.recorded' || (entry.action === 'task.transition' && ACTIVITY_EVENTS.includes(event ?? ''))) {
      const text = activityText(entry.action, event, detail, task.prNumber, task.type)
      activity.push({ ...base, type: 'activity', preview: text, body: text, sender: senderOf(entry.actor), resolution: null })
    }
    if (activity.length >= limit && resolved.length >= limit) break
  }
  return { needsYou, activity: activity.slice(0, limit), resolved: resolved.slice(0, limit), count: needsYou.length }
}

// Only open sessions waiting on the human belong in the Inbox: a question, a
// plan needing approval or an unread PM reply. Each is dated by when it
// started waiting.
async function planThreads(db: Executor): Promise<PlanThreadItem[]> {
  const rows = await db.select({ session: planSessions, project: projects }).from(planSessions)
    .innerJoin(projects, eq(projects.id, planSessions.projectId))
    .where(isNull(planSessions.closedAt))
  if (rows.length === 0) return []
  const [pm] = await db.select({ name: agents.name }).from(agents).where(eq(agents.role, 'pm')).limit(1)
  const sender = { name: pm?.name ?? 'PM', role: 'pm' as const }
  const items = await Promise.all(rows.map(async ({ session: row, project }) => {
    const { session, planId, last } = await sessionState(db, row)
    const waitingOnReply = session.status === 'none' && session.unread
    if (session.status !== 'question' && session.status !== 'needs_approval' && !waitingOnReply) return null
    const [reply] = waitingOnReply
      ? await db.select().from(planMessages).where(and(eq(planMessages.sessionId, row.id), eq(planMessages.role, 'pm'))).orderBy(desc(planMessages.createdAt)).limit(1)
      : []
    if (waitingOnReply && !reply) return null
    const [waiting] = planId ? await db.select().from(plans).where(eq(plans.id, planId)) : []
    const since = session.status === 'needs_approval' ? waiting!.createdAt : session.status === 'question' ? last!.createdAt : reply!.createdAt
    // Tasks dropped in a revision keep a 'removed' row and aren't part of the plan. Plans saved before
    // plan_epics existed have no epic rows, only plans.epicId, so count that as one epic.
    const [epics, tasks] = waiting
      ? await Promise.all([
          db.select({ rows: count(), count: count(planEpics.epicId) }).from(planEpics).where(eq(planEpics.planId, waiting.id)),
          db.select({ count: count() }).from(planTasks).where(and(eq(planTasks.planId, waiting.id), ne(planTasks.change, 'removed')))
        ])
      : [[], []]
    return {
      id: session.id,
      type: 'plan_thread' as const,
      project: projectTag(project),
      sessionId: session.id,
      runtime: session.runtime,
      subject: session.title,
      preview: session.preview,
      question: session.status === 'question' && last ? { text: last.text, recommendation: last.recommendation, options: last.options } : null,
      reply: reply ? reply.text : null,
      plan: waiting ? { id: waiting.id, version: waiting.version, title: waiting.title, summary: waiting.summary, epicCount: epics[0]?.rows === 0 && waiting.epicId ? 1 : epics[0]?.count ?? 0, taskCount: tasks[0]?.count ?? 0 } : null,
      sender,
      at: since.toISOString(),
      status: session.status,
      unread: session.unread,
      planId,
      activeRunId: session.activeRunId,
      taskId: null,
      taskRef: null,
      prUrl: null,
      resolution: null
    }
  }))
  return items.filter((item): item is NonNullable<typeof item> => item !== null)
}

async function needsYouItem(db: Executor, task: typeof tasks.$inferSelect, project: typeof projects.$inferSelect): Promise<TaskInboxItem> {
  // The last run on the task is the sender
  const [last] = await db.select({ run: runs, agent: agents }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(runs.taskId, task.id)).orderBy(desc(runs.number)).limit(1)
  const sender = last ? { name: last.agent.name, role: last.agent.role } : { name: 'Corral', role: 'system' as const }
  // The item arrived when the task entered its status. Updates that keep the
  // status (a PR head moving, an edit) don't move it.
  const [entered] = await db.select({ detail: auditLog.detail, createdAt: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.transition'), sql`${auditLog.detail}->>'to' = ${task.status}`, sql`${auditLog.detail}->>'from' is distinct from ${task.status}`))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1)
  // A Blocked task whose reason came from the agent's own report is a question
  const stuck = task.status === 'blocked' && (entered?.detail as { event?: string } | undefined)?.event === 'stuck'
  const type: TaskInboxItemType = task.status === 'human_review' ? 'human_review' : task.status === 'failed' ? 'failed' : stuck ? 'question' : 'blocked'
  // A human review gets a short note, not the reviewer's full write-up: the
  // criteria and evidence sit right under it (design/inbox.md)
  const body = task.status === 'human_review'
    ? await humanReviewNote(db, task)
    : (task.statusReason ?? '')
  return {
    id: task.id,
    type,
    project: projectTag(project),
    taskId: task.id,
    taskRef: taskRef(project.prefix, task.number),
    subject: task.title,
    preview: (body || richTextToPlainText(task.description)).slice(0, 200),
    body,
    sender,
    at: (entered?.createdAt ?? task.updatedAt).toISOString(),
    prUrl: task.prUrl,
    resolution: null
  }
}

async function humanReviewNote(db: Executor, task: typeof tasks.$inferSelect): Promise<string> {
  const [review] = await db.select({ criteria: reviews.criteria }).from(reviews)
    .where(and(eq(reviews.taskId, task.id), eq(reviews.verdict, 'approved')))
    .orderBy(desc(reviews.createdAt)).limit(1)
  const met = review ? `, all ${review.criteria.length} criteria met` : ''
  return `Approved${met}. This task is marked for human review, so it needs your OK before it merges.`
}

function projectTag(project: typeof projects.$inferSelect) {
  return { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: thumbnailUrl(project) }
}

function senderOf(actor: Actor): TaskInboxItem['sender'] {
  if (actor.kind === 'agent') return { name: actorLabel(actor), role: actor.role }
  return { name: actorLabel(actor), role: 'system' }
}

function activityText(action: string, event: string | null, detail: Record<string, unknown>, prNumber: number | null, type: string): string {
  const pr = prNumber ? `PR #${prNumber}` : 'the PR'
  if (action === 'review.recorded') {
    // A spike's findings (D19) and a design (D20) are reviewed without a PR
    const reviewed = prNumber ? pr : type === 'design' ? 'the design' : 'the findings'
    return detail.verdict === 'approved' ? `Approved ${reviewed} (${String(detail.met)} of ${String(detail.of)} criteria met)` : `Requested changes on ${reviewed} (${String(detail.met)} of ${String(detail.of)} criteria met)`
  }
  switch (event) {
    case 'pr_opened': return `Opened ${pr}`
    case 'pr_updated': return `Pushed a revision to ${pr}`
    case 'findings_reported': return 'Reported findings; on to the reviewer'
    case 'design_submitted': return `Submitted design v${String(detail.version)}; on to the reviewer`
    case 'changes_requested': return detail.to === 'blocked' ? 'Changes requested; Blocked for you' : 'Changes requested; back to the developer'
    case 'merged': return `Merged ${pr}`
    case 'ci_failed': return `CI failed on ${pr}; back to the developer`
    case 'base_conflict': return `${pr} conflicts with the base branch; back to the developer`
    case 'head_moved': return `New commits on ${pr}; back to the reviewer`
    default: return event ?? action
  }
}

function resolutionText(action: string, event: string | null, detail: Record<string, unknown>): string {
  if (action === 'task.deleted') return 'You deleted the task'
  if (event === 'human_approve') return 'You approved the merge'
  if (event === 'human_request_changes') return 'You requested changes'
  if (event === 'send_back') return 'You sent the task back to Backlog'
  if (event === 'resolve') {
    const to = (detail.event as { to?: string } | undefined)?.to ?? detail.to
    return `You moved the task to ${String(to ?? 'a new status').replace('_', ' ')}`
  }
  return 'Resolved'
}
