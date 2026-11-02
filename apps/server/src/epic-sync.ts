import { ACTIVE_RUN_STATES, type Actor, type EpicFixReport } from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, notInArray, or } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { complete, epicBoard } from './epic-prs.ts'
import { ACTIVE_OPERATION as ACTIVE, APPROVED_STATES, approvalChange, approvalFate } from './epic-rebase-approval.ts'
import { loadEpic } from './epics.ts'
import { ApiFailure, notFound } from './errors.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import type { RunnerHub } from './runner-hub.ts'
import { checkTrivialRebase } from './rebase-review.ts'
import { Backoff } from './retries.ts'
import { epicResolutionBranch } from './task-base.ts'
import { runEndValues } from './run-lifecycle.ts'
import { applyTransition, deleteTaskRows, lockTask, type ProjectRow } from './tasks.ts'

const { comments, epics, projects, runs, taskIntegrationOperations: operations, tasks } = schema
type OperationRow = typeof operations.$inferSelect
type EpicRow = typeof epics.$inferSelect
type Context = { epic: EpicRow, project: ProjectRow }
type Stopped = () => boolean

const server: Actor = { kind: 'system', component: 'server' }

// Endings that say nothing against these commits: they retry at once
const EPIC_MOVED = 'The epic branch moved'
const INTERRUPTED = 'Interrupted before a candidate was ready'
const EPIC_MERGED = 'The epic PR merged'
const RETRY_AT_ONCE = [EPIC_MOVED, INTERRUPTED, EPIC_MERGED]
// Failures on the same commits before it takes a human to retry. Each waits a
// little longer, so one bad minute doesn't use them all.
const MAX_FAILED_ATTEMPTS = 3
const RETRY_DELAY_MS = 60_000

// How often an epic at a checkpoint of its own reads GitHub, at first and at
// most: nothing is waiting on it, and the target rarely moves between two looks
const CHECKPOINT_POLL_MS = 30_000
const CHECKPOINT_IDLE_MS = 120_000

const PREPARE_TIMEOUT_MS = 12 * 60_000
const PUSH_TIMEOUT_MS = 13 * 60_000

export interface EpicSyncDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  runner: RunnerHub
  now?: () => Date
  wake?: (taskIds: string[]) => void
}

export async function activeRebase(db: Executor, epicId: string): Promise<OperationRow | null> {
  const [row] = await db.select().from(operations).where(and(eq(operations.epicId, epicId), eq(operations.kind, 'rebase'), inArray(operations.state, [...ACTIVE])))
  return row ?? null
}

// activeRebase for many epics at once
export async function rebasingEpics(db: Executor, epicIds: string[]): Promise<Set<string>> {
  const rows = await db.select({ epicId: operations.epicId }).from(operations).where(and(inArray(operations.epicId, epicIds), eq(operations.kind, 'rebase'), inArray(operations.state, [...ACTIVE])))
  return new Set(rows.map(r => r.epicId))
}

// Stops synchronizing until a human retries. Recovery has run out, so it's on
// the epic and a Needs you item until Retry or the merge (D11, D29).
export async function recordSyncFailure(db: Executor, project: ProjectRow, epicId: string, error: string, now: Date): Promise<void> {
  await db.update(epics).set({ syncError: error, updatedAt: now }).where(eq(epics.id, epicId))
  await appendAudit(db, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId, event: 'sync_failed', summary: error }))
}

// A human asks for another go, which counts failures afresh. A resolution or
// fix that failed to publish keeps its candidate and just pushes again; a fix
// with no report left starts another developer run.
export async function retrySync(db: Database, epicId: string, actor: Actor, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
    if (!epic) throw notFound()
    if (!epic.syncError && epic.reviewState !== 'conflict') throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_sync_not_failed' })
    await tx.update(epics).set({ syncError: null, syncRetriedAt: now, updatedAt: now }).where(eq(epics.id, epicId))
    await tx.update(operations).set({ pushAttempts: 0, fixAttempts: 0 }).where(and(eq(operations.epicId, epicId), inArray(operations.state, [...ACTIVE])))
    await appendAudit(tx, { projectId: epic.projectId, actor }, auditEvent('epic.pr', { epicId, event: 'sync_retried' }))
  })
}

// Keeps an epic branch on top of its target branch (D27). Every rebase is a
// journaled operation in the same table as task integration, whose one-active-
// per-epic index is the epic's writer lock, so the two can never both publish.
// The rest of this runs inside TaskIntegrator's serialized pass, and each step
// can be worked out again from the journal and the remote after a restart.
//
// A clean rebase is mechanical and keeps approval. A conflict stays on an
// isolated candidate branch: the operation holds the lock while a developer
// run on the epic, with no task, works on it (D29). CI and integration review
// fixes take the same path. Only a reported candidate is pushed to the epic
// branch, and approval crosses it only when approvalFate says so; a question
// goes to the human on the same operation. A resolution task from before D29
// finishes as it started.
export class EpicSynchronizer {
  #d: EpicSyncDeps
  #settled: (taskId: string) => Promise<void>
  #poll: Backoff

  constructor(deps: EpicSyncDeps, settled: (taskId: string) => Promise<void>) {
    this.#d = deps
    this.#settled = settled
    this.#poll = new Backoff(CHECKPOINT_POLL_MS, CHECKPOINT_IDLE_MS, () => this.#now())
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date()
  }

  // Epics at a checkpoint of their own: every task is in, so they're heading
  // for review or merge. Those with tasks to come sync when one integrates,
  // and those it looked at lately wait their turn.
  async due(): Promise<string[]> {
    const { db } = this.#d
    const rows = await db.select({ id: epics.id }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId))
      .where(and(ne(epics.reviewMode, 'direct'), isNotNull(epics.branch), isNull(epics.syncError), eq(projects.paused, false), or(isNull(epics.reviewState), ne(epics.reviewState, 'merged'))))
    const due = await Promise.all(rows.filter(({ id }) => this.#poll.due(id)).map(async ({ id }) => complete(await epicBoard(db, id)) ? id : null))
    return due.filter(id => id !== null)
  }

  // The checkpoint: writes the intent when the target has moved. Deduplicated
  // by the epic row lock and the writer lock, so polls can't start a second one.
  async begin(epicId: string, stopped: Stopped): Promise<OperationRow | null> {
    const { db, github, runner } = this.#d
    if (stopped() || !runner.epicRebaseRunner()) return null
    const [row] = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, epicId))
    if (!row || !this.#eligible(row.epic, row.project)) return null
    const { epic, project } = row
    // An integration review is judging this head, and a developer handed the
    // old conflict task is rewriting it; each finishes first
    const [reviewing] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.epicId, epicId), inArray(runs.state, [...ACTIVE_RUN_STATES]))).limit(1)
    const [handedOff] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, epicId), eq(tasks.branch, epic.branch!), isNull(tasks.deletedAt), notInArray(tasks.status, ['merged']))).limit(1)
    if (reviewing || handedOff) return null
    // Before the reads, so a failed one waits too. A rebase starts the count again.
    this.#poll.later(epicId)
    const head = await github.branchHead(project.repository, epic.branch!)
    const onto = await github.branchHead(project.repository, project.defaultBranch)
    if (!head || !onto || await github.behindBy(project.repository, project.defaultBranch, head) === 0) return null
    if (await this.#prShut(epic, project)) return null
    const failures = await this.#failures(db, epic, head, onto)
    const last = failures[0]
    if (last && this.#now().getTime() - last.updatedAt.getTime() < RETRY_DELAY_MS * failures.length) return null
    const created = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
      if (!locked || !this.#eligible(locked, project)) return null
      const [newest] = await tx.select({ leaseEpoch: operations.leaseEpoch }).from(operations).where(eq(operations.epicId, epicId)).orderBy(desc(operations.leaseEpoch)).limit(1)
      const [created] = await tx.insert(operations).values({ epicId, kind: 'rebase', expectedTargetSha: head, ontoSha: onto, leaseEpoch: (newest?.leaseEpoch ?? 0) + 1 }).onConflictDoNothing().returning()
      if (created) await appendAudit(tx, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId, event: 'rebase_requested', headSha: head }))
      return created ?? null
    })
    if (created) this.#poll.clear(epicId)
    return created
  }

  #eligible(epic: EpicRow, project: ProjectRow): boolean {
    return !project.paused && !epic.syncError && !!epic.branch && epic.reviewMode !== 'direct' && epic.reviewState !== 'merged'
  }

  // A PR closed without merging can be reopened, unless its branch was
  // force-pushed: GitHub refuses that. Its epic may also be work the human
  // dropped, so nothing is rebased until the PR is open again. A PR that merged
  // is on its way to the merge pass, which records it.
  async #prShut(epic: EpicRow, project: ProjectRow): Promise<boolean> {
    if (!epic.prNumber) return false
    const pr = await this.#d.github.getPullRequest(project.repository, epic.prNumber)
    return pr.state !== 'open' || pr.merged
  }

  // Newest first. A retry starts the count again, and a moved commit is new work.
  #failures(db: Executor, epic: EpicRow, head: string, onto: string) {
    return db.select().from(operations).where(and(
      eq(operations.epicId, epic.id), eq(operations.kind, 'rebase'), eq(operations.state, 'failed'), eq(operations.expectedTargetSha, head), eq(operations.ontoSha, onto),
      notInArray(operations.error, RETRY_AT_ONCE), epic.syncRetriedAt ? gte(operations.createdAt, epic.syncRetriedAt) : undefined
    )).orderBy(desc(operations.createdAt))
  }

  // One step. True when the epic should be looked at again now.
  async step(operation: OperationRow, stopped: Stopped): Promise<boolean> {
    const { db } = this.#d
    const [row] = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, operation.epicId))
    if (row!.epic.reviewState === 'merged') return this.#fail(operation, row!, EPIC_MERGED)
    if (operation.state === 'pending') return this.#prepare(operation, row!, stopped)
    if (operation.state === 'reconciling') return this.#reconcile(operation, row!)
    if (operation.resolutionTaskId) return this.#awaitResolution(operation, row!, stopped)
    if (operation.fix) return this.#awaitFix(operation, row!, stopped)
    // Running with a clean candidate, unless it was cut off before it had one
    const candidate = operation.resultHeadSha
    if (candidate && this.#d.runner.isOnline(operation.runnerId)) return this.#publish(operation, row!, candidate, operation.runnerId!, stopped)
    return this.#fail(operation, row!, INTERRUPTED)
  }

  async #prepare(pending: OperationRow, ctx: Context, stopped: Stopped): Promise<boolean> {
    const { db, runner } = this.#d
    if (stopped() || ctx.project.paused) return false
    const runnerId = runner.epicRebaseRunner()
    if (!runnerId) return false
    const [operation] = await db.update(operations).set({ state: 'running', runnerId, updatedAt: this.#now() })
      .where(and(eq(operations.id, pending.id), eq(operations.state, 'pending'), eq(operations.leaseEpoch, pending.leaseEpoch))).returning()
    if (!operation) return false
    let prepared
    try {
      prepared = await runner.requestOn<'epic_rebase_prepare'>(runnerId, {
        kind: 'epic_rebase_prepare', repository: ctx.project.repository, epicBranch: ctx.epic.branch!, expectedHeadSha: operation.expectedTargetSha, ontoSha: operation.ontoSha!
      }, PREPARE_TIMEOUT_MS)
    } catch (error) {
      return this.#fail(operation, ctx, `The runner could not finish the rebase: ${message(error)}`)
    }
    switch (prepared.status) {
      case 'up_to_date':
        await this.#complete(operation, ctx, operation.expectedTargetSha)
        return true
      case 'moved':
        return this.#fail(operation, ctx, EPIC_MOVED)
      case 'failed':
        return this.#fail(operation, ctx, `The rebase failed: ${prepared.error ?? 'unknown error'}`)
      case 'conflict':
        // Preparing can take minutes. Nothing was written, so it starts over.
        if (stopped() || await this.#paused(ctx.project)) {
          await db.update(operations).set({ state: 'pending', updatedAt: this.#now() }).where(and(eq(operations.id, operation.id), eq(operations.state, 'running')))
          return false
        }
        await this.#startFix(operation, ctx, prepared.files)
        return false
      case 'rebased': {
        const [ready] = await db.update(operations).set({ resultHeadSha: prepared.commitSha, updatedAt: this.#now() }).where(eq(operations.id, operation.id)).returning()
        return this.#publish(ready!, ctx, prepared.commitSha!, runnerId, stopped)
      }
    }
  }

  // The developer starts from the epic head on a branch of its own, and the
  // operation keeps the writer lock so that head stays good for the final push.
  // The epic's approval stands until the publish step has judged the result.
  async #startFix(operation: OperationRow, { epic, project }: Context, files: string[]): Promise<void> {
    const { db } = this.#d
    const brief = `The rebase onto ${project.defaultBranch} conflicts${files.length ? ` in ${files.join(', ')}` : ''}.`
    await db.transaction(async (tx) => {
      await tx.update(operations).set({ fix: 'conflict', fixBrief: brief, conflictFiles: files, updatedAt: this.#now() }).where(eq(operations.id, operation.id))
      await appendAudit(tx, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId: epic.id, event: 'fix_started', fix: 'conflict', operationId: operation.id, summary: brief, files }))
    })
    await this.#publishEpic(epic.id)
    this.#d.wake?.([])
  }

  // A reported candidate moves on; until then the claim keeps a developer on it
  async #awaitFix(operation: OperationRow, ctx: Context, stopped: Stopped): Promise<boolean> {
    const report = operation.fixReport
    if (!report || ctx.epic.syncError) return false
    const runnerId = this.#d.runner.epicRebaseRunner()
    if (!runnerId || await this.#held(ctx)) return false
    await this.#checkFix(operation, ctx, report)
    return this.#push(operation, ctx, report.headSha, runnerId, stopped)
  }

  // Before the push: afterwards the old head is unreachable. Only a conflict
  // reported as unchanged on an approved head has anything riding on this.
  async #checkFix(operation: OperationRow, { epic, project }: Context, report: EpicFixReport): Promise<void> {
    if (operation.fix !== 'conflict' || report.behaviourChanged || !APPROVED_STATES.includes(epic.reviewState)) return
    const check = await checkTrivialRebase(this.#d.github, project.repository, { baseBranch: project.defaultBranch, approvedHeadSha: operation.expectedTargetSha, newHeadSha: report.headSha, conflictedFiles: report.conflictedFiles })
    const outsideConflicts = check.failures.find(f => f.condition === 'changes_outside_conflicts')?.files ?? []
    await this.#d.db.update(operations).set({ fixReport: { ...report, outsideConflicts, checkError: check.error ?? null } }).where(eq(operations.id, operation.id))
  }

  // Only an approved resolution moves on. Anything else is the task's own
  // story, on the board or in the Inbox, and the lock waits for it.
  async #awaitResolution(operation: OperationRow, ctx: Context, stopped: Stopped): Promise<boolean> {
    const { db, runner } = this.#d
    const [task] = await db.select().from(tasks).where(eq(tasks.id, operation.resolutionTaskId!))
    if (!task || task.deletedAt) return this.#fail(operation, ctx, 'The conflict resolution task was deleted')
    if (task.status !== 'ready_to_merge' || task.leaseRunId || task.paused || !task.headSha || ctx.epic.syncError) return false
    const runnerId = runner.epicRebaseRunner()
    if (!runnerId) return false
    if (await this.#held(ctx)) return false
    await this.#checkResolution(operation, ctx, task.headSha)
    return this.#push(operation, ctx, task.headSha, runnerId, stopped)
  }

  // A rebase can outlast the PR it's for. It keeps its candidate, and its
  // review, to publish if the PR is reopened.
  async #held({ epic, project }: Context): Promise<boolean> {
    if (!this.#poll.due(epic.id)) return true
    const shut = await this.#prShut(epic, project)
    if (shut) this.#poll.later(epic.id)
    return shut
  }

  // Compares the approved and rebased changes on the server's own account, not
  // the reviewer's. Before the push: afterwards the old head is unreachable.
  async #checkResolution(operation: OperationRow, { epic, project }: Context, candidate: string): Promise<void> {
    const { db, github } = this.#d
    // Read now: the caller's copy can predate the review that freed the task
    const [current] = await db.select().from(operations).where(eq(operations.id, operation.id))
    const review = current?.resolutionReview
    if (review?.headSha !== candidate || !APPROVED_STATES.includes(epic.reviewState)) return
    const check = await checkTrivialRebase(github, project.repository, { baseBranch: project.defaultBranch, approvedHeadSha: operation.expectedTargetSha, newHeadSha: candidate, conflictedFiles: operation.conflictFiles ?? [] })
    const outsideConflicts = check.failures.find(f => f.condition === 'changes_outside_conflicts')?.files ?? []
    await db.update(operations).set({ resolutionReview: { ...review, outsideConflicts, checkError: check.error ?? null } }).where(eq(operations.id, operation.id))
  }

  async #publish(operation: OperationRow, ctx: Context, candidate: string, runnerId: string, stopped: Stopped): Promise<boolean> {
    return !await this.#held(ctx) && this.#push(operation, ctx, candidate, runnerId, stopped)
  }

  async #push(operation: OperationRow, ctx: Context, candidate: string, runnerId: string, stopped: Stopped): Promise<boolean> {
    const { db, runner } = this.#d
    const { project, epic } = ctx
    // Read now: a candidate can take minutes to prepare. A stopped operation
    // stays running, to resume as it was.
    if (stopped() || await this.#paused(project)) return false
    // From here the result is unknown until the branch has been read
    const [pushing] = await db.update(operations).set({ state: 'reconciling', resultHeadSha: candidate, error: null, pushAttempts: operation.pushAttempts + 1, updatedAt: this.#now() })
      .where(and(eq(operations.id, operation.id), eq(operations.state, 'running'), eq(operations.leaseEpoch, operation.leaseEpoch))).returning()
    if (!pushing) return false
    // Nothing was sent, so this isn't an unknown result
    if (stopped()) {
      await db.update(operations).set({ state: 'running', pushAttempts: operation.pushAttempts }).where(eq(operations.id, operation.id))
      return false
    }
    let error: string | null
    try {
      const result = await runner.requestOn<'epic_rebase_push'>(runnerId, {
        kind: 'epic_rebase_push', repository: project.repository, epicBranch: epic.branch!, targetBranch: project.defaultBranch, expectedHeadSha: operation.expectedTargetSha, ontoSha: operation.ontoSha!, candidateSha: candidate
      }, PUSH_TIMEOUT_MS)
      if (result.rejected) {
        await this.#reject(pushing, ctx, result.rejected)
        return false
      }
      error = result.error
    } catch (failure) {
      error = `The runner could not finish the push: ${message(failure)}`
    }
    if (error) await db.update(operations).set({ error }).where(eq(operations.id, operation.id))
    return true
  }

  async #paused(project: ProjectRow): Promise<boolean> {
    const [row] = await this.#d.db.select({ paused: projects.paused }).from(projects).where(eq(projects.id, project.id))
    return row?.paused ?? true
  }

  // The push checks found the candidate wrong, and nothing left the runner. The
  // resolution goes back to its developer, still holding the lock.
  async #reject(operation: OperationRow, ctx: Context, reason: string): Promise<void> {
    const { db } = this.#d
    await db.update(operations).set({ state: 'running', resultHeadSha: null, pushAttempts: 0, updatedAt: this.#now() }).where(eq(operations.id, operation.id))
    if (operation.fix) return this.#refuseFix(operation, ctx, reason)
    if (!operation.resolutionTaskId) {
      await this.#fail({ ...operation, state: 'running' }, ctx, `Corral's own rebase was rejected: ${reason}`)
      return
    }
    await db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, operation.resolutionTaskId!)
      await applyTransition(tx, task, project, { type: 'ci_failed' }, server, { event: 'ci_failed', checks: [] })
      await tx.insert(comments).values({ taskId: task.id, author: server, body: `The rebased branch can't go onto the epic branch. ${reason} Fix that and report pr_updated.` })
    })
    await this.#settled(operation.resolutionTaskId)
  }

  // Back to a developer with the reason, on the same candidate, within a bound
  async #refuseFix(operation: OperationRow, { epic, project }: Context, reason: string): Promise<void> {
    const { db } = this.#d
    const attempts = operation.fixAttempts + 1
    await db.transaction(async (tx) => {
      await tx.update(operations).set({ fixReport: null, fixAttempts: attempts, fixBrief: `${operation.fixBrief}\n\nCorral refused your last candidate, and the epic branch didn't move: ${reason}`, updatedAt: this.#now() }).where(eq(operations.id, operation.id))
      await appendAudit(tx, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId: epic.id, event: 'fix_refused', fix: operation.fix!, operationId: operation.id, summary: reason }))
      if (attempts >= MAX_FAILED_ATTEMPTS) await recordSyncFailure(tx, project, epic.id, `Corral refused the candidate ${attempts} times: ${reason}`, this.#now())
    })
    await this.#publishEpic(epic.id)
    this.#d.wake?.([])
  }

  // The epic branch says what happened. A failed read leaves it for a later pass.
  async #reconcile(operation: OperationRow, ctx: Context): Promise<boolean> {
    const { db, github } = this.#d
    const { project, epic } = ctx
    let head
    try {
      head = await github.branchHead(project.repository, epic.branch!)
    } catch (error) {
      console.error(`Could not read the epic branch for rebase ${operation.id}`, error)
      return false
    }
    if (head === operation.resultHeadSha) {
      await this.#complete(operation, ctx, operation.resultHeadSha!)
      return true
    }
    if (head !== operation.expectedTargetSha) return this.#fail(operation, ctx, EPIC_MOVED)
    const error = operation.error ?? 'The push did not reach the epic branch'
    if (!operation.resolutionTaskId && !operation.fix) return this.#fail(operation, ctx, error)
    // A reviewed resolution or a reported fix is worth keeping: push it again, within a bound
    await db.update(operations).set({ state: 'running', updatedAt: this.#now() }).where(eq(operations.id, operation.id))
    if (operation.pushAttempts < MAX_FAILED_ATTEMPTS) return false
    await recordSyncFailure(db, project, epic.id, error, this.#now())
    await this.#publishEpic(epic.id)
    return false
  }

  // A resolution only means anything to its operation: nothing else could
  // publish it, so a task left behind would hold the epic's board forever. The
  // next checkpoint starts again from the branch as it is. Any run on it is
  // fenced by losing its lease.
  async #retireResolution(operation: OperationRow, { epic, project }: Context, reason: string): Promise<void> {
    const { db, events, github } = this.#d
    const taskId = operation.resolutionTaskId!
    const retired = await db.transaction(async (tx) => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update')
      if (!task || task.deletedAt || task.status === 'merged') return false
      await tx.update(runs).set(runEndValues({ state: 'interrupted', error: reason }, this.#now())).where(and(eq(runs.taskId, taskId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      await tx.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null }).where(eq(tasks.id, taskId))
      await deleteTaskRows(tx, taskId, server, reason)
      return true
    })
    if (retired) events.publish({ type: 'task.deleted', taskId, projectId: project.id })
    await github.deleteBranch(project.repository, epicResolutionBranch(operation.id)).catch(error => console.error(`Could not delete the rebase candidate of ${epic.id}`, error))
  }

  // Nothing else could publish a fix's candidate. The next checkpoint, or the
  // next look at CI, starts again from the branch as it is.
  async #retireFix(operation: OperationRow, { epic, project }: Context, reason: string): Promise<void> {
    const { db, github } = this.#d
    await db.update(runs).set(runEndValues({ state: 'interrupted', error: reason }, this.#now())).where(and(eq(runs.operationId, operation.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    await github.deleteBranch(project.repository, epicResolutionBranch(operation.id)).catch(error => console.error(`Could not delete the fix candidate of ${epic.id}`, error))
  }

  async #complete(operation: OperationRow, { epic, project }: Context, commitSha: string): Promise<void> {
    const { db, github } = this.#d
    const taskId = operation.resolutionTaskId
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(epics).where(eq(epics.id, epic.id)).for('update')
      const [done] = await tx.update(operations).set({ state: 'succeeded', resultHeadSha: commitSha, error: null, updatedAt: this.#now() })
        .where(and(eq(operations.id, operation.id), inArray(operations.state, [...ACTIVE]), eq(operations.leaseEpoch, operation.leaseEpoch))).returning()
      if (!done) return
      // Checks and the merge gate read the new head, so keeping approval never
      // skips them. Losing it sends the epic back through the reconcile pass.
      const fate = approvalFate(done, locked!, commitSha)
      // A CI or review fix doesn't move the epic on the target
      const onto = done.fix && done.fix !== 'conflict' ? locked!.approvedBaseSha : operation.ontoSha
      const reviewFix = done.fix === 'review'
      const approval = fate?.kept
        ? { prHeadSha: commitSha, approvedBaseSha: onto, reviewState: locked!.reviewState === 'conflict' ? 'ready_to_merge' as const : locked!.reviewState }
        : fate || reviewFix ? { reviewState: 'open' as const, approvedHeadSha: null, approvedBaseSha: null } : {}
      await tx.update(epics).set({ syncError: null, conflictFiles: null, ...approval, updatedAt: this.#now() }).where(eq(epics.id, epic.id))
      await appendAudit(tx, { projectId: project.id, actor: server }, auditEvent('epic.pr', done.fix && done.fix !== 'conflict'
        ? { epicId: epic.id, event: 'fix_published', fix: done.fix, operationId: done.id, from: operation.expectedTargetSha, to: commitSha }
        : { epicId: epic.id, event: 'rebased', from: operation.expectedTargetSha, to: commitSha }))
      if (done.fixReport && commitSha !== operation.expectedTargetSha) await tx.update(runs).set({ reReviewed: reviewFix || (fate ? !fate.kept : null) }).where(eq(runs.id, done.fixReport.runId))
      if (fate) await appendAudit(tx, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId: epic.id, ...approvalChange(done, locked!, commitSha, fate) }))
      if (!taskId) return
      const { task } = await lockTask(tx, taskId)
      if (task.status !== 'ready_to_merge') return
      await applyTransition(tx, task, project, { type: 'merged_outside' }, server, { event: 'merged', headSha: commitSha })
      await tx.update(tasks).set({ mergeCommitSha: commitSha, mergedAt: this.#now(), updatedAt: this.#now() }).where(eq(tasks.id, taskId))
    })
    await this.#publishEpic(epic.id)
    if (taskId) await this.#settled(taskId)
    if (taskId || operation.fix) await github.deleteBranch(project.repository, epicResolutionBranch(operation.id)).catch(error => console.error(`Could not delete the rebase candidate of ${epic.id}`, error))
  }

  // True: look at the epic again now. Other endings wait for a later pass, and
  // enough of them on the same commits stop until a human retries.
  async #fail(operation: OperationRow, { epic, project }: Context, error: string): Promise<boolean> {
    const { db } = this.#d
    await db.update(operations).set({ state: 'failed', error, updatedAt: this.#now() })
      .where(and(eq(operations.id, operation.id), inArray(operations.state, [...ACTIVE]), eq(operations.leaseEpoch, operation.leaseEpoch)))
    await appendAudit(db, { projectId: project.id, actor: server }, auditEvent('epic.pr', { epicId: epic.id, event: 'rebase_failed', summary: error }))
    if (operation.resolutionTaskId) await this.#retireResolution(operation, { epic, project }, error)
    if (operation.fix) await this.#retireFix(operation, { epic, project }, error)
    const failures = RETRY_AT_ONCE.includes(error) ? [] : await this.#failures(db, epic, operation.expectedTargetSha, operation.ontoSha!)
    if (failures.length >= MAX_FAILED_ATTEMPTS) await recordSyncFailure(db, project, epic.id, `Rebasing onto ${project.defaultBranch} failed ${failures.length} times: ${error}`, this.#now())
    await this.#publishEpic(epic.id)
    return RETRY_AT_ONCE.includes(error)
  }

  async #publishEpic(epicId: string): Promise<void> {
    this.#d.events.publish({ type: 'epic.updated', epic: await loadEpic(this.#d.db, epicId) })
  }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
