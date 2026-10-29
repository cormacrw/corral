import type { Inbox, InboxItem, InboxItemType } from '@corral/contracts'
import { richTextToPlainText, taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { actorLabel } from './orchestrator.ts'

const { agents, auditLog, projects, reviews, runs, tasks } = schema

const ACTIVITY_EVENTS = ['pr_opened', 'pr_updated', 'findings_reported', 'design_submitted', 'changes_requested', 'merged', 'ci_failed', 'base_conflict', 'head_moved']

// The Inbox (D11, design/inbox.md): what developer and reviewer runs need
// from the human, plus what they did. Nothing from the PM. Items are derived
// from tasks and the audit log, so there's nothing to keep in sync.
export async function loadInbox(db: Executor, limit = 100): Promise<Inbox> {
  const open = await db.select({ task: tasks, project: projects }).from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(inArray(tasks.status, ['human_review', 'blocked', 'failed']), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.updatedAt))
  const needsYou = await Promise.all(open.map(({ task, project }) => needsYouItem(db, task, project)))

  const entries = await db.select({ entry: auditLog, task: tasks, project: projects }).from(auditLog)
    .innerJoin(tasks, eq(tasks.id, auditLog.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(inArray(auditLog.action, ['task.transition', 'review.recorded', 'task.deleted']))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit * 3)

  const activity: InboxItem[] = []
  const resolved: InboxItem[] = []
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
  return { needsYou, activity: activity.slice(0, limit), resolved: resolved.slice(0, limit) }
}

async function needsYouItem(db: Executor, task: typeof tasks.$inferSelect, project: typeof projects.$inferSelect): Promise<InboxItem> {
  // The last run on the task is the sender
  const [last] = await db.select({ run: runs, agent: agents }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(runs.taskId, task.id)).orderBy(desc(runs.number)).limit(1)
  const sender = last ? { name: last.agent.name, role: last.agent.role } : { name: 'Corral', role: 'system' as const }
  // A Blocked task whose reason came from the agent's own report is a question
  const [stuck] = task.status === 'blocked'
    ? await db.select({ id: auditLog.id }).from(auditLog)
        .where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.transition')))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1)
        .then(async ([row]) => {
          if (!row) return []
          const [full] = await db.select().from(auditLog).where(eq(auditLog.id, row.id))
          return (full?.detail as { event?: string } | undefined)?.event === 'stuck' ? [full] : []
        })
    : []
  const type: InboxItemType = task.status === 'human_review' ? 'human_review' : task.status === 'failed' ? 'failed' : stuck ? 'question' : 'blocked'
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
    at: task.updatedAt.toISOString(),
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
  return { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor }
}

function senderOf(actor: Actor): InboxItem['sender'] {
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
