import type { EpicConflictItem, EpicPrEvent, EpicReviewItem, InboxSince } from '@corral/contracts'
import { ACTIVE_OPERATION_STATES, boardComplete, isOnBoard, type EpicRebaseDecision } from '@corral/core'
import { schema, type EpicRow, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { auditText, readAudit } from './audit.ts'
import { listCommentsFor } from './comments.ts'
import { boardsWithEvidence, CHANGES_EVENT, listEpicRounds, REVIEW_FAILED, type EpicBoard } from './epic-review.ts'
import { pullRequestUrl, treeUrl } from './github-urls.ts'
import { fileArtifacts, workNotes } from './inbox-changes.ts'
import { arrivalKey, storedMessages, withMessages, type PreparedItem } from './inbox-message.ts'
import { openDecision, rebasingEpics } from './operations.ts'
import { projectTag } from './projects.ts'

// The Inbox items for tasks with subtasks: an integration-approved PR waiting
// on the human, and a rebase or fix that needs them

const { agents, auditLog, epics, projects, runs, taskIntegrationOperations: operations, tasks } = schema

// The events an Inbox item for an epic can arrive by, and the one it compares
// its changes against
const ARRIVAL_EVENTS: Record<'epic_review' | 'epic_conflict', readonly string[]> = {
  epic_review: ['approved', 'merge_refused', 'review_failed'] satisfies readonly EpicPrEvent[],
  epic_conflict: ['conflict', 'decision_requested', 'sync_failed'] satisfies readonly EpicPrEvent[]
}

// Each epic's Inbox-relevant audit entries, newest first
async function epicEntries(db: Executor, epicIds: string[]) {
  if (epicIds.length === 0) return new Map<string, { id: number, event: string | null, detail: unknown, createdAt: Date }[]>()
  const epicId = auditText('epic.pr', 'epicId')
  const event = auditText('epic.pr', 'event')
  const rows = await db.select({ id: auditLog.id, epicId, event, detail: auditLog.detail, createdAt: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.action, 'epic.pr'), inArray(epicId, epicIds), inArray(event, [...ARRIVAL_EVENTS.epic_review, ...ARRIVAL_EVENTS.epic_conflict, CHANGES_EVENT])))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
  return Map.groupBy(rows, r => r.epicId!)
}

type EpicEntry = NonNullable<ReturnType<Awaited<ReturnType<typeof epicEntries>>['get']>>[number]

// What's new on an epic since the human last requested changes on its PR
// (design/inbox.md). Each task's files and notes are labelled with the task.
function epicChanges(entries: EpicEntry[], board: EpicBoard, comments: Awaited<ReturnType<typeof listCommentsFor>>) {
  const action = entries.find(e => e.event === CHANGES_EVENT)
  const at = action?.createdAt.toISOString() ?? null
  const newArtifacts = board.flatMap(({ task, evidence }) => fileArtifacts(evidence, at, task.ref))
  if (!action || !at) return { since: null, newArtifacts }
  const notes = board.flatMap(({ task }) => workNotes(comments.get(task.id) ?? [], at, task.ref))
  // Snapshot the request's tasks, even if later renamed or removed. Older
  // audit records have no links; never guess them from a title or timestamp.
  const fixTasks = readAudit(action.detail).fixTasks ?? []
  const since: InboxSince = { at, text: readAudit(action.detail).summary || null, notes: notes.sort((a, b) => a.at.localeCompare(b.at)), fixTasks }
  return { since, newArtifacts }
}

// The epics waiting on the human: an integration-approved PR on a complete
// board, or a conflict. Everything that decides membership is here, so the
// Inbox and its count agree. Editing an epic while it waits does not
// constitute a new arrival.
async function waitingEpics(db: Executor, epicId?: string) {
  // An epic fix's question, on an epic that may have no PR yet (D29)
  const asking = await db.select().from(operations).where(and(isNotNull(operations.fix), inArray(operations.state, [...ACTIVE_OPERATION_STATES]), epicId ? eq(operations.epicId, epicId) : undefined))
  const decisionOf = new Map(asking.flatMap((o): [string, EpicRebaseDecision][] => {
    const decision = openDecision(o)
    return decision ? [[o.epicId, decision]] : []
  }))
  const fixOf = new Map(asking.map(o => [o.epicId, o.fix]))
  const rows = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId))
    .where(and(or(inArray(epics.reviewState, ['human_review', 'conflict']), isNotNull(epics.syncError), decisionOf.size ? inArray(epics.id, [...decisionOf.keys()]) : undefined), epicId ? eq(epics.id, epicId) : undefined))
  const open = rows.filter(({ epic }) => epic.reviewState !== 'merged' && (decisionOf.has(epic.id) || epic.syncError || (epic.prNumber && epic.prHeadSha)))
  if (open.length === 0) return []
  const ids = open.map(r => r.epic.id)
  const [boardRows, approvals, failures, rebasing] = await Promise.all([
    db.select().from(tasks).where(and(inArray(tasks.epicId, ids), isNull(tasks.deletedAt))).orderBy(asc(tasks.number)),
    // Not tied to the head: a merge GitHub refused comes back here after a clean rebase
    db.selectDistinctOn([runs.epicId], { epicId: runs.epicId, summary: runs.summary, agent: agents.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(inArray(runs.epicId, ids), eq(runs.outcome, 'approved'))).orderBy(runs.epicId, desc(runs.number)),
    // Why integration review gave up, if it did
    db.select({ epicId: auditText('epic.pr', 'epicId'), headSha: sql<string | null>`${auditLog.detail}->>'headSha'`, detail: auditLog.detail }).from(auditLog)
      .where(and(eq(auditLog.action, 'epic.pr'), inArray(auditText('epic.pr', 'epicId'), ids), sql`${auditText('epic.pr', 'event')} = 'review_failed'`))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id)),
    rebasingEpics(db, ids)
  ])
  const boards = Map.groupBy(boardRows.filter(t => isOnBoard(t.status)), t => t.epicId!)
  const approvalOf = new Map(approvals.map(a => [a.epicId, a]))
  return open.flatMap(({ epic, project }): { epic: EpicRow, project: ProjectRow, board: TaskRow[], review: { epicId: string | null, summary: string | null, agent: string } | undefined, failure: string | null, decision: EpicRebaseDecision | null, stopped: EpicConflictItem['stopped'] | null }[] => {
    const board = boards.get(epic.id) ?? []
    const review = approvalOf.get(epic.id)
    const decision = decisionOf.get(epic.id)
    if (decision) return [{ epic, project, board, review, failure: null, decision, stopped: null }]
    // Exhausted recovery stays in front of the human until Retry or the merge
    if (epic.syncError) return [{ epic, project, board, review, failure: null, decision: null, stopped: { error: epic.syncError, fix: fixOf.get(epic.id) ?? null } }]
    if (epic.reviewState === 'conflict') return [{ epic, project, board, review, failure: null, decision: null, stopped: null }]
    if (rebasing.has(epic.id)) return []
    const given = failures.find(f => f.epicId === epic.id && f.headSha === epic.prHeadSha)
    const failure = given ? readAudit(given.detail).summary ?? REVIEW_FAILED : null
    return boardComplete(board) && (review || failure) ? [{ epic, project, board, review, failure, decision: null, stopped: null }] : []
  })
}

async function prepareEpicItems(db: Executor, epicId?: string): Promise<PreparedItem<EpicReviewItem | EpicConflictItem>[]> {
  const waiting = await waitingEpics(db, epicId)
  const entries = await epicEntries(db, waiting.map(w => w.epic.id))
  const boards = await boardsWithEvidence(db, waiting.map(({ project, board }) => ({ project, rows: board })))
  const changed = waiting.flatMap(({ epic }, i) => entries.get(epic.id)?.some(e => e.event === CHANGES_EVENT) ? boards[i]!.map(b => b.task.id) : [])
  const comments = await listCommentsFor(db, changed)
  const rounds = await Promise.all(waiting.map(({ epic }) => listEpicRounds(db, epic.id)))
  const items = waiting.map(({ epic, project, review, failure, decision, stopped }, i): PreparedItem<EpicReviewItem | EpicConflictItem> => {
    const type = decision || stopped || epic.reviewState === 'conflict' ? 'epic_conflict' : 'epic_review'
    const all = entries.get(epic.id) ?? []
    const arrivals = all.filter(e => ARRIVAL_EVENTS[type].includes(e.event ?? ''))
    const at = (arrivals[0]?.createdAt ?? epic.updatedAt).toISOString()
    const shared = {
      id: epic.id, epicId: epic.id, taskId: null, taskRef: null, subject: epic.title,
      project: projectTag(project),
      at, prUrl: epic.prNumber ? pullRequestUrl(project.repository, epic.prNumber) : treeUrl(project.repository, epic.branch!), resolution: null, unread: true, headSha: epic.prHeadSha ?? epic.branch ?? epic.id,
      ...epicChanges(all, boards[i]!, comments)
    }
    if (type === 'epic_review') {
      const verdict = failure ?? review?.summary ?? 'Integration approved'
      return { item: { ...shared, type, preview: verdict, body: verdict, sender: failure || !review ? { name: 'Corral', role: 'system' } : { name: review.agent, role: 'reviewer' }, tasks: boards[i]!, reviewRounds: rounds[i]!, findings: rounds[i]!.at(-1)?.findings ?? [] }, arrival: arrivalKey({ id: epic.id, type, at }, arrivals) }
    }
    const files = epic.conflictFiles ?? []
    if (decision) {
      return { item: { ...shared, type, preview: decision.question, body: decision.question, sender: { name: 'Corral', role: 'system' }, targetBranch: project.defaultBranch, files: epic.conflictFiles ?? [], decision }, arrival: arrivalKey({ id: epic.id, type, at }, arrivals) }
    }
    if (stopped) {
      const body = `Automatic recovery on this task has stopped. ${stopped.error} Retry starts it again; nothing moves until then.`
      return { item: { ...shared, type, preview: stopped.error, body, sender: { name: 'Corral', role: 'system' }, targetBranch: project.defaultBranch, files, stopped }, arrival: arrivalKey({ id: epic.id, type, at }, arrivals) }
    }
    const body = `The task's PR can't rebase onto ${project.defaultBranch}. ${files.length ? `Conflicting files: ${files.join(', ')}.` : 'Corral couldn\'t work out which files conflict; the PR on GitHub shows them.'}`
    return { item: { ...shared, type, preview: body, body, sender: { name: 'Corral', role: 'system' }, targetBranch: project.defaultBranch, files }, arrival: arrivalKey({ id: epic.id, type, at }, arrivals) }
  })
  return items.sort((a, b) => Number(a.item.type === 'epic_conflict') - Number(b.item.type === 'epic_conflict'))
}

export async function epicInboxItems(db: Executor, epicId?: string): Promise<(EpicReviewItem | EpicConflictItem)[]> {
  return withMessages(db, await prepareEpicItems(db, epicId))
}

// The arrivals that have no message yet, for InboxMessages
export async function unclaimedEpicItems(db: Executor, epicId?: string): Promise<PreparedItem<EpicReviewItem | EpicConflictItem>[]> {
  const prepared = await prepareEpicItems(db, epicId)
  const stored = await storedMessages(db, prepared.map(p => p.arrival))
  return prepared.filter(p => !stored.has(p.arrival))
}
