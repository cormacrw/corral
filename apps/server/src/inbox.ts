import { needsAttention, type InboxArtifact, type InboxSince, type ReleaseNotesItem } from '@corral/contracts'
import { auditText, readAudit, type AuditView } from './audit.ts'
import { epicInboxItems } from './epic-prs.ts'
import { fileArtifacts, isNew, workNotes } from './inbox-changes.ts'
import type { Inbox, InboxItem, PlanSession, PlanThreadAttention, PlanThreadItem, TaskInboxItem, TaskInboxItemType } from '@corral/contracts'
import { withMessage } from './inbox-message.ts'
import { designPreviewUrl, humanCheckTally, richTextToPlainText, taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { actorLabel } from './orchestrator.ts'
import { thumbnailUrl } from './projects.ts'
import { sessionState, type SessionAttention } from './plan.ts'
import { listEvidence } from './runs.ts'
import { listComments } from './tasks.ts'

const { deployments, agents, auditLog, planMessages, planSessions, planEpics, planTasks, projects, reviews, runs, tasks, comments, epics } = schema

// A request for changes, or an answer: a clarify is a resolve with a pinned comment
const HUMAN_ACTIONS = ['human_request_changes', 'resolve']
const ACTIVITY_EVENTS = ['pr_opened', 'pr_updated', 'pr_rebased', 'commit_submitted', 'integrated', 'findings_reported', 'design_submitted', 'changes_requested', 'merged', 'ci_failed', 'base_conflict', 'head_moved']

// The Inbox (D11, design/inbox.md): what developer and reviewer runs need
// from the human, plus what they did, and Plan sessions waiting on the human as a Plan
// thread (D11, amended). Items are derived from tasks, Plan sessions and the
// audit log and deployments; only their short conversational prose is stored.
export async function loadInbox(db: Executor, limit = 100): Promise<Inbox> {
  const taskItems = await taskMessageItems(db)
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
    .where(inArray(auditLog.action, ['task.transition', 'review.recorded', 'rebase.verified', 'task.deleted']))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit * 3)

  const activity: TaskInboxItem[] = []
  const resolved: (TaskInboxItem | ReleaseNotesItem)[] = []
  for (const { entry, task, project } of entries) {
    const detail = readAudit(entry.detail)
    const { event } = detail
    const base = { id: String(entry.id), project: projectTag(project), taskId: task.id, taskRef: taskRef(project.prefix, task.number), subject: task.title, prUrl: task.prUrl, at: entry.createdAt.toISOString() }
    if (entry.actor.kind === 'human' && (entry.action === 'task.deleted' || ['resolve', 'human_approve', 'human_request_changes', 'send_back'].includes(event ?? ''))) {
      const resolution = resolutionText(entry.action, detail, task.type)
      resolved.push({ ...base, type: 'activity', preview: resolution, body: resolution, sender: { name: 'You', role: 'system' }, resolution })
    }
    if (entry.action === 'review.recorded' || entry.action === 'rebase.verified' || (entry.action === 'task.transition' && (ACTIVITY_EVENTS.includes(event ?? '') || (event === 'human_approve' && task.type === 'design')))) {
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
    const { session, attention } = await sessionState(db, row)
    const waiting = await threadAttention(db, session, attention)
    if (!waiting) return null
    const { since, ...state } = waiting
    return {
      ...state,
      id: session.id,
      type: 'plan_thread' as const,
      project: projectTag(project),
      sessionId: session.id,
      runtime: session.runtime,
      subject: session.title,
      preview: session.preview,
      sender,
      at: since.toISOString(),
      unread: session.unread,
      activeRunId: session.activeRunId,
      taskId: null,
      taskRef: null,
      prUrl: null,
      resolution: null
    }
  }))
  return items.filter((item): item is NonNullable<typeof item> => item !== null)
}

export async function taskMessageItems(db: Executor, taskId?: string): Promise<TaskInboxItem[]> {
  const open = await db.select({ task: tasks, project: projects }).from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(inArray(tasks.status, ['human_review', 'blocked', 'failed']), isNull(tasks.deletedAt), taskId ? eq(tasks.id, taskId) : undefined))
  return Promise.all(open.map(({ task, project }) => needsYouItem(db, task, project)))
}

// What a session waits on, with the data its status needs, or null when the
// human has nothing to do there
async function threadAttention(db: Executor, session: PlanSession, attention: SessionAttention): Promise<(PlanThreadAttention & { since: Date }) | null> {
  switch (attention.status) {
    case 'question': {
      const { text, recommendation, options, createdAt } = attention.question
      return { status: 'question', question: { text, recommendation, options }, plan: null, planId: null, reply: null, since: createdAt }
    }
    case 'needs_approval': {
      const { plan } = attention
      // Tasks dropped in a revision keep a 'removed' row and aren't part of the plan. Plans saved before
      // plan_epics existed have no epic rows, only plans.epicId, so count that as one epic.
      const [[epicCount], [taskCount]] = await Promise.all([
        db.select({ rows: count(), count: count(planEpics.epicId) }).from(planEpics).where(eq(planEpics.planId, plan.id)),
        db.select({ count: count() }).from(planTasks).where(and(eq(planTasks.planId, plan.id), ne(planTasks.change, 'removed')))
      ])
      const summary = { id: plan.id, version: plan.version, title: plan.title, summary: plan.summary, epicCount: epicCount?.rows === 0 && plan.epicId ? 1 : epicCount?.count ?? 0, taskCount: taskCount?.count ?? 0 }
      return { status: 'needs_approval', question: null, plan: summary, planId: plan.id, reply: null, since: plan.createdAt }
    }
    case 'none': {
      if (!session.unread) return null
      const [reply] = await db.select().from(planMessages).where(and(eq(planMessages.sessionId, session.id), eq(planMessages.role, 'pm'))).orderBy(desc(planMessages.createdAt)).limit(1)
      if (!reply) return null
      return { status: 'none', question: null, plan: null, planId: null, reply: reply.text, since: reply.createdAt }
    }
  }
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
  return withMessage(db, {
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
    resolution: null,
    ...await taskChanges(db, task)
  })
}

// What's new on a task since the human's last action (design/inbox.md)
async function taskChanges(db: Executor, task: typeof tasks.$inferSelect): Promise<{ since: InboxSince | null, newArtifacts: InboxArtifact[] }> {
  const history = await db.select({ actor: auditLog.actor, detail: auditLog.detail, createdAt: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.transition')))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
  const index = history.findIndex(e => e.actor.kind === 'human' && HUMAN_ACTIONS.includes(readAudit(e.detail).event ?? ''))
  const action = history[index]
  const at = action?.createdAt.toISOString() ?? null
  const newArtifacts = fileArtifacts(await listEvidence(db, task.id), at)
  if (task.type === 'design') {
    const [latest] = await db.select().from(schema.designVersions).where(eq(schema.designVersions.taskId, task.id))
      .orderBy(desc(schema.designVersions.version)).limit(1)
    if (latest && isNew(latest.createdAt.toISOString(), at)) newArtifacts.unshift({ id: latest.id, kind: 'design', name: `Design v${latest.version}`, url: designPreviewUrl(latest.id), taskRef: null, at: latest.createdAt.toISOString() })
  }
  if (!action || !at) return { since: null, newArtifacts }
  const notes = await listComments(db, task.id)
  // An answer is the pinned comment the human wrote while the task waited for it
  const waitingSince = history[index + 1]?.createdAt.toISOString() ?? ''
  const answer = notes.findLast(c => c.author.kind === 'human' && c.pinned && c.createdAt > waitingSince && c.createdAt <= at)
  const text = readAudit(action.detail).feedback ?? answer?.body ?? null
  return { since: { at, text, notes: workNotes(notes, at), fixTasks: [] }, newArtifacts }
}

async function humanReviewNote(db: Executor, task: typeof tasks.$inferSelect): Promise<string> {
  if (task.type === 'spike') {
    const [findings] = await db.select({ body: comments.body }).from(comments)
      .where(and(eq(comments.taskId, task.id), sql`${comments.body} like ${'## Findings\n%'}`))
      .orderBy(desc(comments.createdAt), desc(comments.id)).limit(1)
    return findings?.body ?? ''
  }
  if (task.type === 'design') {
    const [version] = await db.select({ version: schema.designVersions.version }).from(schema.designVersions)
      .where(and(eq(schema.designVersions.taskId, task.id), eq(schema.designVersions.status, 'submitted')))
      .orderBy(desc(schema.designVersions.version)).limit(1)
    return `Design${version ? ` v${version.version}` : ''} is ready for your approval. Approving opens a Plan session for the build.`
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
  if (action === 'rebase.verified') return `Verified the rebase of ${pr} without review`
  const commit = prNumber ? pr : 'the commit'
  if (action === 'review.recorded') {
    // A spike's findings (D19), a design (D20) and an epic task's commit (D27) are reviewed without a PR
    const reviewed = !prNumber && type === 'design' ? 'the design' : !prNumber && type === 'spike' ? 'the findings' : commit
    return detail.verdict === 'approved' ? `Approved ${reviewed} (${String(detail.met)} of ${String(detail.of)} criteria met)` : `Requested changes on ${reviewed} (${String(detail.met)} of ${String(detail.of)} criteria met)`
  }
  switch (event) {
    case 'human_approve': return 'You approved the design'
    case 'pr_opened': return `Opened ${pr}`
    case 'pr_updated': return `Pushed a revision to ${pr}`
    case 'pr_rebased': return `Rebased ${pr}; on to the reviewer`
    case 'commit_submitted': return 'Submitted a commit; on to the reviewer'
    case 'findings_reported': return 'Reported findings; on to the reviewer'
    case 'design_submitted': return `Submitted design v${String(detail.version)}; on to the reviewer`
    case 'changes_requested': return detail.to === 'blocked' ? 'Changes requested; Blocked for you' : 'Changes requested; back to the developer'
    case 'merged': return `Merged ${pr}`
    case 'integrated': return `Integrated ${String(detail.integratedCommitSha).slice(0, 10)} into the epic branch`
    case 'ci_failed': return `CI failed on ${commit}; back to the developer`
    case 'base_conflict': return prNumber ? `${pr} conflicts with the base branch; back to the developer` : 'The commit conflicts with the epic branch; back to the developer'
    case 'head_moved': return prNumber ? `New commits on ${pr}; back to the reviewer` : 'New commits on the task branch; back to the reviewer'
    default: return event ?? action
  }
}

function resolutionText(action: string, { event, to }: AuditView, type: string): string {
  if (action === 'task.deleted') return 'You deleted the task'
  if (event === 'human_approve') {
    if (type === 'spike') return 'You accepted the findings'
    return type === 'design' ? 'You approved the design' : 'You approved the merge'
  }
  if (event === 'human_request_changes') return 'You requested changes'
  if (event === 'send_back') return 'You sent the task back to Backlog'
  if (event === 'resolve') {
    return `You moved the task to ${String(to ?? 'a new status').replace('_', ' ')}`
  }
  return 'Resolved'
}
