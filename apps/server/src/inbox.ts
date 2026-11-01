import { needsAttention, type InboxArtifact, type InboxSince, type ReleaseNotesItem } from '@corral/contracts'
import { auditText, readAudit, type AuditView } from './audit.ts'
import { countEpicItems, epicEventText, epicInboxItems } from './epic-prs.ts'
import { waitingDecisions } from './epic-rebase-approval.ts'
import { fileArtifacts, isNew, workNotes } from './inbox-changes.ts'
import type { Comment, Evidence, Inbox, InboxItem, PlanThreadAttention, PlanThreadItem, TaskInboxItem, TaskInboxItemType } from '@corral/contracts'
import { arrivalKey, storedMessages, withMessages, type PreparedItem } from './inbox-message.ts'
import { designPreviewUrl, humanCheckTally, richTextToPlainText, taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { actorLabel } from './orchestrator.ts'
import { thumbnailUrl } from './projects.ts'
import { sessionStates, type SessionAttention } from './plan.ts'
import { listEvidenceFor } from './runs.ts'
import { listCommentsFor } from './tasks.ts'

const { deployments, agents, auditLog, planMessages, planSessions, planEpics, planTasks, projects, reviews, runs, tasks, epics } = schema

// A request for changes, or an answer: a clarify is a resolve with a pinned comment
const HUMAN_ACTIONS = ['human_request_changes', 'resolve']
const ACTIVITY_EVENTS = ['pr_opened', 'pr_updated', 'pr_rebased', 'commit_submitted', 'integrated', 'findings_reported', 'design_submitted', 'changes_requested', 'merged', 'ci_failed', 'base_conflict', 'head_moved']

// The Inbox (D11, design/inbox.md): what developer and reviewer runs need
// from the human, plus what they did, and Plan sessions waiting on the human as a Plan
// thread (D11, amended). Items are derived from tasks, Plan sessions and the
// audit log and deployments; only their short conversational prose is stored.
export async function loadInbox(db: Executor, limit = 100): Promise<Inbox> {
  const [taskItems, threads, epicItems, [pm], recent] = await Promise.all([
    taskMessageItems(db),
    planThreads(db),
    epicInboxItems(db),
    db.select({ name: agents.name }).from(agents).where(eq(agents.role, 'pm')).limit(1),
    db.select({ deployment: deployments, project: projects }).from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .orderBy(desc(deployments.createdAt), desc(deployments.id)).limit(20)
  ])
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

  const entries = await db.select({
    entry: { id: auditLog.id, actor: auditLog.actor, action: auditLog.action, detail: auditLog.detail, createdAt: auditLog.createdAt },
    task: { id: tasks.id, number: tasks.number, title: tasks.title, type: tasks.type, prUrl: tasks.prUrl, prNumber: tasks.prNumber },
    project: projectColumns
  }).from(auditLog)
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
  const epicEvents = await db.select({
    entry: { id: auditLog.id, actor: auditLog.actor, detail: auditLog.detail, createdAt: auditLog.createdAt },
    epic: { id: epics.id, title: epics.title, prNumber: epics.prNumber },
    project: { ...projectColumns, repository: projects.repository }
  }).from(auditLog)
    .innerJoin(epics, sql`${auditText('epic.pr', 'epicId')} = ${epics.id}::text`)
    .innerJoin(projects, eq(projects.id, epics.projectId))
    .where(eq(auditLog.action, 'epic.pr')).orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(limit)
  // An epic event links to the epic's first task
  const firstTasks = epicEvents.length > 0
    ? await db.selectDistinctOn([tasks.epicId], { id: tasks.id, epicId: tasks.epicId, number: tasks.number }).from(tasks)
        .where(and(inArray(tasks.epicId, [...new Set(epicEvents.map(e => e.epic.id))]), isNull(tasks.deletedAt)))
        .orderBy(tasks.epicId, tasks.number)
    : []
  const firstTask = new Map(firstTasks.map(t => [t.epicId, t]))
  for (const { entry, epic, project } of epicEvents) {
    const detail = readAudit(entry.detail)
    const task = firstTask.get(epic.id)
    if (!task) continue
    const body = epicEventText(detail)
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
// plan needing approval or an unread PM reply.
async function waitingSessions(db: Executor) {
  const rows = await db.select({ session: planSessions, project: projects }).from(planSessions)
    .innerJoin(projects, eq(projects.id, planSessions.projectId))
    .where(isNull(planSessions.closedAt))
  const states = await sessionStates(db, rows.map(r => r.session))
  const unreadReplies = states.filter(s => s.attention.status === 'none' && s.session.unread).map(s => s.session.id)
  const replies = unreadReplies.length > 0
    ? await db.selectDistinctOn([planMessages.sessionId], { sessionId: planMessages.sessionId, text: planMessages.text, createdAt: planMessages.createdAt }).from(planMessages)
        .where(and(inArray(planMessages.sessionId, unreadReplies), eq(planMessages.role, 'pm'))).orderBy(planMessages.sessionId, desc(planMessages.createdAt))
    : []
  const replyOf = new Map(replies.map(r => [r.sessionId, r]))
  return rows.flatMap(({ project }, i) => {
    const { session, attention } = states[i]!
    const reply = attention.status === 'none' && session.unread ? replyOf.get(session.id) : undefined
    return attention.status !== 'none' || reply ? [{ session, attention, project, reply }] : []
  })
}

// Each is dated by when it started waiting.
async function planThreads(db: Executor): Promise<PlanThreadItem[]> {
  const waiting = await waitingSessions(db)
  if (waiting.length === 0) return []
  const planIds = waiting.flatMap(w => w.attention.status === 'needs_approval' ? [w.attention.plan.id] : [])
  const [[pm], epicCounts, taskCounts] = await Promise.all([
    db.select({ name: agents.name }).from(agents).where(eq(agents.role, 'pm')).limit(1),
    planIds.length > 0
      ? db.select({ planId: planEpics.planId, count: count(planEpics.epicId) }).from(planEpics).where(inArray(planEpics.planId, planIds)).groupBy(planEpics.planId)
      : [],
    // Tasks dropped in a revision keep a 'removed' row and aren't part of the plan
    planIds.length > 0
      ? db.select({ planId: planTasks.planId, count: count() }).from(planTasks).where(and(inArray(planTasks.planId, planIds), ne(planTasks.change, 'removed'))).groupBy(planTasks.planId)
      : []
  ])
  const sender = { name: pm?.name ?? 'PM', role: 'pm' as const }
  const epicsOf = new Map(epicCounts.map(e => [e.planId, e.count]))
  const tasksOf = new Map(taskCounts.map(t => [t.planId, t.count]))
  return waiting.map(({ session, attention, project, reply }) => {
    const { since, ...state } = threadAttention(attention, reply, epicsOf, tasksOf)
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
  })
}

// What a session waits on, with the data its status needs. A session with
// nothing waiting never gets here, so 'none' always has its reply.
function threadAttention(attention: SessionAttention, reply: { text: string, createdAt: Date } | undefined, epicsOf: Map<string, number>, tasksOf: Map<string, number>): PlanThreadAttention & { since: Date } {
  switch (attention.status) {
    case 'question': {
      const { text, recommendation, options, createdAt } = attention.question
      return { status: 'question', question: { text, recommendation, options }, plan: null, planId: null, reply: null, since: createdAt }
    }
    case 'needs_approval': {
      const { plan } = attention
      // Plans saved before plan_epics existed have no epic rows, only
      // plans.epicId, so count that as one epic.
      const summary = { id: plan.id, version: plan.version, title: plan.title, summary: plan.summary, epicCount: epicsOf.get(plan.id) ?? (plan.epicId ? 1 : 0), taskCount: tasksOf.get(plan.id) ?? 0 }
      return { status: 'needs_approval', question: null, plan: summary, planId: plan.id, reply: null, since: plan.createdAt }
    }
    case 'none':
      return { status: 'none', question: null, plan: null, planId: null, reply: reply!.text, since: reply!.createdAt }
  }
}

// Needs you's count for one number, without building the items. It shares
// what decides membership with `loadInbox`, so the two can't drift.
export async function inboxCount(db: Executor): Promise<number> {
  const [[open], threads, epicCount] = await Promise.all([
    db.select({ n: count() }).from(tasks).where(openTaskFilter()),
    waitingSessions(db),
    countEpicItems(db)
  ])
  return open!.n + threads.length + epicCount
}

function openTaskFilter(taskId?: string) {
  return and(inArray(tasks.status, ['human_review', 'blocked', 'failed']), isNull(tasks.deletedAt), taskId ? eq(tasks.id, taskId) : undefined)
}

type OpenTask = typeof tasks.$inferSelect
type TransitionEntry = NonNullable<ReturnType<Awaited<ReturnType<typeof taskTransitions>>['get']>>[number]

async function taskTransitions(db: Executor, taskIds: string[]) {
  const rows = taskIds.length > 0
    ? await db.select({ id: auditLog.id, taskId: auditLog.taskId, actor: auditLog.actor, detail: auditLog.detail, createdAt: auditLog.createdAt }).from(auditLog)
        .where(and(inArray(auditLog.taskId, taskIds), eq(auditLog.action, 'task.transition')))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    : []
  return Map.groupBy(rows, r => r.taskId!)
}

// The tasks waiting on the human, each with its transition history, newest
// first, and when and how it arrived. The item arrived when the task entered
// its status: updates that keep the status (a PR head moving, an edit) don't
// move it.
async function openTasks(db: Executor, taskId?: string) {
  const open = await db.select({ task: tasks, project: projects }).from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(openTaskFilter(taskId))
  const histories = await taskTransitions(db, open.map(o => o.task.id))
  const decisions = await waitingDecisions(db, open.filter(o => o.task.status === 'blocked').map(o => o.task.id))
  return open.map(({ task, project }) => {
    const history = histories.get(task.id) ?? []
    const arrivals = history.filter((e) => {
      const { from, to } = e.detail as { from?: unknown, to?: unknown }
      return to === task.status && from !== task.status
    })
    const entered = arrivals[0]
    // A Blocked task whose reason came from the agent's own report is a question
    const stuck = task.status === 'blocked' && readAudit(entered?.detail).event === 'stuck'
    // An epic rebase's decision is a question too, whoever raised it
    const decision = decisions.get(task.id) ?? null
    const type: TaskInboxItemType = task.status === 'human_review' ? 'human_review' : task.status === 'failed' ? 'failed' : stuck || decision ? 'question' : 'blocked'
    const at = (entered?.createdAt ?? task.updatedAt).toISOString()
    return { task, project, history, type, decision, at, arrival: arrivalKey({ id: task.id, type, at }, arrivals) }
  })
}

type Open = Awaited<ReturnType<typeof openTasks>>[number]

export async function taskMessageItems(db: Executor, taskId?: string): Promise<TaskInboxItem[]> {
  return withMessages(db, await prepareTaskItems(db, await openTasks(db, taskId)))
}

// The arrivals that have no message yet, for InboxMessages. Tasks already
// claimed cost two queries and skip building their items.
export async function unclaimedTaskItems(db: Executor, taskId?: string): Promise<PreparedItem<TaskInboxItem>[]> {
  const open = await openTasks(db, taskId)
  const stored = await storedMessages(db, open.map(o => o.arrival))
  return prepareTaskItems(db, open.filter(o => !stored.has(o.arrival)))
}

async function prepareTaskItems(db: Executor, open: Open[]): Promise<PreparedItem<TaskInboxItem>[]> {
  if (open.length === 0) return []
  const ids = open.map(o => o.task.id)
  const actions = new Map(open.map(o => [o.task.id, humanAction(o.history)]))
  const inReview = open.filter(o => o.task.status === 'human_review').map(o => o.task)
  const pullRequests = inReview.filter(t => t.type !== 'spike' && t.type !== 'design').map(t => t.id)
  const designs = open.filter(o => o.task.type === 'design').map(o => o.task.id)
  const [lastRuns, evidence, comments, versions, approvals, humanCriteria] = await Promise.all([
    // The last run on the task is the sender
    db.selectDistinctOn([runs.taskId], { taskId: runs.taskId, name: agents.name, role: agents.role }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
      .where(inArray(runs.taskId, ids)).orderBy(runs.taskId, desc(runs.number)),
    listEvidenceFor(db, ids),
    listCommentsFor(db, open.filter(o => actions.get(o.task.id) || (o.task.status === 'human_review' && o.task.type === 'spike')).map(o => o.task.id)),
    designs.length > 0
      ? db.select({ id: schema.designVersions.id, taskId: schema.designVersions.taskId, version: schema.designVersions.version, status: schema.designVersions.status, createdAt: schema.designVersions.createdAt })
          .from(schema.designVersions).where(inArray(schema.designVersions.taskId, designs)).orderBy(desc(schema.designVersions.version))
      : [],
    pullRequests.length > 0
      ? db.selectDistinctOn([reviews.taskId], { taskId: reviews.taskId, criteria: reviews.criteria }).from(reviews)
          .where(and(inArray(reviews.taskId, pullRequests), eq(reviews.verdict, 'approved'))).orderBy(reviews.taskId, desc(reviews.createdAt))
      : [],
    pullRequests.length > 0
      ? db.select({ id: schema.acceptanceCriteria.id, taskId: schema.acceptanceCriteria.taskId }).from(schema.acceptanceCriteria)
          .where(and(inArray(schema.acceptanceCriteria.taskId, pullRequests), eq(schema.acceptanceCriteria.checkedByHuman, true)))
      : []
  ])
  const senders = new Map(lastRuns.map(r => [r.taskId, { name: r.name, role: r.role }]))
  const versionsOf = Map.groupBy(versions, v => v.taskId)
  const approvalOf = new Map(approvals.map(r => [r.taskId, r]))
  const humanCriteriaOf = Map.groupBy(humanCriteria, c => c.taskId)
  return open.map(({ task, project, type, decision, at, arrival }) => {
    const notes = comments.get(task.id) ?? []
    const taskVersions = versionsOf.get(task.id) ?? []
    // PR reviews get a short note; spikes show their findings. The
    // criteria and evidence sit right under it (design/inbox.md)
    const body = task.status === 'human_review'
      ? humanReviewNote(task, notes, taskVersions, approvalOf.get(task.id), humanCriteriaOf.get(task.id) ?? [])
      : (task.statusReason ?? '')
    const item: TaskInboxItem = {
      id: task.id,
      type,
      project: projectTag(project),
      taskId: task.id,
      taskRef: taskRef(project.prefix, task.number),
      subject: task.title,
      preview: (body || richTextToPlainText(task.description)).slice(0, 200),
      body,
      sender: senders.get(task.id) ?? { name: 'Corral', role: 'system' },
      at,
      prUrl: task.prUrl,
      resolution: null,
      ...decision && { decision },
      ...taskChanges(task, actions.get(task.id) ?? null, evidence.get(task.id) ?? [], notes, taskVersions)
    }
    return { item, arrival }
  })
}

// The human's last request for changes or answer, and the entry before it
function humanAction(history: TransitionEntry[]) {
  const index = history.findIndex(e => e.actor.kind === 'human' && HUMAN_ACTIONS.includes(readAudit(e.detail).event ?? ''))
  return index === -1 ? null : { entry: history[index]!, previous: history[index + 1] }
}

// What's new on a task since the human's last action (design/inbox.md)
function taskChanges(task: OpenTask, action: ReturnType<typeof humanAction>, evidence: Evidence[], notes: Comment[], versions: DesignVersionFacts[]): { since: InboxSince | null, newArtifacts: InboxArtifact[] } {
  const at = action?.entry.createdAt.toISOString() ?? null
  const newArtifacts = fileArtifacts(evidence, at)
  const latest = versions[0]
  if (task.type === 'design' && latest && isNew(latest.createdAt.toISOString(), at)) {
    newArtifacts.unshift({ id: latest.id, kind: 'design', name: `Design v${latest.version}`, url: designPreviewUrl(latest.id), taskRef: null, at: latest.createdAt.toISOString() })
  }
  if (!action || !at) return { since: null, newArtifacts }
  // An answer is the pinned comment the human wrote while the task waited for it
  const waitingSince = action.previous?.createdAt.toISOString() ?? ''
  const answer = notes.findLast(c => c.author.kind === 'human' && c.pinned && c.createdAt > waitingSince && c.createdAt <= at)
  const text = readAudit(action.entry.detail).feedback ?? answer?.body ?? null
  return { since: { at, text, notes: workNotes(notes, at), fixTasks: [] }, newArtifacts }
}

interface DesignVersionFacts { id: string, version: number, status: string, createdAt: Date }

function humanReviewNote(task: OpenTask, notes: Comment[], versions: DesignVersionFacts[], review: { criteria: { criterionId: string, met: boolean | null }[] } | undefined, humanCriteria: { id: string }[]): string {
  if (task.type === 'spike') return notes.findLast(c => c.body.startsWith('## Findings\n'))?.body ?? ''
  if (task.type === 'design') {
    const version = versions.find(v => v.status === 'submitted')
    return `Design${version ? ` v${version.version}` : ''} is ready for your approval. Approving opens a Plan session for the build.`
  }
  const humanChecks = humanCriteria.length
  if (humanChecks > 0) {
    const met = review?.criteria.filter(c => c.met && !humanCriteria.some(h => h.id === c.criterionId)).length ?? 0
    return `Approved, ${humanCheckTally(met, humanChecks)}. These checks need your OK before the task merges.`
  }
  const met = review ? `, ${review.criteria.length === 1 ? '1 criterion' : `all ${review.criteria.length} criteria`} met` : ''
  return `Approved${met}. This task is marked for human review, so it needs your OK before it merges.`
}

const projectColumns = { id: projects.id, slug: projects.slug, name: projects.name, prefix: projects.prefix, thumbnailColor: projects.thumbnailColor, thumbnailBlob: projects.thumbnailBlob }

function projectTag(project: Pick<typeof projects.$inferSelect, 'id' | 'slug' | 'name' | 'thumbnailColor' | 'thumbnailBlob'>) {
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
