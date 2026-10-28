import { failedMergeGates, transition, type Actor, type MergeGateFacts, type TaskState } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm'
import { ApiFailure } from './errors.ts'
import type { EventBus } from './events.ts'
import { GitHubError, type CheckResult, type GitHubClient, type PullRequest } from './github.ts'
import type { RunnerHub } from './runner-hub.ts'
import { applyTransition, loadTask, lockTask, toTaskState, type ProjectRow, type TaskRow } from './tasks.ts'

const { acceptanceCriteria, auditLog, comments, evidence, reviews, tasks } = schema

const server: Actor = { kind: 'system', component: 'server' }

// How many ambiguous merge failures before the task is failed rather than
// retried (D10: "GitHub merge failed and retrying isn't safe")
const MAX_MERGE_ATTEMPTS = 3

export interface MergeDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  runner: RunnerHub
  // flows.md step 10: the PM writes a delivery summary when an epic's last task merges
  onEpicFinished?: (epicId: string) => Promise<void>
  now?: () => Date
}

// Whether a task may be merged right now, from live GitHub data
export interface GateReport {
  pr: PullRequest
  facts: MergeGateFacts
  checks: CheckResult[]
  requiredPassing: { name: string, url: string | null }[]
  // The approval for the current commit, if any
  approvalRunId: string | null
}

// flows.md steps 7b–10: after the reviewer approves, wait for CI and the
// base branch, run the gates against live GitHub data, then merge or hand
// the task to the human. Never an agent, and never a merge without GitHub
// confirming it.
export class MergeOrchestrator {
  #d: MergeDeps
  #attempts = new Map<string, number>()
  // Set by the Orchestrator while the kill switch is on
  stopped = false

  constructor(deps: MergeDeps) {
    this.#d = deps
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date()
  }

  // One pass over every approved task waiting in Agent review
  async tick(): Promise<void> {
    if (this.stopped || !this.#d.runner.online) return
    const waiting = await this.#d.db.select({ task: tasks, project: schema.projects }).from(tasks)
      .innerJoin(schema.projects, eq(schema.projects.id, tasks.projectId))
      .where(and(eq(tasks.status, 'agent_review'), isNull(tasks.leaseRunId), isNull(tasks.deletedAt), eq(tasks.paused, false), eq(schema.projects.paused, false)))
      .orderBy(asc(tasks.updatedAt))
    for (const { task, project } of waiting) {
      if (!task.prNumber || !task.headSha) continue
      const approval = await this.#approvalFor(task)
      if (!approval) continue
      await this.#advance(task, project).catch(error => console.error(`Merge check for task ${task.id} failed`, error))
    }
  }

  async #approvalFor(task: TaskRow) {
    const [row] = await this.#d.db.select().from(reviews)
      .where(and(eq(reviews.taskId, task.id), eq(reviews.headSha, task.headSha!), eq(reviews.verdict, 'approved')))
      .orderBy(desc(reviews.createdAt)).limit(1)
    return row ?? null
  }

  // Gathers the facts for core's gate check from GitHub and the database
  async gates(task: TaskRow, project: ProjectRow): Promise<GateReport> {
    const { db, github } = this.#d
    const pr = await github.getPullRequest(project.repository, task.prNumber!)
    const checks = await github.checks(project.repository, pr.headSha)
    const required = project.requiredChecks
    const requiredPassing = required
      .map(name => checks.find(c => c.name === name && c.conclusion === 'success'))
      .filter((c): c is CheckResult => Boolean(c))
      .map(c => ({ name: c.name, url: c.url }))
    const approval = await this.#approvalFor(task)
    const criteria = await db.select({ id: acceptanceCriteria.id }).from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id))
    const attached = await db.select({ criterionId: evidence.criterionId }).from(evidence)
      .where(and(eq(evidence.taskId, task.id), eq(evidence.round, task.reviewRounds)))
    return {
      pr,
      checks,
      requiredPassing,
      approvalRunId: approval?.runId ?? null,
      facts: {
        approvalIsForHeadCommit: approval !== null && approval.headSha === pr.headSha,
        requiredChecksPassed: requiredPassing.length === required.length,
        evidenceComplete: criteria.every(c => attached.some(e => e.criterionId === c.id)),
        mergeable: pr.mergeable === true && pr.state === 'open'
      }
    }
  }

  // With no required checks configured, every task needs a human
  // (design/project-settings.md: "With no checks, every task needs human review")
  #needsHuman(task: TaskRow, project: ProjectRow): boolean {
    return task.humanReview || project.requiredChecks.length === 0
  }

  async #advance(task: TaskRow, project: ProjectRow): Promise<void> {
    const { db, github } = this.#d
    const pr = await github.getPullRequest(project.repository, task.prNumber!)

    if (pr.merged) {
      // Merged outside Corral (or an earlier ambiguous merge did go through)
      await this.#recordMerged(task.id, pr, null)
      return
    }
    if (pr.state === 'closed') {
      await this.#transition(task.id, { type: 'fail', reason: `PR #${pr.number} was closed on GitHub without merging` }, { event: 'pr_closed' })
      return
    }

    if (pr.headSha !== task.headSha) {
      await this.#headMoved(task, pr)
      return
    }

    const checks = await github.checks(project.repository, pr.headSha)
    const failed = project.requiredChecks
      .map(name => checks.find(c => c.name === name))
      .filter((c): c is CheckResult => c !== undefined && (c.conclusion === 'failure'))
    if (failed.length > 0) {
      // flows.md 7b: CI fails → In progress with the failure attached
      const body = ['CI failed on this commit; please fix and report pr_updated.', '', ...failed.map(c => `- ${c.name}: failed${c.url ? ` (${c.url})` : ''}`)].join('\n')
      await this.#transition(task.id, { type: 'ci_failed' }, { event: 'ci_failed', checks: failed.map(c => c.name) }, body)
      return
    }
    const pending = project.requiredChecks.filter(name => !checks.some(c => c.name === name && c.conclusion === 'success'))
    if (pending.length > 0) return // waiting on CI: a cheap poll, never an agent

    if (pr.mergeable === null) return // GitHub is still computing mergeability
    if (pr.mergeableState === 'behind' && !task.branchUpdateRequested) {
      // The base moved on: ask GitHub to merge it in, no local git needed
      const updated = await github.updateBranch(project.repository, pr.number, pr.headSha)
      if (updated) {
        await db.update(tasks).set({ branchUpdateRequested: true }).where(eq(tasks.id, task.id))
        await db.insert(auditLog).values({ projectId: project.id, taskId: task.id, actor: server, action: 'branch.update_requested', detail: { pr: pr.number, headSha: pr.headSha } })
      } else {
        await this.#transition(task.id, { type: 'base_conflict' }, { event: 'base_conflict' },
          `The base branch \`${project.defaultBranch}\` has moved and the update conflicts with this branch. Merge \`${project.defaultBranch}\` in, resolve the conflicts, and report pr_updated.`)
      }
      return
    }
    if (pr.mergeable === false) {
      await this.#transition(task.id, { type: 'base_conflict' }, { event: 'base_conflict', mergeableState: pr.mergeableState },
        `GitHub reports this branch can’t be merged (${pr.mergeableState ?? 'conflict'}). Merge \`${project.defaultBranch}\` in, resolve the conflicts, and report pr_updated.`)
      return
    }

    const report = await this.gates(task, project)
    if (failedMergeGates(report.facts).length > 0) return // not yet; the next tick looks again

    if (this.#needsHuman(task, project)) {
      await db.transaction(async (tx) => {
        const locked = await lockTask(tx, task.id)
        if (locked.task.status !== 'agent_review' || locked.task.leaseRunId) return
        // The gate check sees the task as flagged even when the flag comes from the project
        const flagged = { ...locked.task, humanReview: true }
        await applyTransition(tx, flagged, locked.project, { type: 'gates_passed', gates: report.facts }, server, { event: 'gates_passed', pr: pr.number, headSha: pr.headSha })
        await tx.update(tasks).set({ gateChecks: report.requiredPassing }).where(eq(tasks.id, task.id))
      })
      await this.#publish(task.id)
      return
    }
    await this.merge(task.id, project, report, null)
  }

  // The branch head changed under us: a mechanical base update keeps the
  // approval (R7 default); any other commit needs a fresh review
  async #headMoved(task: TaskRow, pr: PullRequest): Promise<void> {
    const { db } = this.#d
    await db.transaction(async (tx) => {
      const [approval] = await tx.select().from(reviews)
        .where(and(eq(reviews.taskId, task.id), eq(reviews.headSha, task.headSha!), eq(reviews.verdict, 'approved')))
        .orderBy(desc(reviews.createdAt)).limit(1)
      if (task.branchUpdateRequested && approval) {
        await tx.insert(reviews).values({
          taskId: task.id,
          runId: approval.runId,
          round: approval.round,
          headSha: pr.headSha,
          verdict: 'approved',
          summary: `${approval.summary}\n\n(Approval carried over a base-branch update from ${task.headSha!.slice(0, 10)} to ${pr.headSha.slice(0, 10)}; CI runs again.)`,
          criteria: approval.criteria,
          author: server
        })
      }
      await tx.update(tasks).set({ headSha: pr.headSha, branchUpdateRequested: false, updatedAt: this.#now() }).where(eq(tasks.id, task.id))
      await tx.insert(auditLog).values({
        projectId: task.projectId, taskId: task.id, actor: server, action: 'branch.head_moved',
        detail: { from: task.headSha, to: pr.headSha, approvalKept: Boolean(task.branchUpdateRequested && approval) }
      })
    })
    await this.#publish(task.id)
  }

  // flows.md step 9. `humanApprovedBy` is the human's ID when leaving Human
  // review. Re-reads the PR when GitHub's answer is ambiguous, and never
  // marks Merged without seeing it merged.
  async merge(taskId: string, project: ProjectRow, report: GateReport, humanApprovedBy: string | null): Promise<void> {
    const { github } = this.#d
    const attempt = (this.#attempts.get(taskId) ?? 0) + 1
    this.#attempts.set(taskId, attempt)
    let result: { merged: boolean, sha: string | null, message: string }
    try {
      result = await github.merge(project.repository, report.pr.number, project.mergeMethod, report.pr.headSha)
    } catch (error) {
      // Ambiguous (timeout, 5xx): look before deciding anything
      const again = await github.getPullRequest(project.repository, report.pr.number).catch(() => null)
      if (again?.merged) {
        await this.#recordMerged(taskId, again, humanApprovedBy)
        return
      }
      if (attempt >= MAX_MERGE_ATTEMPTS) {
        await this.#transition(taskId, { type: 'fail', reason: `GitHub merge failed ${attempt} times and retrying isn't safe: ${error instanceof Error ? error.message : String(error)}` }, { event: 'merge_failed' })
        this.#attempts.delete(taskId)
      }
      return
    }
    if (result.merged) {
      const merged = await github.getPullRequest(project.repository, report.pr.number)
      if (!merged.merged) return // GitHub said merged but doesn't show it yet; next tick re-reads
      await this.#recordMerged(taskId, { ...merged, mergeCommitSha: result.sha ?? merged.mergeCommitSha }, humanApprovedBy)
      return
    }
    // A plain refusal (405/409): the head moved or a check turned red. The
    // next tick re-evaluates from live state.
    await this.#d.db.insert(auditLog).values({ projectId: project.id, taskId, actor: server, action: 'merge.refused', detail: { pr: report.pr.number, message: result.message, attempt } })
    if (attempt >= MAX_MERGE_ATTEMPTS) {
      await this.#transition(taskId, { type: 'fail', reason: `GitHub refused the merge ${attempt} times: ${result.message}` }, { event: 'merge_failed' })
      this.#attempts.delete(taskId)
    }
  }

  async #recordMerged(taskId: string, pr: PullRequest, humanApprovedBy: string | null): Promise<void> {
    const { db } = this.#d
    let merged = false
    await db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, taskId)
      if (task.status === 'merged') return
      // Core re-checks the gates; GitHub has already confirmed the merge, so
      // the facts describe the merged commit
      const report = await this.gates(task, project)
      const facts: MergeGateFacts = { ...report.facts, mergeable: true, approvalIsForHeadCommit: report.facts.approvalIsForHeadCommit || task.status === 'human_review' }
      const flagged = task.status === 'agent_review' ? { ...task, humanReview: false } : task
      await applyTransition(tx, flagged, project, { type: 'merged', gates: facts, humanApprovedBy }, server, { event: 'merged', pr: pr.number, mergeCommitSha: pr.mergeCommitSha, humanApprovedBy })
      await tx.update(tasks).set({ mergeCommitSha: pr.mergeCommitSha, mergedAt: this.#now(), updatedAt: this.#now() }).where(eq(tasks.id, taskId))
      merged = true
    })
    this.#attempts.delete(taskId)
    if (!merged) return
    await this.#publish(taskId)
    await this.cleanup(taskId)
    await this.#checkEpic(taskId)
  }

  async #checkEpic(taskId: string): Promise<void> {
    const { db } = this.#d
    const [row] = await db.select({ epicId: tasks.epicId }).from(tasks).where(eq(tasks.id, taskId))
    if (!row?.epicId) return
    const open = await db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.epicId, row.epicId), isNull(tasks.deletedAt), ne(tasks.status, 'merged')))
    if (open.length > 0) return
    await this.#d.onEpicFinished?.(row.epicId).catch(error => console.error('Delivery summary failed', error))
  }

  // flows.md step 10: the runner removes the worktrees, keeping any with
  // uncommitted changes and flagging them
  async cleanup(taskId: string): Promise<void> {
    const { db, runner } = this.#d
    const [row] = await db.select({ task: tasks, project: schema.projects }).from(tasks)
      .innerJoin(schema.projects, eq(schema.projects.id, tasks.projectId)).where(eq(tasks.id, taskId))
    if (!row) return
    try {
      const result = await runner.request({ kind: 'cleanup_worktrees', repository: row.project.repository, taskId })
      await db.insert(auditLog).values({ projectId: row.project.id, taskId, actor: server, action: 'worktrees.cleaned', detail: result })
      if (result.kept.length > 0) {
        await db.insert(comments).values({ taskId, author: server, body: `The runner kept a worktree with uncommitted changes: ${result.kept.join(', ')}. Remove it by hand when you're done with it.` })
      }
    } catch (error) {
      console.error(`Worktree cleanup for task ${taskId} failed`, error)
    }
  }

  // Human review → Merged (design/inbox.md "Approve and merge"): the gates
  // are re-checked against live GitHub data first
  async humanApprove(taskId: string, actor: Actor): Promise<void> {
    if (actor.kind !== 'human') throw new ApiFailure(409, { code: 'transition_rejected', reason: { code: 'actor_not_allowed', actor: null, event: 'merged' } })
    const [row] = await this.#d.db.select({ task: tasks, project: schema.projects }).from(tasks)
      .innerJoin(schema.projects, eq(schema.projects.id, tasks.projectId)).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    if (!row) throw new ApiFailure(404, { code: 'not_found' })
    const { task, project } = row
    if (task.status !== 'human_review' || !task.prNumber) {
      throw new ApiFailure(409, { code: 'transition_rejected', reason: { code: 'invalid_transition', status: task.status, event: 'merged' } })
    }
    let report: GateReport
    try {
      report = await this.gates(task, project)
    } catch (error) {
      if (error instanceof GitHubError) throw new ApiFailure(409, { code: 'conflict', constraint: `github: ${error.message}` })
      throw error
    }
    if (report.pr.merged) {
      await this.#recordMerged(taskId, report.pr, actor.userId)
      return
    }
    // The same check core runs, so the human gets the reason up front
    const state: TaskState = toTaskState(task)
    const check = transition(state, { type: 'merged', gates: report.facts, humanApprovedBy: actor.userId }, server)
    if (!check.ok) throw new ApiFailure(409, { code: 'transition_rejected', reason: check.error })
    await this.#d.db.insert(auditLog).values({ projectId: project.id, taskId, actor, action: 'task.human_approved', detail: { pr: report.pr.number, headSha: report.pr.headSha } })
    await this.merge(taskId, project, report, actor.userId)
    const [after] = await this.#d.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))
    if (after?.status !== 'merged') {
      throw new ApiFailure(409, { code: 'conflict', constraint: 'merge_not_confirmed' })
    }
  }

  async #transition(taskId: string, event: Parameters<typeof applyTransition>[3], detail: Record<string, unknown>, comment?: string): Promise<void> {
    await this.#d.db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, taskId)
      if (task.leaseRunId) return
      await applyTransition(tx, task, project, event, server, detail)
      if (comment) await tx.insert(comments).values({ taskId, author: server, body: comment })
    })
    await this.#publish(taskId)
  }

  async #publish(taskId: string): Promise<void> {
    const task = await loadTask(this.#d.db, taskId).catch(() => null)
    if (task) this.#d.events.publish({ type: 'task.updated', task })
  }
}
