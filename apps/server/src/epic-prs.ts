import { withMessage } from './inbox-message.ts'
import type { EpicConflictItem, EpicReviewActionInput, EpicReviewItem, EpicReviewReport, EpicReviewTask, InboxSince, RunJob } from '@corral/contracts'
import { ACTIVE_RUN_STATES, feedbackFixTitle, feedbackPoints, isTaskDone, LEASE_DURATION_MS, markdownToRichText, taskRef, type Actor, type CompletionState } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { appendAudit, auditEvent, auditText, readAudit } from './audit.ts'
import type { OrchestratorDeps } from './orchestrator.ts'
import { ApiFailure, notFound } from './errors.ts'
import { getEpic } from './epics.ts'
import { fileArtifacts, workNotes } from './inbox-changes.ts'
import { runEndValues } from './run-lifecycle.ts'
import { listEvidence } from './runs.ts'
import { thumbnailUrl } from './projects.ts'
import { commitUrl, createTask, listComments, loadTask, toTasks, type ProjectRow } from './tasks.ts'

const { acceptanceCriteria, agents, auditLog, epicReviewRounds, epics, projects, runs, tasks } = schema
const system: Actor = { kind: 'system', component: 'server' }
type EpicRow = typeof epics.$inferSelect
type RunRow = typeof runs.$inferSelect

export async function epicBoard(db: Executor, epicId: string) {
  const rows = await db.select().from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
  return rows.filter(t => t.status !== 'draft' && t.status !== 'backlog')
}

export const complete = (board: readonly CompletionState[]) => board.length > 0 && board.every(isTaskDone)

export class EpicPullRequests {
  private d: OrchestratorDeps
  constructor(deps: OrchestratorDeps) { this.d = deps }
  private now() { return this.d.now?.() ?? new Date() }

  // The scheduler already serializes passes. Row locks also protect this
  // path against task additions and concurrent review reports.
  async reconcile(): Promise<void> {
    const { db } = this.d
    const candidates = await db.select({ epic: epics, project: projects }).from(epics)
      .innerJoin(projects, eq(projects.id, epics.projectId))
      .where(and(ne(epics.reviewMode, 'direct'), isNotNull(epics.branch), eq(projects.paused, false)))
    for (const { epic: candidate, project } of candidates) {
      if (candidate.reviewState === 'merged') continue
      try {
        let changed = false
        await db.transaction(async (tx) => {
          const [epic] = await tx.select().from(epics).where(eq(epics.id, candidate.id)).for('update')
          if (!epic || epic.reviewState === 'merged') return
          const board = await epicBoard(tx, epic.id)
          if (!complete(board)) return
          const pr = epic.prNumber
            ? await this.d.github.getPullRequest(project.repository, epic.prNumber)
            : await this.d.github.findOpenPullRequest(project.repository, epic.branch!)
              ?? await this.d.github.openPullRequest(project.repository, {
                head: epic.branch!, base: project.defaultBranch, title: epic.title,
                body: await this.body(tx, epic, board, project)
              })
          if (pr.state !== 'open' || pr.merged) return
          if (epic.prNumber && epic.prHeadSha === pr.headSha && epic.reviewState !== 'open' && epic.reviewState !== 'changes_requested') return
          // Corral asked for this new head; the merge pass keeps the approval
          if (epic.reviewState === 'ready_to_merge' && epic.rebaseRequested) return
          await this.d.github.updatePullRequest(project.repository, pr.number, { body: await this.body(tx, epic, board, project) })
          // A moved epic head invalidates approval, even if board membership
          // didn't change. Active runs on the old head are fenced by state.
          await tx.update(runs).set(runEndValues({ state: 'interrupted', error: 'Epic PR changed' }, this.now()))
            .where(and(eq(runs.epicId, epic.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
          await tx.update(epics).set({ prNumber: pr.number, prHeadSha: pr.headSha, reviewState: 'in_review', rebaseRequested: false, conflictFiles: null, updatedAt: this.now() }).where(eq(epics.id, epic.id))
          changed = true
          await appendAudit(tx, { projectId: project.id, actor: system }, auditEvent('epic.pr', { epicId: epic.id, event: epic.prNumber ? 'review_started' : 'opened', prNumber: pr.number }))
        })
        if (changed) await this.publish(candidate.id)
      } catch (error) {
        console.error(`Epic PR ${candidate.id}:`, error)
      }
    }
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
          planSessionId: null, agentSessionId: null, fallbackPrompt: null, model: null, timeoutSeconds: 3600,
          prompt: `You are ${agent.name}, reviewing the integration of epic "${epic.title}".\n\n${JSON.stringify(context, null, 2)}\n\nReview the whole combined diff with git diff origin/${project.defaultBranch}...HEAD at commit ${epic.prHeadSha}. This is a read-only checkout: do not edit, commit or push. Check the epic goal and every task's criteria, looking for integration problems between tasks (API/UI mismatches, inconsistent docs, duplicate helpers). The evidence is context; do not re-judge individual task evidence. Criteria checked by a human and tasks flagged humanReview wait for the human at this epic's approval: do not attempt them, produce evidence or verdicts for them, or request changes over them. Use get_task for the whole epic and get_evidence to fetch any listed evidence ID. Rerun the project's lint, typecheck, tests and build as gates WITHOUT THE CACHE (for Turbo use --force). Always finish with report_outcome, outcome approved or changes_requested, and specific reasoning in summary. Report integration problems between tasks in findings: each has level (blocking or non_blocking), text explaining the problem, and taskRefs naming the concerned tasks. Mark suggestions that do not prevent approval non_blocking; use changes_requested for blocking problems. Report an empty findings array when there are none. No per-task criteria verdicts are required. Changes requested create a fix task in the epic; approval sends the epic PR to human review.`
        }
      }
      return null
    })
  }

  async report(run: RunRow, report: EpicReviewReport): Promise<void> {
    const { outcome } = report
    let fixId: string | null = null
    await this.d.db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, run.projectId)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, run.epicId!)).for('update')
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for('update')
      if (!project || !epic || !current || !ACTIVE_RUN_STATES.includes(current.state as typeof ACTIVE_RUN_STATES[number]) || epic.reviewState !== 'in_review' || epic.prHeadSha !== run.headSha || !complete(await epicBoard(tx, epic.id))) throw new Error('Epic changed during review; this verdict is stale')
      const pr = await this.d.github.getPullRequest(project.repository, epic.prNumber!)
      if (pr.state !== 'open' || pr.merged || pr.headSha !== run.headSha) throw new Error('Epic PR head changed; this verdict is stale')
      const actor: Actor = { kind: 'agent', role: 'reviewer', runId: run.id }
      const [previous] = await tx.select({ round: epicReviewRounds.round }).from(epicReviewRounds)
        .where(eq(epicReviewRounds.epicId, epic.id)).orderBy(desc(epicReviewRounds.round)).limit(1)
      await tx.insert(epicReviewRounds).values({
        epicId: epic.id, runId: run.id, reviewerId: run.agentId,
        round: (previous?.round ?? 0) + 1, headSha: run.headSha!,
        verdict: outcome, summary: report.summary, findings: report.findings, createdAt: this.now()
      })
      await tx.update(runs).set(runEndValues({ state: 'completed', outcome, summary: report.summary }, this.now())).where(eq(runs.id, run.id))
      await tx.update(epics).set({ reviewState: report.outcome === 'approved' ? 'human_review' : 'changes_requested', updatedAt: this.now() }).where(eq(epics.id, epic.id))
      if (report.outcome === 'changes_requested') fixId = await createEpicFixTask(tx, project, epic, report.summary, actor)
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId: epic.id, event: outcome, headSha: run.headSha, summary: report.summary }))
    })
    if (fixId) this.d.events.publish({ type: 'task.created', task: await loadTask(this.d.db, fixId) })
    await this.publish(run.epicId!)
  }

  async humanAction(epicId: string, input: EpicReviewActionInput, actor: Actor) {
    if (!/^[0-9a-f-]{36}$/i.test(epicId)) throw notFound()
    if (actor.kind !== 'human') throw new ApiFailure(409, { code: 'conflict', constraint: 'human_only' })
    if (input.action === 'rebase') return this.handOffRebase(epicId, input.headSha, actor)
    let fixId: string | null = null
    await this.d.db.transaction(async (tx) => {
      const [found] = await tx.select().from(epics).where(eq(epics.id, epicId))
      if (!found) throw notFound()
      const [project] = await tx.select().from(projects).where(eq(projects.id, found.projectId)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
      if (!project || !epic || epic.reviewState !== 'human_review' || epic.prHeadSha !== input.headSha || !complete(await epicBoard(tx, epic.id))) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_review_changed' })
      const pr = await this.d.github.getPullRequest(project.repository, epic.prNumber!)
      if (pr.headSha !== input.headSha || pr.state !== 'open' || pr.merged) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_pr_changed' })
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
      const [fix] = fixId ? await tx.select().from(tasks).where(eq(tasks.id, fixId)) : []
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId, ...(fix && { fixTasks: [{ id: fix.id, ref: taskRef(project.prefix, fix.number), title: fix.title }] }), event: input.action === 'approve' ? 'human_approved' : 'human_changes_requested', headSha: input.headSha, summary: input.text ?? '', ...(input.action === 'approve' && { confirmedCriteria: required.flatMap(r => r.humanChecks), confirmedTasks: required.filter(r => r.humanReview).map(r => r.taskId) }) }))
    })
    if (fixId) this.d.events.publish({ type: 'task.created', task: await loadTask(this.d.db, fixId) })
    await this.publish(epicId)
    return { ok: true }
  }

  // D27: the human hands a conflict to a developer run. The task's branch is
  // the epic branch, so its run rebases and force-pushes that branch. When
  // the task is Merged, the head has moved and integration review starts over.
  private async handOffRebase(epicId: string, headSha: string, actor: Actor) {
    const taskId = await this.d.db.transaction(async (tx) => {
      const [found] = await tx.select().from(epics).where(eq(epics.id, epicId))
      if (!found) throw notFound()
      const [project] = await tx.select().from(projects).where(eq(projects.id, found.projectId)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
      if (!project || !epic || epic.reviewState !== 'conflict' || epic.prHeadSha !== headSha) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_review_changed' })
      const target = project.defaultBranch
      const files = epic.conflictFiles?.length ? epic.conflictFiles.join(', ') : 'the files git reports'
      const text = `Rebase the epic branch ${epic.branch} onto origin/${target}: git fetch origin && git rebase origin/${target}. Never merge ${target} in. Resolve the conflicts in ${files}, keeping both sides' intent and never reverting what ${target} just merged. No feature changes. Run the project's gates, then report pr_updated; Corral force-pushes the epic branch with --force-with-lease, and no separate PR is opened.`
      const id = await createTask(tx, project, { type: 'task', title: `Rebase epic: ${epic.title}`.slice(0, 200), description: paragraph(text), epicId: epic.id, acceptanceCriteria: [`${epic.branch} is rebased onto origin/${target} with no merge commits, and the conflicts in ${files} are resolved keeping both sides' intent`] }, actor, { epicFix: true })
      await tx.update(tasks).set({ branch: epic.branch, kind: 'conflict' }).where(eq(tasks.id, id))
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId, event: 'rebase_handed_off', headSha }))
      return id
    })
    this.d.events.publish({ type: 'task.created', task: await loadTask(this.d.db, taskId) })
    await this.publish(epicId)
    return { ok: true }
  }

  async publish(id: string) {
    this.d.events.publish({ type: 'epic.updated', epic: await getEpic(this.d.db, id) })
  }
}

const paragraph = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

export async function createEpicFixTask(tx: Executor, project: ProjectRow, epic: EpicRow, feedback: string, actor: Actor) {
  return createTask(tx, project, { type: 'task', title: feedbackFixTitle(feedback), description: markdownToRichText(feedback), epicId: epic.id, acceptanceCriteria: feedbackPoints(feedback) }, actor, { epicFix: true, kind: 'fix' })
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
  const board = await toTasks(db, project, rows)
  const required = await humanObligations(db, rows)
  return { epicId: epic.id, title: epic.title, goal: epic.description, branch: epic.branch, headSha: epic.prHeadSha,
    tasks: await Promise.all(board.map(async (task): Promise<EpicReviewTask> => {
      const owed = required.find(r => r.taskId === task.id)
      return { task, evidence: await listEvidence(db, task.id), humanReview: owed?.humanReview ?? false, humanChecks: owed?.humanChecks ?? [] }
    })) }
}

// What's new on an epic since the human last requested changes on its PR
// (design/inbox.md). Each task's files and notes are labelled with the task.
async function epicChanges(db: Executor, epic: EpicRow, board: Awaited<ReturnType<typeof epicReviewContext>>['tasks']) {
  const [action] = await db.select({ detail: auditLog.detail, createdAt: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.action, 'epic.pr'), sql`${auditText('epic.pr', 'epicId')} = ${epic.id}`, sql`${auditText('epic.pr', 'event')} = 'human_changes_requested'`))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1)
  const at = action?.createdAt.toISOString() ?? null
  const newArtifacts = board.flatMap(({ task, evidence }) => fileArtifacts(evidence, at, task.ref))
  if (!action || !at) return { since: null, newArtifacts }
  const notes = await Promise.all(board.map(async ({ task }) => workNotes(await listComments(db, task.id), at, task.ref)))
  // Snapshot the request's tasks, even if later renamed or removed. Older
  // audit records have no links; never guess them from a title or timestamp.
  const fixTasks = readAudit(action.detail).fixTasks ?? []
  const since: InboxSince = { at, text: readAudit(action.detail).summary || null, notes: notes.flat().sort((a, b) => a.at.localeCompare(b.at)), fixTasks }
  return { since, newArtifacts }
}

// Editing an epic while it waits does not constitute a new arrival.
async function epicArrival(db: Executor, epic: EpicRow): Promise<string> {
  const events = epic.reviewState === 'conflict' ? ['conflict'] : ['approved', 'merge_refused']
  const [entry] = await db.select({ createdAt: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.action, 'epic.pr'), sql`${auditText('epic.pr', 'epicId')} = ${epic.id}`, inArray(auditText('epic.pr', 'event'), events)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1)
  return (entry?.createdAt ?? epic.updatedAt).toISOString()
}

export async function epicInboxItems(db: Executor, epicId?: string): Promise<(EpicReviewItem | EpicConflictItem)[]> {
  const rows = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(and(eq(epics.reviewState, 'human_review'), epicId ? eq(epics.id, epicId) : undefined))
  const items: (EpicReviewItem | EpicConflictItem)[] = []
  for (const { epic, project } of rows) {
    if (!epic.prNumber || !epic.prHeadSha || !complete(await epicBoard(db, epic.id))) continue
    // Not tied to the head: a merge GitHub refused comes back here after a clean rebase
    const [review] = await db.select({ run: runs, agent: agents }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(eq(runs.epicId, epic.id), eq(runs.outcome, 'approved'))).orderBy(desc(runs.number)).limit(1)
    if (!review) continue
    const rounds = await db.select({ review: epicReviewRounds, reviewer: { id: agents.id, name: agents.name } })
      .from(epicReviewRounds).innerJoin(agents, eq(agents.id, epicReviewRounds.reviewerId))
      .where(eq(epicReviewRounds.epicId, epic.id)).orderBy(asc(epicReviewRounds.round))
    const reviewRounds = rounds.map(({ review: r, reviewer }) => ({
      round: r.round, verdict: r.verdict, reviewer, headSha: r.headSha,
      summary: r.summary, findings: r.findings, at: r.createdAt.toISOString()
    }))
    const { tasks: board } = await epicReviewContext(db, epic, project)
    items.push({ id: epic.id, type: 'epic_review', epicId: epic.id, taskId: null, taskRef: null, subject: epic.title,
      project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: thumbnailUrl(project) },
      preview: review.run.summary ?? 'Integration approved', body: review.run.summary ?? 'Integration approved', sender: { name: review.agent.name, role: 'reviewer' }, at: await epicArrival(db, epic),
      prUrl: `https://github.com/${project.repository}/pull/${epic.prNumber}`, resolution: null, headSha: epic.prHeadSha,
      reviewRounds, findings: reviewRounds.at(-1)?.findings ?? [],
      tasks: board, ...await epicChanges(db, epic, board) })
  }
  const conflicts = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(and(eq(epics.reviewState, 'conflict'), epicId ? eq(epics.id, epicId) : undefined))
  for (const { epic, project } of conflicts) {
    if (!epic.prNumber || !epic.prHeadSha) continue
    const files = epic.conflictFiles ?? []
    const { tasks: board } = await epicReviewContext(db, epic, project)
    const body = `The epic PR can't rebase onto ${project.defaultBranch}. ${files.length ? `Conflicting files: ${files.join(', ')}.` : 'Corral couldn\'t work out which files conflict; the PR on GitHub shows them.'}`
    items.push({ id: epic.id, type: 'epic_conflict', epicId: epic.id, taskId: null, taskRef: null, subject: epic.title,
      project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: thumbnailUrl(project) },
      preview: body, body, sender: { name: 'Corral', role: 'system' }, at: await epicArrival(db, epic),
      prUrl: `https://github.com/${project.repository}/pull/${epic.prNumber}`, resolution: null, headSha: epic.prHeadSha, targetBranch: project.defaultBranch, files, ...await epicChanges(db, epic, board) })
  }
  return Promise.all(items.map(item => withMessage(db, item)))
}
