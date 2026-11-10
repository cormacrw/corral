import type { ApprovalChange } from '@corral/contracts'
import { ACTIVE_OPERATION_STATES, ACTIVE_RUN_STATES, approvalFate, APPROVED_STATES, boardComplete, errorText, hasPrToLand, SERVER_ACTOR, shortSha, type ApprovalFate, type EpicFixReport } from '@corral/core'
import { schema, type EpicRow, type Executor, type OperationRow, type ProjectRow } from '@corral/db'
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { prToLand } from './delivery-sql.ts'
import { publishEpic } from './epics.ts'
import { beginOperation, countsAsFailure, deferredConflicts, endedBy, endingText, moveOperation, recordSyncFailure, type BranchWriterDeps, type OperationEnding } from './operations.ts'
import { epicBoard } from './parents.ts'
import { refusedBrief } from './prompts.ts'
import type { RunnerHub } from './runner-hub.ts'
import { Backoff, LONGEST_POLL_MS } from './retries.ts'
import { EpicBranchError, epicResolutionBranch } from './task-base.ts'
import { endActiveRuns } from './run-lifecycle.ts'
import { checkTrivialRebase } from './github-diff.ts'

const { epics, projects, runs, taskIntegrationOperations: operations } = schema
type Context = { epic: EpicRow, project: ProjectRow }

// Endings that say nothing against these commits: they retry at once
const RETRY_AT_ONCE: OperationEnding[] = ['targetMoved', 'interrupted', 'deliveryMerged']
// Failures on the same commits before it takes a human to retry. Each waits a
// little longer, so one bad minute doesn't use them all.
const MAX_FAILED_ATTEMPTS = 3
const RETRY_DELAY_MS = 60_000

// How often an epic at a checkpoint of its own reads GitHub, at first and at
// most: nothing is waiting on it, and the target rarely moves between two looks
const CHECKPOINT_POLL_MS = 30_000
const CHECKPOINT_IDLE_MS = LONGEST_POLL_MS

// What a fix's candidate changes in files only the target changed, for the
// integration review. Only the runner's git can say so exactly as the push guard
// will, so a runner that can't answer holds the publish back rather than failing a run.
export async function targetFileChanges(runner: RunnerHub, input: { repository: string, targetBranch: string, expectedHeadSha: string, candidateSha: string }) {
  const runnerId = runner.jobRunner()
  if (!runnerId) throw new EpicBranchError('No runner can read the rebase candidate yet')
  try {
    const { targetFiles } = await runner.requestOn<'epic_rebase_inspect'>(runnerId, { kind: 'epic_rebase_inspect', ...input })
    return targetFiles
  } catch (error) {
    throw new EpicBranchError(`Could not read the rebase candidate: ${errorText(error)}`)
  }
}

// The history line that says what was approved, what it became and why
function approvalChange(operation: OperationRow, epic: EpicRow, commitSha: string, fate: ApprovalFate): ApprovalChange {
  return {
    event: fate.kept ? 'approval_retained' : 'approval_invalidated',
    approvedHeadSha: epic.approvedHeadSha,
    from: operation.expectedTargetSha,
    to: commitSha,
    ontoSha: operation.ontoSha,
    operationId: operation.id,
    resolutionTaskId: null,
    ...(operation.fixReport && { fixRunId: operation.fixReport.runId }),
    resolutionReview: null,
    reason: fate.reason,
    summary: `Approved ${shortSha(epic.approvedHeadSha)}, rebased ${shortSha(operation.expectedTargetSha)} to ${shortSha(commitSha)}. ${fate.reason}`
  }
}

// Keeps an epic branch on top of its target branch (D27). Every rebase is a
// journaled operation in the same table as task integration, whose one-active-
// per-epic index is the epic's writer lock, so the two can never both publish.
// The rest of this runs inside TaskIntegrator's serialized pass, and each step
// can be worked out again from the journal and the remote after a restart.
//
// A clean rebase is mechanical and keeps approval. A conflict before the final
// checkpoint is only noted: the lock goes and the epic carries on, because the
// target may move again and each resolution costs a run (COR-445). At the final
// checkpoint it stays on an isolated candidate branch: the operation holds the lock while a developer
// run on the epic, with no task, works on it (D29). CI and integration review
// fixes take the same path. Only a reported candidate is pushed to the epic
// branch, and approval crosses it only when approvalFate says so; a question
// goes to the human on the same operation.
export class EpicSynchronizer {
  #d: BranchWriterDeps
  #poll: Backoff

  constructor(deps: BranchWriterDeps) {
    this.#d = deps
    this.#poll = new Backoff(CHECKPOINT_POLL_MS, CHECKPOINT_IDLE_MS, () => this.#now())
  }

  #now(): Date {
    return this.#d.now()
  }

  // Epics at a checkpoint of their own: every task is in, so they're heading
  // for review or merge. Those with tasks to come sync when one integrates,
  // and those it looked at lately wait their turn.
  async due(): Promise<string[]> {
    const { db } = this.#d
    const rows = await db.select({ id: epics.id }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId))
      .where(and(prToLand(epics), isNull(epics.syncError), eq(projects.paused, false)))
    const due = await Promise.all(rows.filter(({ id }) => this.#poll.due(id)).map(async ({ id }) => boardComplete(await epicBoard(db, id)) ? id : null))
    return due.filter(id => id !== null)
  }

  // The checkpoint: writes the intent when the target has moved. Deduplicated
  // by the epic row lock and the writer lock, so polls can't start a second one.
  async begin(epicId: string): Promise<OperationRow | null> {
    const { db, github, runner } = this.#d
    if (this.#d.gate.halted || !runner.jobRunner()) return null
    const [row] = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, epicId))
    if (!row || !this.#eligible(row.epic, row.project)) return null
    const { epic, project } = row
    // An integration review is judging this head; it finishes first
    const [reviewing] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.epicId, epicId), inArray(runs.state, [...ACTIVE_RUN_STATES]))).limit(1)
    if (reviewing) return null
    // Before the reads, so a failed one waits too. A rebase starts the count again.
    this.#poll.later(epicId)
    const head = await github.branchHead(project.repository, epic.branch!)
    const onto = await github.branchHead(project.repository, project.defaultBranch)
    if (!head || !onto) return null
    if (await github.behindBy(project.repository, project.defaultBranch, head) === 0) {
      await this.#clearDeferred(epicId)
      return null
    }
    if (await this.#prShut(epic, project)) return null
    // The same commits would conflict the same way. Approval is what changes that.
    const deferred = (await deferredConflicts(db, [epicId])).get(epicId)
    if (deferred?.expectedTargetSha === head && deferred.ontoSha === onto && !finalCheckpoint(epic, head)) return null
    const failures = await this.#failures(db, epic, head, onto)
    const last = failures[0]
    if (last && this.#now().getTime() - last.updatedAt.getTime() < RETRY_DELAY_MS * failures.length) return null
    const created = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
      if (!locked || !this.#eligible(locked, project)) return null
      const created = await beginOperation(tx, { epicId, kind: 'rebase', expectedTargetSha: head, ontoSha: onto })
      if (created) await appendAudit(tx, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId, event: 'rebase_requested', headSha: head }))
      return created
    })
    if (created) this.#poll.clear(epicId)
    return created
  }

  #eligible(epic: EpicRow, project: ProjectRow): boolean {
    return !project.paused && !epic.syncError && hasPrToLand(epic)
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
      countsAsFailure([...RETRY_AT_ONCE, 'conflictDeferred', 'conflictGone']), epic.syncRetriedAt ? gte(operations.createdAt, epic.syncRetriedAt) : undefined
    )).orderBy(desc(operations.createdAt))
  }

  // One step. True when the epic should be looked at again now.
  async step(operation: OperationRow): Promise<boolean> {
    const { db } = this.#d
    const [row] = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, operation.epicId))
    if (row!.epic.reviewState === 'merged') return this.#fail(operation, row!, endingText('deliveryMerged'))
    if (operation.state === 'pending') return this.#prepare(operation, row!)
    if (operation.state === 'reconciling') return this.#reconcile(operation, row!)
    if (operation.fix) return this.#awaitFix(operation, row!)
    // Running with a clean candidate, unless it was cut off before it had one
    const candidate = operation.resultHeadSha
    if (candidate && this.#d.runner.isOnline(operation.runnerId)) return this.#publish(operation, row!, candidate, operation.runnerId!)
    return this.#fail(operation, row!, endingText('interrupted'))
  }

  async #prepare(pending: OperationRow, ctx: Context): Promise<boolean> {
    const { db, runner } = this.#d
    if (this.#d.gate.halted || ctx.project.paused) return false
    const runnerId = runner.jobRunner()
    if (!runnerId) return false
    const operation = await moveOperation(db, pending, ['pending'], { state: 'running', runnerId, updatedAt: this.#now() })
    if (!operation) return false
    let prepared
    try {
      prepared = await runner.requestOn<'epic_rebase_prepare'>(runnerId, {
        kind: 'epic_rebase_prepare', repository: ctx.project.repository, epicBranch: ctx.epic.branch!, expectedHeadSha: operation.expectedTargetSha, ontoSha: operation.ontoSha!
      })
    } catch (error) {
      return this.#fail(operation, ctx, `The runner could not finish the rebase: ${errorText(error)}`)
    }
    switch (prepared.status) {
      case 'up_to_date':
        await this.#complete(operation, ctx, operation.expectedTargetSha)
        return true
      case 'moved':
        return this.#fail(operation, ctx, endingText('targetMoved'))
      case 'failed':
        return this.#fail(operation, ctx, `The rebase failed: ${prepared.error ?? 'unknown error'}`)
      case 'conflict':
        // Preparing can take minutes. Nothing was written, so it starts over.
        if (this.#d.gate.halted || await this.#paused(ctx.project)) {
          await moveOperation(db, operation, ['running'], { state: 'pending', updatedAt: this.#now() })
          return false
        }
        // Approval waits for the writer lock, so this read can't go stale
        if (!finalCheckpoint(await this.#current(ctx.epic), operation.expectedTargetSha)) return this.#defer(operation, ctx, prepared.files)
        await this.#startFix(operation, ctx, prepared.files)
        return false
      case 'rebased': {
        const [ready] = await db.update(operations).set({ resultHeadSha: prepared.commitSha, updatedAt: this.#now() }).where(eq(operations.id, operation.id)).returning()
        return this.#publish(ready!, ctx, prepared.commitSha!, runnerId)
      }
    }
  }

  async #current(epic: EpicRow): Promise<EpicRow> {
    const [row] = await this.#d.db.select().from(epics).where(eq(epics.id, epic.id))
    return row!
  }

  // Nothing was written and nothing failed. Ending the operation frees the
  // writer lock, so tasks and reviews carry on; the next checkpoint tries again
  // if the commits have moved, and resolves it for real once approved.
  async #defer(operation: OperationRow, { epic, project }: Context, files: string[]): Promise<boolean> {
    const { db } = this.#d
    await db.transaction(async (tx) => {
      const ended = await moveOperation(tx, operation, ACTIVE_OPERATION_STATES, { state: 'failed', error: endingText('conflictDeferred'), conflictFiles: files, updatedAt: this.#now() })
      if (ended) await appendAudit(tx, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId: epic.id, event: 'conflict_deferred', summary: `The rebase onto ${project.defaultBranch} conflicts${files.length ? ` in ${files.join(', ')}` : ''}.`, files }))
    })
    await this.#publishEpic(epic.id)
    return true
  }

  // A hand rebase or GitHub's update branch writes no operation of ours
  async #clearDeferred(epicId: string): Promise<void> {
    const deferred = (await deferredConflicts(this.#d.db, [epicId])).get(epicId)
    if (!deferred) return
    await this.#d.db.update(operations).set({ error: endingText('conflictGone'), updatedAt: this.#now() }).where(eq(operations.id, deferred.id))
    await this.#publishEpic(epicId)
  }

  // The developer starts from the epic head on a branch of its own, and the
  // operation keeps the writer lock so that head stays good for the final push.
  // The epic's approval stands until the publish step has judged the result.
  async #startFix(operation: OperationRow, { epic, project }: Context, files: string[]): Promise<void> {
    const { db } = this.#d
    const brief = `The rebase onto ${project.defaultBranch} conflicts${files.length ? ` in ${files.join(', ')}` : ''}.`
    await db.transaction(async (tx) => {
      await tx.update(operations).set({ fix: 'conflict', fixBrief: brief, conflictFiles: files, updatedAt: this.#now() }).where(eq(operations.id, operation.id))
      await appendAudit(tx, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId: epic.id, event: 'fix_started', fix: 'conflict', operationId: operation.id, summary: brief, files }))
    })
    await this.#publishEpic(epic.id)
    this.#d.wake([])
  }

  // A reported candidate moves on; until then the claim keeps a developer on it
  async #awaitFix(operation: OperationRow, ctx: Context): Promise<boolean> {
    const report = operation.fixReport
    if (!report || ctx.epic.syncError) return false
    const runnerId = this.#d.runner.jobRunner()
    if (!runnerId || await this.#held(ctx)) return false
    await this.#checkFix(operation, ctx, report)
    const reReviewed = report.behaviourChanged || operation.fix === 'review'
    if (reReviewed && !await this.#keepTargetFiles(operation, ctx, report)) return false
    return this.#push(operation, ctx, report.headSha, runnerId, reReviewed)
  }

  // Before the push, which is the last the guard sees of these. The integration
  // review is their whole review (COR-434). No answer waits for the next pass.
  async #keepTargetFiles(operation: OperationRow, { project }: Context, report: EpicFixReport): Promise<boolean> {
    try {
      const targetFiles = await targetFileChanges(this.#d.runner, { repository: project.repository, targetBranch: project.defaultBranch, expectedHeadSha: operation.expectedTargetSha, candidateSha: report.headSha })
      await this.#d.db.update(operations).set({ fixReport: { ...report, targetFiles } }).where(eq(operations.id, operation.id))
      return true
    } catch (error) {
      if (error instanceof EpicBranchError) return false
      throw error
    }
  }

  // Before the push: afterwards the old head is unreachable. Only a conflict
  // reported as unchanged on an approved head has anything riding on this.
  async #checkFix(operation: OperationRow, { epic, project }: Context, report: EpicFixReport): Promise<void> {
    if (operation.fix !== 'conflict' || report.behaviourChanged || !APPROVED_STATES.includes(epic.reviewState)) return
    const compared = await this.#compareApproved(operation, project, report.headSha)
    await this.#d.db.update(operations).set({ fixReport: { ...report, ...compared } }).where(eq(operations.id, operation.id))
  }

  // What the candidate changes outside the conflicted files, against the
  // approved head, on the server's own account
  async #compareApproved(operation: OperationRow, project: ProjectRow, candidate: string): Promise<{ outsideConflicts: string[], checkError: string | null }> {
    const check = await checkTrivialRebase(this.#d.github, project.repository, { baseBranch: project.defaultBranch, approvedHeadSha: operation.expectedTargetSha, newHeadSha: candidate, conflictedFiles: operation.conflictFiles ?? [] })
    return { outsideConflicts: check.failures.find(f => f.condition === 'changes_outside_conflicts')?.files ?? [], checkError: check.error ?? null }
  }

  // A rebase can outlast the PR it's for. It keeps its candidate to publish if
  // the PR is reopened.
  async #held({ epic, project }: Context): Promise<boolean> {
    if (!this.#poll.due(epic.id)) return true
    const shut = await this.#prShut(epic, project)
    if (shut) this.#poll.later(epic.id)
    return shut
  }

  async #publish(operation: OperationRow, ctx: Context, candidate: string, runnerId: string): Promise<boolean> {
    return !await this.#held(ctx) && this.#push(operation, ctx, candidate, runnerId)
  }

  // `reviewed` is the server's word that a reviewer sees this commit's changes to
  // target-only files: a review fix, or a fix reported as changing behaviour,
  // goes back to integration review. Only then may the runner let them through.
  async #push(operation: OperationRow, ctx: Context, candidate: string, runnerId: string, reviewed = false): Promise<boolean> {
    const { db, runner } = this.#d
    const { project, epic } = ctx
    // Read now: a candidate can take minutes to prepare. A stopped operation
    // stays running, to resume as it was.
    if (this.#d.gate.halted || await this.#paused(project)) return false
    // From here the result is unknown until the branch has been read
    const pushing = await moveOperation(db, operation, ['running'], { state: 'reconciling', resultHeadSha: candidate, error: null, pushAttempts: operation.pushAttempts + 1, updatedAt: this.#now() })
    if (!pushing) return false
    // Nothing was sent, so this isn't an unknown result
    if (this.#d.gate.halted) {
      await db.update(operations).set({ state: 'running', pushAttempts: operation.pushAttempts }).where(eq(operations.id, operation.id))
      return false
    }
    let error: string | null
    try {
      const result = await runner.requestOn<'epic_rebase_push'>(runnerId, {
        kind: 'epic_rebase_push', repository: project.repository, epicBranch: epic.branch!, targetBranch: project.defaultBranch, expectedHeadSha: operation.expectedTargetSha, ontoSha: operation.ontoSha!, candidateSha: candidate, reviewed
      })
      if (result.rejected) {
        await this.#reject(pushing, ctx, result.rejected)
        return false
      }
      error = result.error
    } catch (failure) {
      error = `The runner could not finish the push: ${errorText(failure)}`
    }
    if (error) await db.update(operations).set({ error }).where(eq(operations.id, operation.id))
    return true
  }

  async #paused(project: ProjectRow): Promise<boolean> {
    const [row] = await this.#d.db.select({ paused: projects.paused }).from(projects).where(eq(projects.id, project.id))
    return row?.paused ?? true
  }

  // The push checks found the candidate wrong, and nothing left the runner. A
  // fix goes back to its developer, still holding the lock.
  async #reject(operation: OperationRow, ctx: Context, reason: string): Promise<void> {
    await this.#d.db.update(operations).set({ state: 'running', resultHeadSha: null, pushAttempts: 0, updatedAt: this.#now() }).where(eq(operations.id, operation.id))
    if (operation.fix) return this.#refuseFix(operation, ctx, reason)
    await this.#fail({ ...operation, state: 'running' }, ctx, `Corral's own rebase was rejected: ${reason}`)
  }

  // Back to a developer with the reason, on the same candidate, within a bound
  async #refuseFix(operation: OperationRow, { epic, project }: Context, reason: string): Promise<void> {
    const { db } = this.#d
    const attempts = operation.fixAttempts + 1
    await db.transaction(async (tx) => {
      await tx.update(operations).set({ fixReport: null, fixAttempts: attempts, fixBrief: refusedBrief(operation.fixBrief ?? '', reason), updatedAt: this.#now() }).where(eq(operations.id, operation.id))
      await appendAudit(tx, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId: epic.id, event: 'fix_refused', fix: operation.fix!, operationId: operation.id, summary: reason }))
      if (attempts >= MAX_FAILED_ATTEMPTS) await recordSyncFailure(tx, project, epic.id, `Corral refused the candidate ${attempts} times: ${reason}`, this.#now())
    })
    await this.#publishEpic(epic.id)
    this.#d.wake([])
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
    if (head !== operation.expectedTargetSha) return this.#fail(operation, ctx, endingText('targetMoved'))
    const error = operation.error ?? 'The push did not reach the task\'s branch'
    if (!operation.fix) return this.#fail(operation, ctx, error)
    // A reported fix is worth keeping: push it again, within a bound
    await db.update(operations).set({ state: 'running', updatedAt: this.#now() }).where(eq(operations.id, operation.id))
    if (operation.pushAttempts < MAX_FAILED_ATTEMPTS) return false
    await recordSyncFailure(db, project, epic.id, error, this.#now())
    await this.#publishEpic(epic.id)
    return false
  }

  // Nothing else could publish a fix's candidate. The next checkpoint, or the
  // next look at CI, starts again from the branch as it is.
  async #retireFix(operation: OperationRow, { epic, project }: Context, reason: string): Promise<void> {
    const { db, github } = this.#d
    await db.transaction(tx => endActiveRuns(tx, eq(runs.operationId, operation.id), { state: 'interrupted', error: reason }, this.#now()))
    await github.deleteBranch(project.repository, epicResolutionBranch(operation.id)).catch(error => console.error(`Could not delete the fix candidate of ${epic.id}`, error))
  }

  async #complete(operation: OperationRow, { epic, project }: Context, commitSha: string): Promise<void> {
    const { db, github } = this.#d
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(epics).where(eq(epics.id, epic.id)).for('update')
      const done = await moveOperation(tx, operation, ACTIVE_OPERATION_STATES, { state: 'succeeded', resultHeadSha: commitSha, error: null, updatedAt: this.#now() })
      if (!done) return
      // Checks and the merge gate read the new head, so keeping approval never
      // skips them. Losing it sends the epic back through the reconcile pass.
      const fate = approvalFate(done, locked!, commitSha)
      // A CI or review fix doesn't move the epic on the target
      const onto = done.fix && done.fix !== 'conflict' ? locked!.approvedBaseSha : operation.ontoSha
      const reviewFix = done.fix === 'review'
      const approval = fate?.kept
        ? { prHeadSha: commitSha, approvedBaseSha: onto }
        : fate || reviewFix ? { reviewState: 'open' as const, approvedHeadSha: null, approvedBaseSha: null } : {}
      await tx.update(epics).set({ syncError: null, ...approval, updatedAt: this.#now() }).where(eq(epics.id, epic.id))
      await appendAudit(tx, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', done.fix && done.fix !== 'conflict'
        ? { epicId: epic.id, event: 'fix_published', fix: done.fix, operationId: done.id, from: operation.expectedTargetSha, to: commitSha }
        : { epicId: epic.id, event: 'rebased', from: operation.expectedTargetSha, to: commitSha }))
      if (done.fixReport && commitSha !== operation.expectedTargetSha) await tx.update(runs).set({ reReviewed: reviewFix || (fate ? !fate.kept : null) }).where(eq(runs.id, done.fixReport.runId))
      if (fate) await appendAudit(tx, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId: epic.id, ...approvalChange(done, locked!, commitSha, fate) }))
    })
    await this.#publishEpic(epic.id)
    if (operation.fix) await github.deleteBranch(project.repository, epicResolutionBranch(operation.id)).catch(error => console.error(`Could not delete the rebase candidate of ${epic.id}`, error))
  }

  // True: look at the epic again now. Other endings wait for a later pass, and
  // enough of them on the same commits stop until a human retries.
  async #fail(operation: OperationRow, { epic, project }: Context, error: string): Promise<boolean> {
    const { db } = this.#d
    await moveOperation(db, operation, ACTIVE_OPERATION_STATES, { state: 'failed', error, updatedAt: this.#now() })
    await appendAudit(db, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId: epic.id, event: 'rebase_failed', summary: error }))
    if (operation.fix) await this.#retireFix(operation, { epic, project }, error)
    const retry = endedBy(error, ...RETRY_AT_ONCE)
    const failures = retry ? [] : await this.#failures(db, epic, operation.expectedTargetSha, operation.ontoSha!)
    if (failures.length >= MAX_FAILED_ATTEMPTS) await recordSyncFailure(db, project, epic.id, `Rebasing onto ${project.defaultBranch} failed ${failures.length} times: ${error}`, this.#now())
    await this.#publishEpic(epic.id)
    return retry
  }

  async #publishEpic(epicId: string): Promise<void> {
    await publishEpic(this.#d.db, this.#d.events, epicId)
  }
}

// Cleared to merge, on the head that was cleared: the last rebase this epic
// needs, so a conflict is worth a developer's run now. Any other head is about
// to lose approval.
const finalCheckpoint = (epic: EpicRow, head: string) => epic.reviewState === 'ready_to_merge' && epic.prHeadSha === head
