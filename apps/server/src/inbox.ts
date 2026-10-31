import { needsAttention, type ReleaseNotesItem } from '@corral/contracts'
import { auditText, readAudit, type AuditView } from './audit.ts'
import { epicInboxItems } from './epic-prs.ts'
import type { Inbox, InboxItem, PlanThreadItem, TaskInboxItem, TaskInboxItemType } from '@corral/contracts'
import { humanCheckTally, richTextToPlainText, taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { actorLabel } from './orchestrator.ts'
import { thumbnailUrl } from './projects.ts'
import { sessionState } from './plan.ts'

const { deployments, agents, auditLog, planMessages, planSessions, plans, planEpics, planTasks, projects, reviews, runs, tasks, comments, epics } = schema

const ACTIVITY_EVENTS = ['pr_opened', 'pr_updated', 'pr_rebased', 'commit_submitted', 'integrated', 'findings_reported', 'design_submitted', 'changes_requested', 'merged', 'ci_failed', 'base_conflict', 'head_moved']

// The Inbox (D11, design/inbox.md): what developer and reviewer runs need
// from the human, plus what they did, and Plan sessions waiting on the human as a Plan
// thread (D11, amended). Items are derived from tasks, Plan sessions and the
// audit log and deployments, so there's nothing to keep in sync.
export async function loadInbox(db: Executor, limit = 100): Promise<Inbox> {
  const open = await db.select({ task: tasks, project: projects }).from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(inArray(tasks.status, ['human_review', 'blocked', 'failed']), isNull(tasks.deletedAt)))
  const taskItems = await Promise.all(open.map(({ task, project }) => needsYouItem(db, task, project)))
  const threads = await planThreads(db)
  const epicItems = await epicInboxItems(db)

  const [pm] = await db.select().from(agents).where(eq(agents.role, 'pm')).limit(1)
  const recent = await db.select({ deployment: deployments, project: projects }).from(deployments)
    .innerJoin(projects, eq(projects.id, deployments.projectId))
    .orderBy(desc(deployments.createdAt), desc(deployments.id)).limit(20)
  const releases: ReleaseNotesItem[] = recent.map(({ deployment: d, project }) => ({
    id: d.id, type: 'release_notes', deploymentId: d.id, project: projectTag(project),
    subject: 'Release notes', preview: d.notesStatus === 'pending' ? 'Writing release notes…' : d.notes ?? '',
    sender: { name: pm?.name ?? 'PM', role: 'pm' }, at: d.createdAt.toISOString(),
    fromSha: d.fromSha?.slice(0, 7) ?? null, toSha: d.toSha.slice(0, 7), notes: d.notes,
    notesStatus: d.notesStatus, unread: !d.readAt, taskId: null, taskRef: null, prUrl: null,
    resolution: d.dismissedAt ? 'You dismissed these release notes' : null
  }))
  // One list, newest first by when each item arrived (design/inbox.md)
  const needsYou: InboxItem[] = [...taskItems, ...threads, ...epicItems, ...releases.filter(d => !d.resolution)].sort((a: InboxItem, b: InboxItem) => b.at.localeCompare(a.at))

  const entries = await db.select({ entry: auditLog, task: tasks, project: projects }).from(auditLog)
    .innerJoin(tasks, eq(tasks.id, auditLog.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(inArray(auditLog.action, ['task.transition', 'review.recorded', 'task.deleted']))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit * 3)

  const activity: TaskInboxItem[] = []
  const resolved: (TaskInboxItem | ReleaseNotesItem)[] = []
  for (const { entry, task, project } of entries) {
    const detail = readAudit(entry.detail)
    const { event } = detail
    const base = { id: String(entry.id), project: projectTag(project), taskId: task.id, taskRef: taskRef(project.prefix, task.number), subject: task.title, prUrl: task.prUrl, at: entry.createdAt.toISOString() }
    if (entry.actor.kind === 'human' && (entry.action === 'task.deleted' || ['resolve', 'human_approve', 'human_request_changes', 'send_back'].includes(event ?? ''))) {
      const resolution = resolutionText(entry.action, detail)
      resolved.push({ ...base, type: 'activity', preview: resolution, body: resolution, sender: { name: 'You', role: 'system' }, resolution })
    } else if (entry.action === 'review.recorded' || (entry.action === 'task.transition' && ACTIVITY_EVENTS.includes(event ?? ''))) {
      const text = activityText(entry.action, event, detail, task.prNumber, task.type)
      activity.push({ ...base, type: 'activity', preview: text, body: text, sender: senderOf(entry.actor), resolution: null })
    }
    if (activity.length >= limit && resolved.length >= limit) break
  }
  const epicEvents = await db.select({ entry: auditLog, epic: epics, project: projects }).from(auditLog)
    .innerJoin(epics, sql`${auditText('epic.pr', 'epicId')} = ${epics.id}::text`)
    .innerJoin(projects, eq(projects.id, epics.projectId))
    .where(eq(auditLog.action, 'epic.pr')).orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(limit)
  for (const { entry, epic, project } of epicEvents) {
    const detail = readAudit(entry.detail)
    const [task] = await db.select().from(tasks).where(and(eq(tasks.epicId, epic.id), isNull(tasks.deletedAt))).limit(1)
    if (!task) continue
    const labels: Record<string, string> = { opened: 'Epic PR opened', review_started: 'Epic integration review started', approved: 'Epic PR approved by reviewer', changes_requested: 'Epic integration changes requested', human_approved: 'You approved the epic PR', human_changes_requested: 'You requested changes on the epic PR', rebase_requested: 'Rebasing the epic PR onto the target branch', rebased: 'Epic PR rebased; CI runs again', conflict: 'Epic PR conflict', rebase_handed_off: 'You handed the epic PR rebase to a developer', ci_failed: 'CI failed on the epic PR', merge_refused: 'GitHub refused the epic PR merge', closed: 'Epic PR closed on GitHub', merged: 'Epic PR merged' }
    const body = [labels[detail.event ?? ''] ?? detail.event, detail.summary].filter(Boolean).join(': ')
    const item: TaskInboxItem = { id: `epic-${entry.id}`, type: 'activity', epicId: epic.id, project: projectTag(project), taskId: task.id, taskRef: taskRef(project.prefix, task.number), subject: epic.title, preview: body, body, sender: senderOf(entry.actor), at: entry.createdAt.toISOString(), prUrl: epic.prNumber ? `https://github.com/${project.repository}/pull/${epic.prNumber}` : null, resolution: entry.actor.kind === 'human' ? body : null }
    if (entry.actor.kind === 'human') resolved.push(item)
    else activity.push(item)
  }
  resolved.push(...releases.filter(d => d.resolution))
  activity.sort((a, b) => b.at.localeCompare(a.at))
  resolved.sort((a, b) => b.at.localeCompare(a.at))
  return { needsYou, activity: activity.slice(0, limit), resolved: resolved.slice(0, limit), count: needsYou.filter(needsAttention).length }
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
    .where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.transition'), sql`${auditText('task.transition', 'to')} = ${task.status}`, sql`${auditText('task.transition', 'from')} is distinct from ${task.status}`))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1)
  // A Blocked task whose reason came from the agent's own report is a question
  const stuck = task.status === 'blocked' && readAudit(entered?.detail).event === 'stuck'
  const type: TaskInboxItemType = task.status === 'human_review' ? 'human_review' : task.status === 'failed' ? 'failed' : stuck ? 'question' : 'blocked'
  // PR reviews get a short note; spikes show their findings. The
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
  if (task.type === 'spike') {
    const [findings] = await db.select({ body: comments.body }).from(comments)
      .where(and(eq(comments.taskId, task.id), sql`${comments.body} like ${'## Findings\n%'}`))
      .orderBy(desc(comments.createdAt), desc(comments.id)).limit(1)
    return findings?.body ?? ''
  }
  const [review] = await db.select({ criteria: reviews.criteria }).from(reviews)
    .where(and(eq(reviews.taskId, task.id), eq(reviews.verdict, 'approved')))
    .orderBy(desc(reviews.createdAt)).limit(1)
  const humanCriteria = await db.select({ id: schema.acceptanceCriteria.id }).from(schema.acceptanceCriteria)
    .where(and(eq(schema.acceptanceCriteria.taskId, task.id), eq(schema.acceptanceCriteria.checkedByHuman, true)))
  const humanChecks = humanCriteria.length
  if (humanChecks > 0) {
    const met = review?.criteria.filter(c => c.met && !humanCriteria.some(h => h.id === c.criterionId)).length ?? 0
    return `Approved, ${humanCheckTally(met, humanChecks)}. These checks need your OK before the task merges.`
  }
  const met = review ? `, ${review.criteria.length === 1 ? '1 criterion' : `all ${review.criteria.length} criteria`} met` : ''
  return `Approved${met}. This task is marked for human review, so it needs your OK before it merges.`
}

function projectTag(project: typeof projects.$inferSelect) {
  return { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: thumbnailUrl(project) }
}

function senderOf(actor: Actor): TaskInboxItem['sender'] {
  if (actor.kind === 'agent') return { name: actorLabel(actor), role: actor.role }
  return { name: actorLabel(actor), role: 'system' }
}

function activityText(action: string, event: string | null, detail: AuditView, prNumber: number | null, type: string): string {
  const pr = prNumber ? `PR #${prNumber}` : 'the PR'
  if (action === 'review.recorded') {
    // A spike's findings (D19), a design (D20) and an epic task's commit (D27) are reviewed without a PR
    const reviewed = prNumber ? pr : type === 'design' ? 'the design' : type === 'spike' ? 'the findings' : 'the commit'
    return detail.verdict === 'approved' ? `Approved ${reviewed} (${String(detail.met)} of ${String(detail.of)} criteria met)` : `Requested changes on ${reviewed} (${String(detail.met)} of ${String(detail.of)} criteria met)`
  }
  switch (event) {
    case 'pr_opened': return `Opened ${pr}`
    case 'pr_updated': return `Pushed a revision to ${pr}`
    case 'pr_rebased': return `Rebased ${pr}; on to the reviewer`
    case 'commit_submitted': return 'Submitted a commit; on to the reviewer'
    case 'findings_reported': return 'Reported findings; on to the reviewer'
    case 'design_submitted': return `Submitted design v${String(detail.version)}; on to the reviewer`
    case 'changes_requested': return detail.to === 'blocked' ? 'Changes requested; Blocked for you' : 'Changes requested; back to the developer'
    case 'merged': return `Merged ${pr}`
    case 'integrated': return `Integrated ${String(detail.integratedCommitSha).slice(0, 10)} into the epic branch`
    case 'ci_failed': return `CI failed on ${pr}; back to the developer`
    case 'base_conflict': return `${pr} conflicts with the base branch; back to the developer`
    case 'head_moved': return `New commits on ${pr}; back to the reviewer`
    default: return event ?? action
  }
}

function resolutionText(action: string, { event, to }: AuditView): string {
  if (action === 'task.deleted') return 'You deleted the task'
  if (event === 'human_approve') return 'You approved the merge'
  if (event === 'human_request_changes') return 'You requested changes'
  if (event === 'send_back') return 'You sent the task back to Backlog'
  if (event === 'resolve') {
    return `You moved the task to ${String(to ?? 'a new status').replace('_', ' ')}`
  }
  return 'Resolved'
}
