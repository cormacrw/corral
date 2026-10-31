import { failedMergeGates, TRANSITION_RULES, type Actor, type MergeGateFacts, type TaskStatus } from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, desc, eq, exists, isNull, sql } from 'drizzle-orm'
import { EpicMerger } from './epic-merge.ts'
import { appendAudit, auditEvent, type TransitionDetail } from './audit.ts'
import { verdictForSubmission } from './claim.ts'
import { evidenceMissing, taskBase } from './task-base.ts'
import { ApiFailure } from './errors.ts'
import { publishDependents } from './dependent-tasks.ts'
import { TaskIntegrator } from './task-integration.ts'
import type { EventBus } from './events.ts'
import { isTransient, requiredChecks, type CheckResult, type GitHubClient, type PullRequest } from './github.ts'
import { SharedReads } from './pull-requests.ts'
import { Backoff, HeadAttempts, MAX_MERGE_ATTEMPTS } from './retries.ts'
import type { RunnerHub } from './runner-hub.ts'
import { applyTransition, loadTask, lockTask, type ProjectRow, type TaskRow } from './tasks.ts'

const { comments, epics, reviews, tasks } = schema

const server: Actor = { kind: 'system', component: 'server' }

const MERGED_OUTSIDE_FROM: readonly TaskStatus[] = TRANSITION_RULES.merged_outside.from

// How long a requested base update may take to show on the PR. Past this the
// request is taken as lost and made again.
export const REBASE_WAIT_MS = 5 * 60_000
// How often a task waiting on CI is looked at, at first and at most: each
// look is three GitHub calls, and merges landing a minute later cost nothing
const CI_POLL_MS = 30_000
const CI_POLL_MAX_MS = 120_000
// After GitHub or the runner failed to answer
const RETRY_MS = 30_000
const RETRY_MAX_MS = 5 * 60_000

// Developers always rebase; a merge of the base would put merge commits on
// the branch (and Corral pushes with --force-with-lease, so rebases push)
function rebaseInstruction(defaultBranch: string): string {
  return `Rebase onto \`origin/${defaultBranch}\`, resolve the conflicts, and report pr_rebased.`
}

export interface MergeDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  runner: RunnerHub
  now?: () => Date
  wake?: (taskIds: string[]) => void
  // An epic PR's head moved while it wasn't waiting on Corral's own rebase
  epicHeadMoved?: (epicId: string) => Promise<void>
}

// What the gate check reads from GitHub
export type GateReads = Pick<GitHubClient, 'getPullRequest' | 'checks'>

// Whether a task may be merged right now, from live GitHub data
export interface GateReport {
  pr: PullRequest
  facts: MergeGateFacts
  checks: CheckResult[]
  requiredPassing: { name: string, url: string | null }[]
  // The approval for the current commit, if any
  approvalRunId: string | null
}

// flows.md steps 7b–10: a task in Ready to merge (approved by the reviewer,
// and by the human when flagged) waits for CI and the base branch, the gates
// run against live GitHub data, then Corral merges. Never an agent, and
// never Merged without GitHub confirming it.
export class MergeOrchestrator {
  #d: MergeDeps
  #attempts = new HeadAttempts()
  #ciPoll: Backoff
  #retry: Backoff
  // The commit each task's failed gates were last recorded for
  #gatesNoted = new Map<string, string>()
  #display: SharedReads | null = null
  // Tasks being advanced right now: a tick and a human approval can overlap
  #busy = new Set<string>()
  #epics: EpicMerger
  #integrations: TaskIntegrator
  // Set by the Orchestrator while the kill switch or the update hold is on
  stopped = false

  constructor(deps: MergeDeps) {
    this.#d = deps
    this.#epics = new EpicMerger(deps)
    this.#integrations = new TaskIntegrator(deps, async (taskId) => {
      await this.#publish(taskId)
      const task = await loadTask(deps.db, taskId).catch(() => null)
      if (task?.status === 'merged') await this.cleanup(taskId)
    })
    this.#ciPoll = new Backoff(CI_POLL_MS, CI_POLL_MAX_MS, () => this.#now())
    this.#retry = new Backoff(RETRY_MS, RETRY_MAX_MS, () => this.#now())
  }

  // For showing gates, where page refetches overlap. A merge makes its own reads.
  get displayReads(): GateReads {
    this.#display ??= new SharedReads(this.#d.github)
    return this.#display
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date()
  }

  // Merges being advanced right now; a redeploy waits for these
  get inFlight(): number {
    return this.#busy.size + this.#epics.inFlight + this.#integrations.inFlight
  }

  // One pass over every task in Ready to merge
  async tick(): Promise<void> {
    if (this.stopped || !this.#d.runner.online) return
    await this.#promoteApproved()
    const waiting = await this.#d.db.select({ task: tasks, project: schema.projects, epicBranch: epics.branch }).from(tasks)
      .innerJoin(schema.projects, eq(schema.projects.id, tasks.projectId))
      .leftJoin(epics, eq(epics.id, tasks.epicId))
      .where(and(eq(tasks.status, 'ready_to_merge'), isNull(tasks.leaseRunId), isNull(tasks.deletedAt), eq(tasks.paused, false), eq(schema.projects.paused, false)))
      .orderBy(asc(tasks.updatedAt))
    for (const { task, project, epicBranch } of waiting) {
      if (this.stopped) return
      if (task.type === 'design') continue
      // A rebase task (D27): its branch is the epic branch
      if (task.branch && task.branch === epicBranch) await this.#once(task.id, () => this.#settleEpicRebase(task))
      else if (task.prNumber && task.headSha && this.#retry.due(task.id) && this.#ciPoll.due(task.id)) await this.#advanceOnce(task, project)
    }
    await this.#integrations.tick(() => this.stopped)
    await this.#epics.tick(() => this.stopped)
  }

  // A rebase task's work reached the epic branch when the runner pushed it;
  // nothing is left to merge, and the epic PR goes back to integration review
  async #settleEpicRebase(task: TaskRow): Promise<void> {
    await this.#d.db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.status !== 'ready_to_merge') return
      await applyTransition(tx, locked.task, locked.project, { type: 'merged_outside' }, server, { event: 'merged', headSha: task.headSha })
      await tx.update(tasks).set({ mergedAt: this.#now(), updatedAt: this.#now() }).where(eq(tasks.id, task.id))
    })
    await this.#publish(task.id)
    await this.cleanup(task.id)
  }

  // Approvals recorded before Ready to merge existed left the task in Agent
  // review; move them on as the reviewer's approval does now. A reviewer claim
  // skips exactly the tasks with a verdict for this submission, so an approval
  // from before a later submission gets a fresh review (flows.md step 6) and
  // only one that claim would leave waiting forever is moved on.
  async #promoteApproved(): Promise<void> {
    const { db } = this.#d
    const approved = await db.select({ id: tasks.id, headSha: tasks.headSha, rebaseOnly: tasks.rebaseOnly }).from(tasks)
      .where(and(eq(tasks.status, 'agent_review'), isNull(tasks.leaseRunId), isNull(tasks.deletedAt), eq(tasks.paused, false),
        exists(db.select({ one: sql`1` }).from(reviews).where(and(verdictForSubmission(db), eq(reviews.verdict, 'approved'))))))
    for (const task of approved) {
      const approval = await this.#approvalFor(task)
      if (!approval) continue
      const type = task.rebaseOnly ? 'approval_carried' : 'review_approved'
      await this.#once(task.id, () => this.#transition(task.id, { type, humanCheckOpen: approval.criteria.some(v => v.met === null) }, { event: type, headSha: task.headSha }, undefined, 'agent_review'))
    }
  }

  // One bad row mustn't end the pass for the rest
  async #once(taskId: string, work: () => Promise<void>): Promise<void> {
    if (this.#busy.has(taskId)) return
    this.#busy.add(taskId)
    try {
      await work()
    } catch (error) {
      console.error(`Merge check for task ${taskId} failed`, error)
      if (isTransient(error)) this.#retry.later(taskId)
    } finally {
      this.#busy.delete(taskId)
    }
  }

  #advanceOnce(task: TaskRow, project: ProjectRow): Promise<void> {
    return this.#once(task.id, () => this.#advance(task, project))
  }

  async #approvalFor(task: { id: string, headSha: string | null }) {
    const [row] = await this.#d.db.select().from(reviews)
      .where(and(eq(reviews.taskId, task.id), eq(reviews.headSha, task.headSha!), eq(reviews.verdict, 'approved')))
      .orderBy(desc(reviews.createdAt)).limit(1)
    return row ?? null
  }

  // Gathers the facts for core's gate check from GitHub and the database. A
  // caller that has just read the PR and its checks passes them in.
  async gates(task: TaskRow, project: ProjectRow, read?: { pr: PullRequest, checks: CheckResult[] }, github: GateReads = this.#d.github): Promise<GateReport> {
    const { db } = this.#d
    const pr = read?.pr ?? await github.getPullRequest(project.repository, task.prNumber!)
    const checks = read?.checks ?? await github.checks(project.repository, pr.headSha)
    const required = project.requiredChecks
    const requiredPassing = requiredChecks(required, checks).passed.map(c => ({ name: c.name, url: c.url }))
    const approval = await this.#approvalFor(task)
    return {
      pr,
      checks,
      requiredPassing,
      approvalRunId: approval?.runId ?? null,
      facts: {
        approvalIsForHeadCommit: approval !== null && approval.headSha === pr.headSha,
        requiredChecksPassed: requiredPassing.length === required.length,
        evidenceComplete: (await evidenceMissing(db, task)).length === 0,
        mergeable: pr.mergeable === true && pr.state === 'open'
      }
    }
  }

  async #advance(task: TaskRow, project: ProjectRow): Promise<void> {
    const { db, github } = this.#d
    const baseBranch = await taskBase(db, task, project)
    const pr = await github.getPullRequest(project.repository, task.prNumber!)
    this.#retry.clear(task.id)

    if (pr.merged) {
      // Merged outside Corral (or an earlier ambiguous merge did go through)
      await this.#recordMerged(task.id, pr)
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
    if (task.branchUpdateRequested) {
      // GitHub hasn't shown the new head yet. Merging now would only be refused
      if (this.#now().getTime() - task.updatedAt.getTime() >= REBASE_WAIT_MS) await this.#clearBaseUpdate(task.id)
      return
    }

    const checks = await github.checks(project.repository, pr.headSha)
    const { failed, pending } = requiredChecks(project.requiredChecks, checks)
    if (failed.length > 0) {
      // flows.md 7b: CI fails → In progress with the failure attached
      const body = ['CI failed on this commit; please fix and report pr_updated.', '', ...failed.map(c => `- ${c.name}: failed${c.url ? ` (${c.url})` : ''}`)].join('\n')
      await this.#transition(task.id, { type: 'ci_failed' }, { event: 'ci_failed', checks: failed.map(c => c.name) }, body)
      return
    }
    if (pending.length > 0) {
      this.#ciPoll.later(task.id) // waiting on CI: a cheap poll, never an agent
      return
    }
    this.#ciPoll.clear(task.id)

    if (pr.mergeable === null) return // GitHub is still computing mergeability
    if (pr.mergeableState === 'behind') {
      await this.#updateBase(task, project, pr, baseBranch)
      return
    }
    if (pr.mergeable === false) {
      await this.#transition(task.id, { type: 'base_conflict', approvedHeadSha: pr.headSha }, { event: 'base_conflict', mergeableState: pr.mergeableState },
        `GitHub reports this branch can’t be merged (${pr.mergeableState ?? 'conflict'}). ${rebaseInstruction(baseBranch)}`)
      return
    }

    const report = await this.gates(task, project, { pr, checks })
    const failedGates = failedMergeGates(report.facts)
    if (failedGates.length > 0) {
      // Not yet; the next tick looks again. The audit says why, once per commit
      if (this.#gatesNoted.get(task.id) !== pr.headSha) {
        this.#gatesNoted.set(task.id, pr.headSha)
        await appendAudit(db, { projectId: project.id, taskId: task.id, actor: server }, auditEvent('merge.gates_failed', { pr: pr.number, headSha: pr.headSha, gates: failedGates }))
      }
      return
    }
    this.#gatesNoted.delete(task.id)
    await db.update(tasks).set({ gateChecks: report.requiredPassing }).where(eq(tasks.id, task.id))
    await this.merge(task.id, project, report)
  }

  // The base moved on: ask GitHub to rebase onto it, no local git needed. The
  // flag goes first: GitHub moves the head before updateBranch returns, and a
  // pass that saw the new head unflagged would discard the approval.
  async #updateBase(task: TaskRow, project: ProjectRow, pr: PullRequest, baseBranch: string): Promise<void> {
    const { db, github } = this.#d
    const [flagged] = await db.update(tasks).set({ branchUpdateRequested: true, updatedAt: this.#now() })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, 'ready_to_merge'), eq(tasks.headSha, pr.headSha), eq(tasks.branchUpdateRequested, false)))
      .returning({ id: tasks.id })
    if (!flagged) return
    let updated: boolean
    try {
      updated = await github.updateBranch(project.repository, pr, pr.headSha)
    } catch (error) {
      // A timeout may have gone through: the flag waits for the new head
      if (!isTransient(error)) await this.#clearBaseUpdate(task.id)
      throw error
    }
    if (updated) {
      await appendAudit(db, { projectId: project.id, taskId: task.id, actor: server }, auditEvent('branch.update_requested', { pr: pr.number, headSha: pr.headSha }))
    } else {
      await this.#transition(task.id, { type: 'base_conflict', approvedHeadSha: pr.headSha }, { event: 'base_conflict' },
        `The base branch \`${baseBranch}\` has moved and the update conflicts with this branch. ${rebaseInstruction(baseBranch)}`)
    }
  }

  async #clearBaseUpdate(taskId: string): Promise<void> {
    await this.#d.db.update(tasks).set({ branchUpdateRequested: false, updatedAt: this.#now() }).where(eq(tasks.id, taskId))
  }

  // The branch head changed under us: a mechanical base update keeps the
  // approval (R7 default); any other commit goes back for a fresh review.
  // Decided on the locked row: the pass's copy may be from before the request.
  async #headMoved(task: TaskRow, pr: PullRequest): Promise<void> {
    const { db } = this.#d
    await db.transaction(async (tx) => {
      const locked = await lockTask(tx, task.id)
      if (locked.task.status !== 'ready_to_merge' || locked.task.headSha === pr.headSha) return
      const from = locked.task.headSha!
      const [approval] = await tx.select().from(reviews)
        .where(and(eq(reviews.taskId, task.id), eq(reviews.headSha, from), eq(reviews.verdict, 'approved')))
        .orderBy(desc(reviews.createdAt)).limit(1)
      const kept = Boolean(locked.task.branchUpdateRequested && approval)
      if (kept && approval) {
        await tx.insert(reviews).values({
          taskId: task.id,
          runId: approval.runId,
          round: approval.round,
          headSha: pr.headSha,
          verdict: 'approved',
          summary: `${approval.summary}\n\n(Approval carried over a base-branch update from ${from.slice(0, 10)} to ${pr.headSha.slice(0, 10)}; CI runs again.)`,
          criteria: approval.criteria,
          author: server
        })
      }
      await tx.update(tasks).set({ headSha: pr.headSha, branchUpdateRequested: false, updatedAt: this.#now() }).where(eq(tasks.id, task.id))
      await appendAudit(tx, { projectId: task.projectId, taskId: task.id, actor: server }, auditEvent('branch.head_moved', { from, to: pr.headSha, approvalKept: kept }))
      if (!kept) await applyTransition(tx, locked.task, locked.project, { type: 'head_moved' }, server, { event: 'head_moved', headSha: pr.headSha })
    })
    await this.#publish(task.id)
  }

  // flows.md step 9. Re-reads the PR when GitHub's answer is ambiguous, and
  // never marks Merged without seeing it merged. The task's row stays locked
  // from the last check through to recording the result, as an epic's does, so
  // a human's veto either lands before the merge is asked for and stops it, or
  // waits for the merge and finds the task Merged.
  async merge(taskId: string, project: ProjectRow, report: GateReport): Promise<void> {
    const { db, github } = this.#d
    const { pr } = report
    const merged = await db.transaction(async (tx) => {
      const locked = await lockTask(tx, taskId).catch(() => null)
      if (!locked || !this.#mayMerge(locked.task, locked.project, pr)) return false
      let result: { merged: boolean, sha: string | null, message: string }
      try {
        result = await github.merge(project.repository, pr.number, project.mergeMethod, pr.headSha)
      } catch (error) {
        // Ambiguous (timeout, 5xx): look before deciding anything
        const again = await github.getPullRequest(project.repository, pr.number).catch(() => null)
        if (again?.merged) return this.#recordMergedIn(tx, locked, again, report.facts)
        // Pinned to the commit and re-read, so trying again is safe. Only a
        // real answer from GitHub counts against the task.
        if (isTransient(error)) {
          console.warn(`Merging task ${taskId} failed; trying again later`, error)
          this.#retry.later(taskId)
          return false
        }
        const attempt = this.#attempts.next(taskId, pr.headSha)
        if (attempt >= MAX_MERGE_ATTEMPTS) {
          await applyTransition(tx, locked.task, locked.project, { type: 'fail', reason: `GitHub merge failed ${attempt} times and retrying isn't safe: ${error instanceof Error ? error.message : String(error)}` }, server, { event: 'merge_failed' })
          this.#attempts.clear(taskId)
        }
        return false
      }
      if (result.merged) {
        const seen = await github.getPullRequest(project.repository, pr.number)
        if (!seen.merged) return false // GitHub said merged but doesn't show it yet; next tick re-reads
        return this.#recordMergedIn(tx, locked, { ...seen, mergeCommitSha: result.sha ?? seen.mergeCommitSha }, report.facts)
      }
      // A plain refusal (405/409): the head moved or a check turned red. The
      // next tick re-evaluates from live state.
      const attempt = this.#attempts.next(taskId, pr.headSha)
      await appendAudit(tx, { projectId: project.id, taskId, actor: server }, auditEvent('merge.refused', { pr: pr.number, message: result.message, attempt }))
      if (attempt >= MAX_MERGE_ATTEMPTS) {
        await applyTransition(tx, locked.task, locked.project, { type: 'fail', reason: `GitHub refused the merge ${attempt} times: ${result.message}` }, server, { event: 'merge_failed' })
        this.#attempts.clear(taskId)
      }
      return false
    })
    await this.#publish(taskId)
    if (merged) await this.cleanup(taskId)
  }

  // The last check before GitHub is asked to merge, on the locked rows: the
  // pass read the task a while ago, and anything may have vetoed it since
  #mayMerge(task: TaskRow, project: ProjectRow, pr: PullRequest): boolean {
    return !this.stopped && task.status === 'ready_to_merge' && !task.leaseRunId && !task.paused && !task.deletedAt && !project.paused && task.headSha === pr.headSha
  }

  // GitHub shows a PR merged that Corral didn't merge just now
  async #recordMerged(taskId: string, pr: PullRequest): Promise<void> {
    const merged = await this.#d.db.transaction(async (tx) => {
      const locked = await lockTask(tx, taskId)
      if (locked.task.status === 'merged') return false
      if (MERGED_OUTSIDE_FROM.includes(locked.task.status)) return this.#recordMergedIn(tx, locked, pr, null)
      // A human sent it back in the meantime. The work has landed all the same,
      // so a developer must not start on it: the human decides what's next.
      if (!locked.task.leaseRunId) {
        await applyTransition(tx, locked.task, locked.project, { type: 'block', reason: `PR #${pr.number} merged on GitHub after this task left Ready to merge` }, server, { event: 'merged_after_veto' })
      }
      return false
    })
    this.#forget(taskId)
    await this.#publish(taskId)
    if (merged) await this.cleanup(taskId)
  }

  #forget(taskId: string): void {
    this.#attempts.clear(taskId)
    this.#ciPoll.clear(taskId)
    this.#retry.clear(taskId)
    this.#gatesNoted.delete(taskId)
  }

  // `gates` are the facts Corral merged on; null means it may not have merged it
  async #recordMergedIn(tx: Executor, { task, project }: { task: TaskRow, project: ProjectRow }, pr: PullRequest, gates: MergeGateFacts | null): Promise<true> {
    const detail = { pr: pr.number, mergeCommitSha: pr.mergeCommitSha }
    if (gates) {
      // Core re-checks the gates; GitHub has already confirmed the merge, so
      // the facts describe the merged commit
      await applyTransition(tx, task, project, { type: 'merged', gates: { ...gates, mergeable: true } }, server, { event: 'merged', ...detail })
    } else {
      await applyTransition(tx, task, project, { type: 'merged_outside' }, server, { event: 'merged', ...detail, outside: true })
    }
    await tx.update(tasks).set({ mergeCommitSha: pr.mergeCommitSha, mergedAt: this.#now(), updatedAt: this.#now() }).where(eq(tasks.id, task.id))
    this.#forget(task.id)
    return true
  }

  // flows.md step 10: the runner removes the worktrees, keeping any with
  // uncommitted changes and flagging them
  async cleanup(taskId: string): Promise<void> {
    const { db, runner } = this.#d
    try {
      const [row] = await db.select({ task: tasks, project: schema.projects }).from(tasks)
        .innerJoin(schema.projects, eq(schema.projects.id, tasks.projectId)).where(eq(tasks.id, taskId))
      if (!row) return
      const result = await runner.request({ kind: 'cleanup_worktrees', repository: row.project.repository, taskId })
      await appendAudit(db, { projectId: row.project.id, taskId, actor: server }, auditEvent('worktrees.cleaned', result))
      if (result.kept.length > 0) {
        await db.insert(comments).values({ taskId, author: server, body: `The runner kept a worktree with uncommitted changes: ${result.kept.join(', ')}. Remove it by hand when you're done with it.` })
      }
    } catch (error) {
      console.error(`Worktree cleanup for task ${taskId} failed`, error)
    }
  }

  // Human review → Ready to merge (design/inbox.md "Approve and merge").
  // The human's part ends here; CI, the gates and the merge follow in the
  // background, and any failure sends the task back like any other.
  async humanApprove(taskId: string, actor: Actor, note?: string): Promise<void> {
    const { db } = this.#d
    await db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, taskId)
      if (task.type === 'design') throw new ApiFailure(409, { code: 'conflict', constraint: 'approve_design_version' })
      await applyTransition(tx, task, project, { type: 'human_approve' }, actor, { event: 'human_approve', headSha: task.headSha })
      if (note?.trim()) await tx.insert(comments).values({ taskId, author: actor, body: note.trim(), pinned: false })
    })
    await this.#publish(taskId)
    const [row] = await db.select({ task: tasks, project: schema.projects }).from(tasks)
      .innerJoin(schema.projects, eq(schema.projects.id, tasks.projectId)).where(eq(tasks.id, taskId))
    // A spike is finished once approved (D19): there's no PR to merge
    if (row?.task.status === 'merged') void this.cleanup(taskId)
    else if (row && !this.stopped && row.task.prNumber && row.task.headSha) void this.#advanceOnce(row.task, row.project)
  }

  // Only from the status the pass read: a human may have moved the task since
  async #transition(taskId: string, event: Parameters<typeof applyTransition>[3], detail: TransitionDetail, comment?: string, from: TaskStatus = 'ready_to_merge'): Promise<void> {
    await this.#d.db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, taskId)
      if (task.leaseRunId || task.status !== from) return
      await applyTransition(tx, task, project, event, server, detail)
      if (comment) await tx.insert(comments).values({ taskId, author: server, body: comment })
    })
    await this.#publish(taskId)
  }

  async #publish(taskId: string): Promise<void> {
    const task = await loadTask(this.#d.db, taskId).catch(() => null)
    if (task) this.#d.events.publish({ type: 'task.updated', task })
    if (task?.status === 'merged') {
      const dependents = await publishDependents(this.#d.db, this.#d.events, taskId)
      this.#d.wake?.(dependents)
    }
  }
}
