import { arrivalKey, storedMessages, withMessages, type PreparedItem } from './inbox-message.ts'
import type { EpicConflictItem, EpicReviewActionInput, EpicReviewItem, EpicReviewReport, EpicReviewTask, InboxSince, RunJob } from '@corral/contracts'
import { ACTIVE_RUN_STATES, isActiveRun, feedbackFixTitle, FIX_TITLE_PREFIX, feedbackPoints, isTaskDone, LEASE_DURATION_MS, markdownToRichText, taskRef, type Actor, type CompletionState } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { appendAudit, auditEvent, auditText, readAudit } from './audit.ts'
import type { OrchestratorDeps } from './orchestrator.ts'
import { ApiFailure, notFound } from './errors.ts'
import { loadEpic } from './epics.ts'
import type { PullRequest } from './github.ts'
import { Backoff } from './retries.ts'
import { fileArtifacts, workNotes } from './inbox-changes.ts'
import { publishInvalidatedEpics, type InvalidatedEpics } from './epic-review-state.ts'
import { runEndValues, RUN_TIMEOUT_SECONDS } from './run-lifecycle.ts'
import { listEvidenceFor } from './runs.ts'
import { thumbnailUrl } from './projects.ts'
import { EPIC_REBASE_NO_GATES, EPIC_SQUASH_KEEPS_MIGRATIONS, EPIC_SQUASH_KEEPS_TRAILERS } from './prompts.ts'
import { commitUrl, createTask, listCommentsFor, loadTask, toTasks, type ProjectRow, type TaskRow } from './tasks.ts'

const { acceptanceCriteria, agents, auditLog, epics, projects, runs, tasks } = schema
const system: Actor = { kind: 'system', component: 'server' }
const REVIEW_FAILED = 'Integration review failed'
type EpicRow = typeof epics.$inferSelect
type RunRow = typeof runs.$inferSelect

export async function epicBoard(db: Executor, epicId: string) {
  const rows = await db.select().from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
  return rows.filter(t => t.status !== 'draft' && t.status !== 'backlog')
}

export const complete = (board: readonly CompletionState[]) => board.length > 0 && board.every(isTaskDone)

// Whether this PR needs integration review to start
function reviewDue(epic: EpicRow, pr: PullRequest): boolean {
  if (epic.prNumber && epic.prHeadSha === pr.headSha && epic.reviewState !== 'open' && epic.reviewState !== 'changes_requested') return false
  // Corral asked for this new head; the merge pass keeps the approval
  return !(epic.reviewState === 'ready_to_merge' && epic.rebaseRequested)
}

// How often a PR closed without merging is read, in case it's reopened
const CLOSED_POLL_MS = 120_000

export class EpicPullRequests {
  private d: OrchestratorDeps
  private closedPoll: Backoff
  constructor(deps: OrchestratorDeps) {
    this.d = deps
    this.closedPoll = new Backoff(CLOSED_POLL_MS, CLOSED_POLL_MS, () => this.now())
  }

  private now() { return this.d.now?.() ?? new Date() }

  // The scheduler already serializes passes. GitHub is read outside the
  // transaction, so a slow call holds no lock on the epic; the row lock then
  // rechecks everything against task additions and concurrent review reports.
  // Only an epic with no PR yet, or waiting for its fix work, can need a review
  // started here. The merge pass watches the head of every other PR.
  async reconcile(): Promise<void> {
    const { db } = this.d
    const candidates = await db.select({ epic: epics, project: projects }).from(epics)
      .innerJoin(projects, eq(projects.id, epics.projectId))
      .where(and(ne(epics.reviewMode, 'direct'), isNotNull(epics.branch), eq(projects.paused, false)))
    for (const { epic, project } of candidates) {
      if (epic.reviewState === 'merged' || (epic.prNumber && epic.reviewState !== 'open' && epic.reviewState !== 'changes_requested')) continue
      if (!this.closedPoll.due(epic.id)) continue
      await this.startReview(epic, project).catch(error => console.error(`Epic PR ${epic.id}:`, error))
    }
  }

  // The merge pass saw an epic PR's head move
  async headMoved(epicId: string): Promise<void> {
    const [row] = await this.d.db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, epicId))
    if (row) await this.startReview(row.epic, row.project)
  }

  private async startReview(candidate: EpicRow, project: ProjectRow): Promise<void> {
    const { db, github } = this.d
    const board = await epicBoard(db, candidate.id)
    if (!complete(board)) return
    // Safe to repeat if what follows fails: the next pass finds the open PR
    const pr = candidate.prNumber
      ? await github.getPullRequest(project.repository, candidate.prNumber)
      : await github.findOpenPullRequest(project.repository, candidate.branch!)
        ?? await github.openPullRequest(project.repository, {
          head: candidate.branch!, base: project.defaultBranch, title: candidate.title,
          body: await this.body(db, candidate, board, project)
        })
    if (pr.state !== 'open' || pr.merged) return this.closedPoll.later(candidate.id)
    this.closedPoll.clear(candidate.id)
    if (!reviewDue(candidate, pr)) return
    await github.updatePullRequest(project.repository, pr.number, { body: await this.body(db, candidate, board, project) })
    const changed = await db.transaction(async (tx) => {
      const [epic] = await tx.select().from(epics).where(eq(epics.id, candidate.id)).for('update')
      if (!epic || epic.reviewState === 'merged' || (epic.prNumber && epic.prNumber !== pr.number)) return false
      if (!reviewDue(epic, pr) || !complete(await epicBoard(tx, epic.id))) return false
      // A moved epic head invalidates approval, even if board membership
      // didn't change. Active runs on the old head are fenced by state.
      await tx.update(runs).set(runEndValues({ state: 'interrupted', error: 'Epic PR changed' }, this.now()))
        .where(and(eq(runs.epicId, epic.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      await tx.update(epics).set({ prNumber: pr.number, prHeadSha: pr.headSha, reviewState: 'in_review', rebaseRequested: false, conflictFiles: null, updatedAt: this.now() }).where(eq(epics.id, epic.id))
      await appendAudit(tx, { projectId: project.id, actor: system }, auditEvent('epic.pr', { epicId: epic.id, event: epic.prNumber ? 'review_started' : 'opened', prNumber: pr.number }))
      return true
    })
    if (changed) await this.publish(candidate.id)
  }

  private async body(db: Executor, epic: EpicRow, board: Awaited<ReturnType<typeof epicBoard>>, project: ProjectRow) {
    const criteria = await humanCriteria(db, board)
    const obligations = board.flatMap((t) => {
      const ref = taskRef(project.prefix, t.number)
      if (t.integrationProtocol === 0) return []
      return [...t.humanReview ? [`- [ ] ${ref}: reviewed by a human`] : [], ...criteria.filter(c => c.taskId === t.id).map(c => `- [ ] ${ref}: ${c.text}`)]
    })
    return [epic.description, '## Tasks and evidence', ...board.map((t) => {
      const ref = taskRef(project.prefix, t.number)
      return `- ${ref}: ${t.title}${t.prUrl ? ` ([PR](${t.prUrl}))` : t.mergeCommitSha ? ` ([${t.mergeCommitSha.slice(0, 10)}](${commitUrl(project, t.mergeCommitSha)}))` : ''} — [criteria and evidence](${this.d.publicUrl}/tasks/${ref})`
    }), ...obligations.length ? ['## Human checks for epic approval', 'Confirmed in Corral when approving the epic, not on this list.', obligations.join('\n')] : []].join('\n\n')
  }

  async claim(agentId: string, place: (tx: Executor) => Promise<string | null>): Promise<RunJob | null> {
    return this.d.db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
      if (!agent || agent.role !== 'reviewer' || agent.paused || (agent.pausedUntil && agent.pausedUntil > this.now())) return null
      const [active] = await tx.select({ n: count() }).from(runs).where(and(eq(runs.agentId, agent.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      if (active!.n >= agent.concurrency) return null
      const candidates = await tx.select({ epic: epics, project: projects }).from(epics)
        .innerJoin(projects, eq(projects.id, epics.projectId))
        .where(and(eq(epics.reviewState, 'in_review'), eq(projects.paused, false)))
        .orderBy(asc(epics.updatedAt)).for('update', { of: epics, skipLocked: true })
      for (const { epic, project } of candidates) {
        const [live] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.epicId, epic.id), inArray(runs.state, [...ACTIVE_RUN_STATES]))).limit(1)
        if (live || !epic.prHeadSha || !epic.branch || !complete(await epicBoard(tx, epic.id))) continue
        // No reviewer runner free: the epic stays in review for the next pass
        const runnerId = await place(tx)
        if (!runnerId) return null
        const [run] = await tx.insert(runs).values({ projectId: project.id, epicId: epic.id, agentId, role: 'reviewer', runnerId, leaseEpoch: 1, leaseExpiresAt: new Date(this.now().getTime() + LEASE_DURATION_MS), headSha: epic.prHeadSha, queuedAt: this.now() }).returning()
        const context = await epicReviewContext(tx, epic, project)
        return {
          runId: run!.id, runNumber: run!.number, leaseEpoch: 1, role: 'reviewer', runtime: agent.runtime,
          projectId: project.id, repository: project.repository, defaultBranch: project.defaultBranch, baseBranch: project.defaultBranch,
          taskId: null, taskRef: null, epicId: epic.id, branch: epic.branch, headSha: epic.prHeadSha,
          planSessionId: null, agentSessionId: null, fallbackPrompt: null, model: null, timeoutSeconds: RUN_TIMEOUT_SECONDS,
          prompt: `You are ${agent.name}, reviewing the integration of epic "${epic.title}".\n\n${JSON.stringify(context, null, 2)}\n\nReview the whole combined diff with git diff origin/${project.defaultBranch}...HEAD at commit ${epic.prHeadSha}. This is a read-only checkout: do not edit, commit or push. Check the epic goal and every task's criteria, looking for integration problems between tasks (API/UI mismatches, inconsistent docs, duplicate helpers). The evidence is context; do not re-judge individual task evidence. Criteria checked by a human and tasks flagged humanReview wait for the human at this epic's approval: do not attempt them, produce evidence or verdicts for them, or request changes over them. Use get_task for the whole epic and get_evidence to fetch any listed evidence ID. Rerun the project's lint, typecheck, tests and build as gates WITHOUT THE CACHE (for Turbo use --force). Always finish with report_outcome, outcome approved or changes_requested, and specific reasoning in summary. No per-task criteria verdicts are required. Changes requested create a fix task in the epic; approval sends the epic PR to human review.`
        }
      }
      return null
    })
  }

  async report(run: RunRow, report: EpicReviewReport): Promise<void> {
    const { outcome } = report
    let fixId: string | null = null
    // GitHub first, holding no lock. The verdict only moves the epic on: the
    // merge pass reads the head again, under the lock, before anything merges.
    const [found] = await this.d.db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, run.epicId!))
    if (!found || found.epic.reviewState !== 'in_review' || found.epic.prHeadSha !== run.headSha) throw new Error('Epic changed during review; this verdict is stale')
    const pr = await this.d.github.getPullRequest(found.project.repository, found.epic.prNumber!)
    if (pr.state !== 'open' || pr.merged || pr.headSha !== run.headSha) throw new Error('Epic PR head changed; this verdict is stale')
    await this.d.db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, run.projectId)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, run.epicId!)).for('update')
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for('update')
      if (!project || !epic || !current || !isActiveRun(current.state) || epic.reviewState !== 'in_review' || epic.prHeadSha !== run.headSha || !complete(await epicBoard(tx, epic.id))) throw new Error('Epic changed during review; this verdict is stale')
      const actor: Actor = { kind: 'agent', role: 'reviewer', runId: run.id }
      await tx.update(runs).set(runEndValues({ state: 'completed', outcome, summary: report.summary }, this.now())).where(eq(runs.id, run.id))
      await tx.update(epics).set({ reviewState: report.outcome === 'approved' ? 'human_review' : 'changes_requested', updatedAt: this.now() }).where(eq(epics.id, epic.id))
      if (report.outcome === 'changes_requested') fixId = await createEpicFixTask(tx, project, epic, report.summary, actor)
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId: epic.id, event: outcome, headSha: run.headSha, summary: report.summary }))
    })
    if (fixId) this.d.events.publish({ type: 'task.created', task: await loadTask(this.d.db, fixId) })
    await this.publish(run.epicId!)
  }

  // D10's failed-run cap for integration reviews, whose runs have no task to
  // count on: this many failures in a row on one head stop the retries and
  // put the PR in front of the human. D27 has no failed state, so it's Human
  // review, where a refused merge also lands. Call before ending the run, in
  // its transaction: the epic's lock comes first, as it does in `report`.
  async reviewFailed(tx: Executor, run: RunRow, error: string): Promise<boolean> {
    const [epic] = await tx.select().from(epics).where(eq(epics.id, run.epicId!)).for('update')
    if (epic?.reviewState !== 'in_review' || epic.prHeadSha !== run.headSha) return false
    const [project] = await tx.select({ failedRunCap: projects.failedRunCap }).from(projects).where(eq(projects.id, run.projectId))
    const cap = project!.failedRunCap
    const recent = await tx.select({ state: runs.state }).from(runs)
      .where(and(eq(runs.epicId, epic.id), eq(runs.headSha, epic.prHeadSha!), ne(runs.id, run.id), inArray(runs.state, ['failed', 'completed'])))
      .orderBy(desc(runs.number)).limit(cap - 1)
    if (recent.length < cap - 1 || recent.some(r => r.state !== 'failed')) return false
    await tx.update(epics).set({ reviewState: 'human_review', updatedAt: this.now() }).where(eq(epics.id, epic.id))
    await appendAudit(tx, { projectId: run.projectId, actor: system }, auditEvent('epic.pr', { epicId: epic.id, event: 'review_failed', headSha: epic.prHeadSha, summary: `${REVIEW_FAILED} ${cap} times on this commit. The last run: ${error}` }))
    return true
  }

  async humanAction(epicId: string, input: EpicReviewActionInput, actor: Actor) {
    if (!/^[0-9a-f-]{36}$/i.test(epicId)) throw notFound()
    if (actor.kind !== 'human') throw new ApiFailure(409, { code: 'conflict', constraint: 'human_only' })
    if (input.action === 'rebase') return this.handOffRebase(epicId, input.headSha, actor)
    let fixId: string | null = null
    // GitHub first, holding no lock; approving only moves the epic on, and
    // the merge pass reads the head again under the lock
    const [found] = await this.d.db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, epicId))
    if (!found) throw notFound()
    if (found.epic.reviewState !== 'human_review' || found.epic.prHeadSha !== input.headSha) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_review_changed' })
    const pr = await this.d.github.getPullRequest(found.project.repository, found.epic.prNumber!)
    if (pr.headSha !== input.headSha || pr.state !== 'open' || pr.merged) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_pr_changed' })
    await this.d.db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, found.project.id)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
      if (!project || !epic || epic.reviewState !== 'human_review' || epic.prHeadSha !== input.headSha || !complete(await epicBoard(tx, epic.id))) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_review_changed' })
      if (input.action === 'request_changes' && !input.text?.trim()) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ message: 'Describe the changes needed' }] })
      // D27: flagged tasks and human checks are obligations of this approval.
      // Read under the epic lock, so a later change to the board can't slip past.
      const required = await humanObligations(tx, await epicBoard(tx, epic.id))
      const confirmedCriteria = input.confirmedCriteria ?? []
      const confirmedTasks = input.confirmedTasks ?? []
      if (input.action === 'approve' && required.some(r => (r.humanReview && !confirmedTasks.includes(r.taskId)) || r.humanChecks.some(id => !confirmedCriteria.includes(id)))) {
        throw new ApiFailure(409, { code: 'conflict', constraint: 'human_checks_unconfirmed' })
      }
      await tx.update(epics).set({ reviewState: input.action === 'approve' ? 'ready_to_merge' : 'changes_requested', updatedAt: this.now() }).where(eq(epics.id, epic.id))
      if (input.action === 'request_changes') fixId = await createEpicFixTask(tx, project, epic, input.text!.trim(), actor)
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId, event: input.action === 'approve' ? 'human_approved' : 'human_changes_requested', headSha: input.headSha, summary: input.text ?? '', ...(input.action === 'approve' && { confirmedCriteria: required.flatMap(r => r.humanChecks), confirmedTasks: required.filter(r => r.humanReview).map(r => r.taskId) }) }))
    })
    if (fixId) this.d.events.publish({ type: 'task.created', task: await loadTask(this.d.db, fixId) })
    await this.publish(epicId)
    return { ok: true }
  }

  // D27: the human hands a conflict to a developer run. The task's branch is
  // the epic branch, so its run rebases and force-pushes that branch. When
  // the task is Merged, the head has moved and integration review starts over.
  private async handOffRebase(epicId: string, headSha: string, actor: Actor) {
    const invalidatedEpics: InvalidatedEpics = new Map()
    const taskId = await this.d.db.transaction(async (tx) => {
      const [found] = await tx.select().from(epics).where(eq(epics.id, epicId))
      if (!found) throw notFound()
      const [project] = await tx.select().from(projects).where(eq(projects.id, found.projectId)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
      if (!project || !epic || epic.reviewState !== 'conflict' || epic.prHeadSha !== headSha) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_review_changed' })
      const target = project.defaultBranch
      const files = epic.conflictFiles?.length ? epic.conflictFiles.join(', ') : 'the files git reports'
      const resolve = `Resolve the conflicts in ${files}, keeping both sides' intent and never reverting what ${target} just merged. No feature changes.`
      const pushed = 'Corral force-pushes the epic branch with --force-with-lease, and no separate PR is opened.'
      // Without required CI nothing else would verify the gates
      const squash = project.requiredChecks.length > 0
      const text = squash
        ? `Squash the epic branch ${epic.branch} into one commit on its merge base with origin/${target}, then rebase that commit onto origin/${target}, so each conflict is resolved once. Epic PRs always squash on merge, so the individual commits aren't kept anyway. ${EPIC_SQUASH_KEEPS_TRAILERS} ${EPIC_SQUASH_KEEPS_MIGRATIONS} Never merge ${target} in. ${resolve} ${EPIC_REBASE_NO_GATES} Report pr_updated; ${pushed}`
        : `Rebase the epic branch ${epic.branch} onto origin/${target}: git fetch origin && git rebase origin/${target}. Never merge ${target} in. ${resolve} Run the project's gates, then report pr_updated; ${pushed}`
      const criterion = `${epic.branch} is ${squash ? 'squashed to one commit keeping every Corral-Submission trailer and ' : ''}rebased onto origin/${target} with no merge commits, and the conflicts in ${files} are resolved keeping both sides' intent`
      const id = await createTask(tx, project, { type: 'task', title: `Rebase epic: ${epic.title}`.slice(0, 200), description: paragraph(text), epicId: epic.id, acceptanceCriteria: [criterion] }, actor, { epicFix: true, invalidatedEpics })
      await tx.update(tasks).set({ branch: epic.branch }).where(eq(tasks.id, id))
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId, event: 'rebase_handed_off', headSha }))
      return id
    })
    this.d.events.publish({ type: 'task.created', task: await loadTask(this.d.db, taskId) })
    await publishInvalidatedEpics(this.d.db, this.d.events, invalidatedEpics)
    return { ok: true }
  }

  async publish(id: string) {
    this.d.events.publish({ type: 'epic.updated', epic: await loadEpic(this.d.db, id) })
  }
}

const paragraph = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

export async function createEpicFixTask(tx: Executor, project: ProjectRow, epic: EpicRow, feedback: string, actor: Actor) {
  return createTask(tx, project, { type: 'task', title: feedbackFixTitle(feedback), description: markdownToRichText(feedback), epicId: epic.id, acceptanceCriteria: feedbackPoints(feedback) }, actor, { epicFix: true })
}

function humanCriteria(db: Executor, board: Awaited<ReturnType<typeof epicBoard>>) {
  if (board.length === 0) return Promise.resolve([])
  return db.select({ id: acceptanceCriteria.id, taskId: acceptanceCriteria.taskId, text: acceptanceCriteria.text }).from(acceptanceCriteria)
    .where(and(inArray(acceptanceCriteria.taskId, board.map(t => t.id)), eq(acceptanceCriteria.checkedByHuman, true))).orderBy(asc(acceptanceCriteria.position))
}

// What each PR-free task leaves for the epic's human approval. Task-PR tasks
// had human review on their own path. Agent approval can't stand in (D28).
export async function humanObligations(db: Executor, board: Awaited<ReturnType<typeof epicBoard>>) {
  const criteria = await humanCriteria(db, board)
  return board.filter(t => t.integrationProtocol > 0).map(t => ({ taskId: t.id, humanReview: t.humanReview, humanChecks: criteria.filter(c => c.taskId === t.id).map(c => c.id) }))
}

export async function epicReviewContext(db: Executor, epic: EpicRow, project: ProjectRow) {
  const rows = await epicBoard(db, epic.id)
  return { epicId: epic.id, title: epic.title, goal: epic.description, branch: epic.branch, headSha: epic.prHeadSha,
    tasks: (await boardsWithEvidence(db, [{ project, rows }]))[0]! }
}

type EpicBoard = EpicReviewTask[]

// API tasks with their evidence and human obligations for several boards at
// once, one per input
async function boardsWithEvidence(db: Executor, boards: { project: ProjectRow, rows: TaskRow[] }[]): Promise<EpicBoard[]> {
  const [built, required] = await Promise.all([
    Promise.all(boards.map(({ project, rows }) => toTasks(db, project, rows))),
    humanObligations(db, boards.flatMap(b => b.rows))
  ])
  const evidence = await listEvidenceFor(db, built.flat().map(t => t.id))
  const owedOf = new Map(required.map(r => [r.taskId, r]))
  return built.map(board => board.map((task) => {
    const owed = owedOf.get(task.id)
    return { task, evidence: evidence.get(task.id) ?? [], humanReview: owed?.humanReview ?? false, humanChecks: owed?.humanChecks ?? [] }
  }))
}

// The events an Inbox item for an epic can arrive by, and the one it compares
// its changes against
const ARRIVAL_EVENTS = { epic_review: ['approved', 'merge_refused', 'review_failed'], epic_conflict: ['conflict'] }
const CHANGES_EVENT = 'human_changes_requested'

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
  // The fix task the request created shares its transaction, and so its time
  const fixTasks = board.filter(({ task }) => task.title.startsWith(FIX_TITLE_PREFIX) && task.createdAt >= at).map(({ task }) => ({ id: task.id, ref: task.ref, title: task.title }))
  const since: InboxSince = { at, text: readAudit(action.detail).summary || null, notes: notes.sort((a, b) => a.at.localeCompare(b.at)), fixTasks }
  return { since, newArtifacts }
}

// The epics waiting on the human: an integration-approved PR on a complete
// board, or a conflict. Everything that decides membership is here, so the
// Inbox and its count agree. Editing an epic while it waits does not
// constitute a new arrival.
async function waitingEpics(db: Executor, epicId?: string) {
  const rows = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId))
    .where(and(inArray(epics.reviewState, ['human_review', 'conflict']), epicId ? eq(epics.id, epicId) : undefined))
  const open = rows.filter(({ epic }) => epic.prNumber && epic.prHeadSha)
  if (open.length === 0) return []
  const ids = open.map(r => r.epic.id)
  const [boardRows, approvals, failures] = await Promise.all([
    db.select().from(tasks).where(and(inArray(tasks.epicId, ids), isNull(tasks.deletedAt))).orderBy(asc(tasks.number)),
    // Not tied to the head: a merge GitHub refused comes back here after a clean rebase
    db.selectDistinctOn([runs.epicId], { epicId: runs.epicId, summary: runs.summary, agent: agents.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(inArray(runs.epicId, ids), eq(runs.outcome, 'approved'))).orderBy(runs.epicId, desc(runs.number)),
    // Why integration review gave up, if it did
    db.select({ epicId: auditText('epic.pr', 'epicId'), headSha: sql<string | null>`${auditLog.detail}->>'headSha'`, detail: auditLog.detail }).from(auditLog)
      .where(and(eq(auditLog.action, 'epic.pr'), inArray(auditText('epic.pr', 'epicId'), ids), sql`${auditText('epic.pr', 'event')} = 'review_failed'`))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
  ])
  const boards = Map.groupBy(boardRows.filter(t => t.status !== 'draft' && t.status !== 'backlog'), t => t.epicId!)
  const approvalOf = new Map(approvals.map(a => [a.epicId, a]))
  return open.flatMap(({ epic, project }) => {
    const board = boards.get(epic.id) ?? []
    const review = approvalOf.get(epic.id)
    if (epic.reviewState === 'conflict') return [{ epic, project, board, review, failure: null }]
    const given = failures.find(f => f.epicId === epic.id && f.headSha === epic.prHeadSha)
    const failure = given ? readAudit(given.detail).summary ?? REVIEW_FAILED : null
    return complete(board) && (review || failure) ? [{ epic, project, board, review, failure }] : []
  })
}

export async function countEpicItems(db: Executor): Promise<number> {
  return (await waitingEpics(db)).length
}

async function prepareEpicItems(db: Executor, epicId?: string): Promise<PreparedItem<EpicReviewItem | EpicConflictItem>[]> {
  const waiting = await waitingEpics(db, epicId)
  const entries = await epicEntries(db, waiting.map(w => w.epic.id))
  const boards = await boardsWithEvidence(db, waiting.map(({ project, board }) => ({ project, rows: board })))
  const changed = waiting.flatMap(({ epic }, i) => entries.get(epic.id)?.some(e => e.event === CHANGES_EVENT) ? boards[i]!.map(b => b.task.id) : [])
  const comments = await listCommentsFor(db, changed)
  const items = waiting.map(({ epic, project, review, failure }, i): PreparedItem<EpicReviewItem | EpicConflictItem> => {
    const type = epic.reviewState === 'conflict' ? 'epic_conflict' : 'epic_review'
    const all = entries.get(epic.id) ?? []
    const arrivals = all.filter(e => ARRIVAL_EVENTS[type].includes(e.event ?? ''))
    const at = (arrivals[0]?.createdAt ?? epic.updatedAt).toISOString()
    const shared = {
      id: epic.id, epicId: epic.id, taskId: null, taskRef: null, subject: epic.title,
      project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: thumbnailUrl(project) },
      at, prUrl: `https://github.com/${project.repository}/pull/${epic.prNumber}`, resolution: null, headSha: epic.prHeadSha!,
      ...epicChanges(all, boards[i]!, comments)
    }
    if (type === 'epic_review') {
      const verdict = failure ?? review?.summary ?? 'Integration approved'
      return { item: { ...shared, type, preview: verdict, body: verdict, sender: failure || !review ? { name: 'Corral', role: 'system' } : { name: review.agent, role: 'reviewer' }, tasks: boards[i]! }, arrival: arrivalKey({ id: epic.id, type, at }, arrivals) }
    }
    const files = epic.conflictFiles ?? []
    const body = `The epic PR can't rebase onto ${project.defaultBranch}. ${files.length ? `Conflicting files: ${files.join(', ')}.` : 'Corral couldn\'t work out which files conflict; the PR on GitHub shows them.'}`
    return { item: { ...shared, type, preview: body, body, sender: { name: 'Corral', role: 'system' }, targetBranch: project.defaultBranch, files }, arrival: arrivalKey({ id: epic.id, type, at }, arrivals) }
  })
  // Reviews first, then conflicts
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
