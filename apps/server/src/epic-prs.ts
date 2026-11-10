import type { EpicReviewActionInput } from '@corral/contracts'
import { APPROVED_STATES, boardComplete, isPrFree, isUuid, SERVER_ACTOR, shortSha, taskRef, type Actor } from '@corral/core'
import { schema, type Database, type EpicRow, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { prToLand } from './delivery-sql.ts'
import { answerEpicDecision } from './epic-fixes.ts'
import { approvalSnapshot, awaitsReview, humanCriteria, humanObligations } from './epic-review.ts'
import { publishEpic } from './epics.ts'
import { ApiFailure, notFound, requireHuman } from './errors.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient, PullRequest } from './github.ts'
import { commitUrl } from './github-urls.ts'
import { activeRebase, deferredConflicts, retrySync } from './operations.ts'
import { epicBoard } from './parents.ts'
import { Backoff, LONGEST_POLL_MS } from './retries.ts'
import { endActiveRuns } from './run-lifecycle.ts'
import { loadTask } from './task-views.ts'
import { createFixTask } from './tasks.ts'

const { epics, projects, runs, tasks } = schema

// Whether this PR needs integration review to start: it's waiting for one, or
// its head moved
const reviewDue = (epic: EpicRow, pr: PullRequest): boolean => awaitsReview(epic) || epic.prHeadSha !== pr.headSha

// How often a PR closed without merging is read, in case it's reopened
const CLOSED_POLL_MS = LONGEST_POLL_MS

// Only a human acts on a task's PR, and IDs come from URLs
function refuseUnlessHuman(epicId: string, actor: Actor): void {
  if (!isUuid(epicId)) throw notFound()
  requireHuman(actor, () => new ApiFailure(409, { code: 'conflict', constraint: 'human_only' }))
}

interface EpicPullRequestsDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  // Where people open Corral, for links in PR bodies
  publicUrl: string
  now: () => Date
}

// A task's own PR (D22, D27): opening it, starting integration review when its
// head moves, and the human's approval or change request
export class EpicPullRequests {
  #d: EpicPullRequestsDeps
  #closedPoll: Backoff

  constructor(deps: EpicPullRequestsDeps) {
    this.#d = deps
    this.#closedPoll = new Backoff(CLOSED_POLL_MS, CLOSED_POLL_MS, () => this.#now())
  }

  #now() { return this.#d.now() }

  // The scheduler already serializes passes. GitHub is read outside the
  // transaction, so a slow call holds no lock on the epic; the row lock then
  // rechecks everything against task additions and concurrent review reports.
  // Only an epic with no PR yet, or waiting for its fix work, can need a review
  // started here. The merge pass watches the head of every other PR.
  async reconcile(): Promise<void> {
    const { db } = this.#d
    const candidates = await db.select({ epic: epics, project: projects }).from(epics)
      .innerJoin(projects, eq(projects.id, epics.projectId))
      .where(and(prToLand(epics), eq(projects.paused, false)))
    for (const { epic, project } of candidates) {
      if (!awaitsReview(epic)) continue
      if (!this.#closedPoll.due(epic.id)) continue
      // One epic's GitHub trouble mustn't stop the others
      await this.#startReview(epic, project).catch(error => console.error(`Epic PR ${epic.id}:`, error))
    }
  }

  // The merge pass saw an epic PR's head move
  async headMoved(epicId: string): Promise<void> {
    const [row] = await this.#d.db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, epicId))
    if (row) await this.#startReview(row.epic, row.project)
  }

  async #startReview(candidate: EpicRow, project: ProjectRow): Promise<void> {
    const { db, github } = this.#d
    const board = await epicBoard(db, candidate.id)
    if (!boardComplete(board) || await activeRebase(db, candidate.id)) return
    // Safe to repeat if what follows fails: the next pass finds the open PR
    const pr = candidate.prNumber
      ? await github.getPullRequest(project.repository, candidate.prNumber)
      : await github.findOpenPullRequest(project.repository, candidate.branch!)
        ?? await github.openPullRequest(project.repository, {
          head: candidate.branch!, base: project.defaultBranch, title: candidate.title,
          body: await this.#body(db, candidate, board, project)
        })
    if (pr.state !== 'open' || pr.merged) return this.#closedPoll.later(candidate.id)
    this.#closedPoll.clear(candidate.id)
    if (!reviewDue(candidate, pr)) return
    // A PR read just after Corral's own push can still show the old head, and
    // a CI fix is on top of the target, so the behind check below can't tell
    if (candidate.prHeadSha && candidate.prHeadSha !== pr.headSha && APPROVED_STATES.includes(candidate.reviewState) && await github.branchHead(project.repository, candidate.branch!) === candidate.prHeadSha) return
    // Review starts from a head on top of the target branch: the
    // synchronizer's pass rebases it, and this one comes back. A conflict
    // between these same commits is resolved once approved, so review doesn't
    // wait for it; a moved target may have removed it, so that gets a rebase.
    if (await github.behindBy(project.repository, project.defaultBranch, pr.headSha) > 0) {
      const deferred = (await deferredConflicts(db, [candidate.id])).get(candidate.id)
      if (deferred?.expectedTargetSha !== pr.headSha || deferred.ontoSha !== await github.branchHead(project.repository, project.defaultBranch)) return
    }
    await github.updatePullRequest(project.repository, pr.number, { body: await this.#body(db, candidate, board, project) })
    const changed = await db.transaction(async (tx) => {
      const [epic] = await tx.select().from(epics).where(eq(epics.id, candidate.id)).for('update')
      if (!epic || epic.reviewState === 'merged' || (epic.prNumber && epic.prNumber !== pr.number)) return false
      if (!reviewDue(epic, pr) || await activeRebase(tx, epic.id) || !boardComplete(await epicBoard(tx, epic.id))) return false
      // Only the synchronizer moves an approved head and keeps approval, so
      // any other new head loses it. After the behind check: a PR read just
      // after Corral's own push can still show the old head, which is behind.
      if (epic.prNumber && epic.prHeadSha !== pr.headSha && APPROVED_STATES.includes(epic.reviewState)) {
        const reason = 'The task\'s head moved without a reviewed rebase.'
        await tx.update(epics).set({ reviewState: 'open', approvedHeadSha: null, approvedBaseSha: null, updatedAt: this.#now() }).where(eq(epics.id, epic.id))
        await appendAudit(tx, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId: epic.id, event: 'approval_invalidated', approvedHeadSha: epic.approvedHeadSha, from: epic.prHeadSha!, to: pr.headSha, ontoSha: null, operationId: null, resolutionTaskId: null, resolutionReview: null, reason, summary: `Approved ${shortSha(epic.approvedHeadSha)}, head moved ${shortSha(epic.prHeadSha)} to ${shortSha(pr.headSha)}. ${reason}` }))
      }
      // A moved epic head invalidates approval, even if board membership
      // didn't change. Active runs on the old head are fenced by state.
      await endActiveRuns(tx, eq(runs.epicId, epic.id), { state: 'interrupted', error: 'The task\'s PR changed' }, this.#now())
      await tx.update(epics).set({ prNumber: pr.number, prHeadSha: pr.headSha, approvedHeadSha: null, approvedBaseSha: null, reviewState: 'in_review', updatedAt: this.#now() }).where(eq(epics.id, epic.id))
      await appendAudit(tx, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId: epic.id, event: epic.prNumber ? 'review_started' : 'opened', prNumber: pr.number }))
      return true
    })
    if (changed) await this.publish(candidate.id)
  }

  async #body(db: Executor, epic: EpicRow, board: TaskRow[], project: ProjectRow) {
    const criteria = await humanCriteria(db, board)
    const obligations = board.flatMap((t) => {
      const ref = taskRef(project.prefix, t.number)
      if (!isPrFree(t)) return []
      return [...t.humanReview ? [`- [ ] ${ref}: reviewed by a human`] : [], ...criteria.filter(c => c.taskId === t.id).map(c => `- [ ] ${ref}: ${c.text}`)]
    })
    return [epic.description, '## Tasks and evidence', ...board.map((t) => {
      const ref = taskRef(project.prefix, t.number)
      return `- ${ref}: ${t.title}${t.prUrl ? ` ([PR](${t.prUrl}))` : t.mergeCommitSha ? ` ([${shortSha(t.mergeCommitSha)}](${commitUrl(project.repository, t.mergeCommitSha)}))` : ''} — [criteria and evidence](${this.#d.publicUrl}/tasks/${ref})`
    }), ...obligations.length ? ['## Human checks for task approval', 'Confirmed in Corral when approving the task, not on this list.', obligations.join('\n')] : []].join('\n\n')
  }

  async humanAction(epicId: string, input: EpicReviewActionInput, actor: Actor) {
    refuseUnlessHuman(epicId, actor)
    if (input.action === 'rebase') return this.retrySync(epicId, actor)
    if (input.action === 'decide') {
      await answerEpicDecision(this.#d.db, epicId, input, actor)
      await this.publish(epicId)
      return { ok: true }
    }
    let fixId: string | null = null
    // GitHub first, holding no lock; approving only moves the epic on, and
    // the merge pass reads the head again under the lock
    const [found] = await this.#d.db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, epicId))
    if (!found) throw notFound()
    if (found.epic.reviewState !== 'human_review' || found.epic.prHeadSha !== input.headSha) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_review_changed' })
    const pr = await this.#d.github.getPullRequest(found.project.repository, found.epic.prNumber!)
    if (pr.headSha !== input.headSha || pr.state !== 'open' || pr.merged) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_pr_changed' })
    await this.#d.db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, found.project.id)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
      if (!project || !epic || epic.reviewState !== 'human_review' || epic.prHeadSha !== input.headSha || await activeRebase(tx, epic.id) || !boardComplete(await epicBoard(tx, epic.id))) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_review_changed' })
      if (input.action === 'request_changes' && !input.text?.trim()) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ message: 'Describe the changes needed' }] })
      // D27: flagged tasks and human checks are obligations of this approval.
      // Read under the epic lock, so a later change to the board can't slip past.
      const required = await humanObligations(tx, await epicBoard(tx, epic.id))
      const confirmedCriteria = input.confirmedCriteria ?? []
      const confirmedTasks = input.confirmedTasks ?? []
      if (input.action === 'approve' && required.some(r => (r.humanReview && !confirmedTasks.includes(r.taskId)) || r.humanChecks.some(id => !confirmedCriteria.includes(id)))) {
        throw new ApiFailure(409, { code: 'conflict', constraint: 'human_checks_unconfirmed' })
      }
      await tx.update(epics).set({ reviewState: input.action === 'approve' ? 'ready_to_merge' : 'changes_requested', ...input.action === 'approve' ? await approvalSnapshot(this.#d.github, project, input.headSha) : { approvedHeadSha: null, approvedBaseSha: null }, updatedAt: this.#now() }).where(eq(epics.id, epic.id))
      if (input.action === 'request_changes') fixId = await createFixTask(tx, project, epic.id, input.text!.trim(), actor)
      const [fix] = fixId ? await tx.select().from(tasks).where(eq(tasks.id, fixId)) : []
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId, ...(fix && { fixTasks: [{ id: fix.id, ref: taskRef(project.prefix, fix.number), title: fix.title }] }), event: input.action === 'approve' ? 'human_approved' : 'human_changes_requested', headSha: input.headSha, summary: input.text ?? '', ...(input.action === 'approve' && { confirmedCriteria: required.flatMap(r => r.humanChecks), confirmedTasks: required.filter(r => r.humanReview).map(r => r.taskId) }) }))
    })
    if (fixId) this.#d.events.publish({ type: 'task.created', task: await loadTask(this.#d.db, fixId) })
    await this.publish(epicId)
    return { ok: true }
  }

  // A failed synchronization, or a conflict from before they were automatic,
  // goes round the automatic path again
  async retrySync(epicId: string, actor: Actor) {
    refuseUnlessHuman(epicId, actor)
    await retrySync(this.#d.db, epicId, actor, this.#now())
    await this.publish(epicId)
    return { ok: true }
  }

  async publish(id: string) {
    await publishEpic(this.#d.db, this.#d.events, id)
  }
}
