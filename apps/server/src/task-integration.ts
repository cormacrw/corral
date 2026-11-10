import { ACTIVE_OPERATION_STATES, errorText, SERVER_ACTOR, taskRef } from '@corral/core'
import { schema, type EpicRow, type Executor, type OperationRow, type ProjectRow, type SubmissionRow, type TaskRow } from '@corral/db'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { checkRows } from './checks.ts'
import type { EpicSynchronizer } from './epic-sync.ts'
import { activeOperation, beginOperation, countsAsFailure, endedBy, endingText, moveOperation, runnerUnavailable, type BranchWriterDeps, type OperationEnding } from './operations.ts'
import { lockTask } from './task-rows.ts'
import { applyTransition, recordTaskMerged } from './tasks.ts'
import { ciFailed, settleTask, type ServerChange } from './task-settle.ts'
import { addCommentWithTransition } from './comments.ts'

const { epics, projects, taskIntegrationOperations: operations, taskSubmissions: submissions, tasks } = schema

// Endings that say nothing against the submission: these retry at once, and
// anything else counts towards MAX_FAILED_OPERATIONS
const RETRIES: OperationEnding[] = ['targetMoved', 'interrupted', 'cancelled']
const MAX_FAILED_OPERATIONS = 3
// Fresh operations one epic may go through in a pass, when its branch keeps moving
const MAX_OPERATIONS_PER_PASS = 5

// A required check that hasn't appeared on the candidate by now doesn't run on
// such a commit (a PR-only workflow, say), and is left to the epic PR's merge gate
const CHECK_APPEAR_MS = 3 * 60_000
const CHECK_FINISH_MS = 60 * 60_000

interface IntegrationDeps extends BranchWriterDeps {
  // Rebases the epic branch between integrations, at its checkpoint
  sync: Pick<EpicSynchronizer, 'due' | 'begin' | 'step'>
  // Told about every task whose status this changed
  settled: (taskId: string) => Promise<void>
}

// Whether the kill switch or the update hold is on right now

// Moves approved PR-free tasks onto their epic branch (D27, flows.md section 4),
// one at a time per epic. Every step is journaled in task_integration_operations
// first, so each tick can work out where an operation had got to from the
// database and the remote alone: a restart loses nothing. The runner does the
// git work and the server decides. The push is a compare-and-swap on the expected
// epic head, and a task becomes Merged only from a fresh read of the remote.
export class TaskIntegrator {
  #d: IntegrationDeps
  #busy = new Set<string>()
  // Operations whose candidate is waiting on CI or a pause, neither of which
  // needs a remote read. The push's compare-and-swap catches a branch that moved.
  #awaitingChecks = new Set<string>()

  constructor(deps: IntegrationDeps) {
    this.#d = deps
  }

  #now(): Date {
    return this.#d.now()
  }

  get inFlight(): number {
    return this.#busy.size
  }

  async tick(): Promise<void> {
    const { db } = this.#d
    if (!this.#d.runner.integrationRunner() && !this.#d.runner.epicRebaseRunner()) return
    const active = await db.select({ epicId: operations.epicId }).from(operations).where(inArray(operations.state, [...ACTIVE_OPERATION_STATES]))
    const waiting = await this.#waiting().then(rows => rows.map(r => ({ epicId: r.task.epicId! })))
    const due = await this.#d.sync.due().then(ids => ids.map(epicId => ({ epicId })))
    for (const epicId of new Set([...active, ...waiting, ...due].map(r => r.epicId))) {
      if (this.#d.gate.halted) return
      if (this.#busy.has(epicId)) continue
      this.#busy.add(epicId)
      try {
        await this.#advance(epicId)
      } catch (error) {
        console.error(`Integration for epic ${epicId} failed`, error)
      } finally {
        this.#busy.delete(epicId)
      }
    }
  }

  // Oldest first, so tasks join the epic branch in the order they became ready
  #waiting(epicId?: string) {
    return this.#d.db.select({ task: tasks, project: projects, epic: epics }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(epics, eq(epics.id, tasks.epicId))
      .where(and(eq(tasks.status, 'ready_to_merge'), gt(tasks.integrationProtocol, 0), isNull(tasks.prNumber), isNotNull(tasks.epicId), isNull(tasks.leaseRunId), isNull(tasks.deletedAt), eq(tasks.paused, false), eq(projects.paused, false), epicId ? eq(tasks.epicId, epicId) : undefined))
      .orderBy(asc(tasks.updatedAt), asc(tasks.id))
  }

  async #advance(epicId: string): Promise<void> {
    for (let n = 0; n < MAX_OPERATIONS_PER_PASS && !this.#d.gate.halted; n++) {
      const active = await activeOperation(this.#d.db, epicId)
      // Between integrations is the epic's checkpoint: nothing else is writing
      const rebase = active?.kind === 'rebase' ? active : active ? null : await this.#d.sync.begin(epicId)
      if (rebase) {
        if (!await this.#d.sync.step(rebase)) return
        continue
      }
      const operation = active ?? await this.#begin(epicId)
      if (!operation || !await this.#step(operation)) return
    }
  }

  // Writes the intent, with the epic head it expects, before any git happens
  async #begin(epicId: string): Promise<OperationRow | null> {
    const { db, github } = this.#d
    for (const { task, project, epic } of await this.#waiting(epicId)) {
      const expected = epic.branch ? await github.branchHead(project.repository, epic.branch) : null
      if (!expected) {
        await this.#settle(task.id, { event: { type: 'block', reason: `The task's branch ${epic.branch ?? '(none)'} doesn't exist, so this task can't be integrated` }, detail: { event: 'merge_failed' } })
        continue
      }
      const operation = await db.transaction(async (tx) => {
        const locked = await lockTask(tx, task.id)
        if (locked.task.status !== 'ready_to_merge' || locked.task.leaseRunId) return null
        const [submission] = await tx.select().from(submissions).where(eq(submissions.taskId, task.id)).orderBy(desc(submissions.sequence)).limit(1)
        // Approval binds to one commit: anything else goes back for review
        if (!submission || submission.agentApprovedHeadSha !== locked.task.headSha) {
          await applyTransition(tx, locked.task, locked.project, { type: 'head_moved' }, SERVER_ACTOR, { event: 'head_moved', headSha: locked.task.headSha ?? '' })
          return null
        }
        const created = await beginOperation(tx, { submissionId: submission.id, epicId, kind: 'integrate', expectedTargetSha: expected })
        if (created) await this.#audit(tx, created, locked.task.id, project.id, 'started')
        return created
      })
      if (operation) return operation
    }
    return null
  }

  async #audit(tx: Executor, operation: OperationRow, taskId: string, projectId: string, event: 'started' | 'succeeded' | 'failed' | 'checks_deferred', extra: { commitSha?: string, error?: string } = {}): Promise<void> {
    await appendAudit(tx, { projectId, taskId, actor: SERVER_ACTOR }, auditEvent('integration.operation', {
      operationId: operation.id, submissionId: operation.submissionId!, event, expectedTargetSha: operation.expectedTargetSha, leaseEpoch: operation.leaseEpoch, ...extra
    }))
  }

  async #context(operation: OperationRow) {
    const [row] = await this.#d.db.select({ submission: submissions, task: tasks, project: projects, epic: epics }).from(submissions)
      .innerJoin(tasks, eq(tasks.id, submissions.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(epics, eq(epics.id, operation.epicId))
      .where(eq(submissions.id, operation.submissionId!))
    return row!
  }

  // One step of the operation. True when the epic should be looked at again now.
  async #step(operation: OperationRow): Promise<boolean> {
    const ctx = await this.#context(operation)
    if (operation.state === 'pending') return this.#prepare(operation, ctx)
    if (operation.state === 'running' && this.#awaitingChecks.has(operation.id)) return this.#gate(operation, ctx)
    return this.#reconcile(operation, ctx)
  }

  async #prepare(pending: OperationRow, ctx: Context): Promise<boolean> {
    const { db, runner } = this.#d
    const { submission, task, project, epic } = ctx
    if (this.#d.gate.halted) return false
    if (task.status !== 'ready_to_merge' || task.deletedAt) return this.#fail(pending, ctx, endingText('cancelled'))
    if (task.paused || project.paused) return false
    const runnerId = runner.integrationRunner()
    if (!runnerId) return false
    const operation = await moveOperation(db, pending, ['pending'], { state: 'running', runnerId, updatedAt: this.#now() })
    if (!operation) return false
    let prepared
    try {
      prepared = await runner.requestOn<'integration_prepare'>(runnerId, {
        kind: 'integration_prepare', repository: project.repository, targetBranch: epic.branch!, expectedTargetSha: operation.expectedTargetSha,
        submissionId: submission.id, headSha: submission.agentApprovedHeadSha!, baseSha: submission.baseSha,
        message: `${taskRef(project.prefix, task.number)}: ${task.title}\n\nCorral-Submission: ${submission.id}\n`,
        committedAt: operation.createdAt.toISOString(),
        candidateRef: project.requiredChecks.length > 0 ? candidateRef(operation) : null
      })
    } catch (error) {
      return this.#fail(operation, ctx, runnerUnavailable(errorText(error)))
    }
    switch (prepared.status) {
      case 'integrated':
        await this.#complete(operation, ctx, prepared.commitSha!)
        return true
      case 'moved':
        return this.#fail(operation, ctx, endingText('targetMoved'))
      case 'failed':
        return this.#fail(operation, ctx, `Could not build a candidate: ${prepared.error ?? 'unknown error'}`)
      case 'conflict':
        await this.#fail(operation, ctx, `Conflicts with the task's branch: ${prepared.files.join(', ')}`)
        await this.#settle(task.id, { event: { type: 'base_conflict', approvedHeadSha: task.headSha! }, detail: { event: 'base_conflict' },
          comment: `The task's branch \`${epic.branch}\` has moved and this work no longer applies to it cleanly${prepared.files.length ? `: ${prepared.files.map(f => `\`${f}\``).join(', ')}` : ''}. Rebase onto \`origin/${epic.branch}\`, resolve the conflicts, and report commit_submitted.` })
        return true
      case 'empty':
        await this.#fail(operation, ctx, 'The change is already on the task\'s branch')
        await this.#settle(task.id, { event: { type: 'ci_failed' }, detail: { event: 'ci_failed', checks: [] },
          comment: `Applied to the task's branch \`${epic.branch}\`, this submission changes nothing, so there is nothing to integrate. Check it against \`origin/${epic.branch}\` and report commit_submitted.` })
        return true
      case 'prepared': {
        const [ready] = await db.update(operations).set({ resultHeadSha: prepared.commitSha, updatedAt: this.#now() }).where(eq(operations.id, operation.id)).returning()
        // Preparing can take minutes: the gate needs the task as it is now
        return this.#gate(ready!, await this.#context(ready!))
      }
    }
  }

  // The last look before the shared branch moves: the task is still approved
  // for this submission, and the exact candidate has passed what it can be
  // checked by. Required checks that only run on the epic PR stay at its merge.
  // The kill switch and the update hold are read at each step here, because any
  // wait can outlast them. A stopped operation stays running, to resume as it was.
  async #gate(operation: OperationRow, ctx: Context): Promise<boolean> {
    const { db, runner } = this.#d
    const { submission, task, project, epic } = ctx
    if (this.#d.gate.halted) return false
    if (task.status !== 'ready_to_merge' || task.deletedAt || task.headSha !== submission.agentApprovedHeadSha) return this.#fail(operation, ctx, endingText('cancelled'))
    // Nothing shared moves while paused; the operation carries on afterwards
    if (task.paused || project.paused) {
      this.#awaitingChecks.add(operation.id)
      return false
    }
    const verdict = await this.#checks(project, operation)
    if (verdict.state === 'waiting') {
      this.#awaitingChecks.add(operation.id)
      return false
    }
    if (this.#d.gate.halted) return false
    this.#awaitingChecks.delete(operation.id)
    if (verdict.state === 'failed') {
      await this.#fail(operation, ctx, `Required checks failed on candidate ${operation.resultHeadSha}: ${verdict.checks.map(c => c.name).join(', ')}`)
      await this.#settle(task.id, await ciFailed(db, task.id, verdict.checks, task.headSha, 'CI failed on this task\'s work applied to the task\'s branch, which has not moved. Fix it and report commit_submitted.'))
      return true
    }
    if (verdict.state === 'timed_out') {
      const reason = `Required checks never finished on candidate ${operation.resultHeadSha}: ${verdict.checks.map(c => c.name).join(', ')}`
      await this.#fail(operation, ctx, reason)
      await this.#settle(task.id, { event: { type: 'block', reason }, detail: { event: 'merge_failed' } })
      return true
    }
    if (verdict.deferred.length > 0) await this.#audit(db, operation, task.id, project.id, 'checks_deferred', { error: verdict.deferred.join(', ') })
    // From here the result is unknown until the remote has been read
    const pushing = await moveOperation(db, operation, ['running'], { state: 'reconciling', updatedAt: this.#now() })
    if (!pushing) return false
    // Nothing was sent, so this isn't an unknown result. The original time keeps
    // the age of its checks.
    if (this.#d.gate.halted) {
      await moveOperation(db, operation, ['reconciling'], { state: 'running', updatedAt: operation.updatedAt })
      return false
    }
    let error: string | null
    try {
      error = (await runner.requestOn<'integration_push'>(operation.runnerId!, {
        kind: 'integration_push', repository: project.repository, targetBranch: epic.branch!, expectedTargetSha: operation.expectedTargetSha, candidateSha: operation.resultHeadSha!
      })).error
    } catch (failure) {
      error = runnerUnavailable(errorText(failure))
    }
    if (error) await db.update(operations).set({ error }).where(eq(operations.id, operation.id))
    return true
  }

  async #checks(project: ProjectRow, operation: OperationRow): Promise<CheckVerdict> {
    const required = project.requiredChecks
    if (required.length === 0) return { state: 'passed', deferred: [] }
    // A read that fails is tried again on a later pass, like a check still running
    const found = await this.#d.github.checks(project.repository, operation.resultHeadSha!).catch(() => null)
    if (!found) return { state: 'waiting' }
    const rows = checkRows(required, found)
    const failed = rows.filter(c => c.conclusion === 'failure')
    if (failed.length > 0) return { state: 'failed', checks: failed }
    const age = this.#now().getTime() - operation.updatedAt.getTime()
    const pending = rows.filter(c => c.conclusion === 'pending')
    if (pending.length > 0) return age >= CHECK_FINISH_MS ? { state: 'timed_out', checks: pending } : { state: 'waiting' }
    const deferred = rows.filter(c => c.conclusion === 'missing').map(c => c.name)
    return deferred.length > 0 && age < CHECK_APPEAR_MS ? { state: 'waiting' } : { state: 'passed', deferred }
  }

  // Nothing is assumed about an operation found part-way, or one whose push
  // has an unknown result: the remote says what happened. A failed read leaves
  // it as it is for the next pass.
  async #reconcile(operation: OperationRow, ctx: Context): Promise<boolean> {
    const { runner } = this.#d
    const runnerId = runner.integrationRunner()
    if (!runnerId) return false
    let remote
    try {
      remote = await runner.requestOn<'integration_inspect'>(runnerId, { kind: 'integration_inspect', repository: ctx.project.repository, targetBranch: ctx.epic.branch!, submissionId: ctx.submission.id })
    } catch (error) {
      console.error(`Could not read the epic branch for integration ${operation.id}`, error)
      return false
    }
    if (remote.integratedSha) {
      await this.#complete(operation, ctx, remote.integratedSha)
      return true
    }
    if (remote.targetSha !== operation.expectedTargetSha) return this.#fail(operation, ctx, endingText('targetMoved'))
    if (operation.state === 'reconciling') return this.#fail(operation, ctx, operation.error ?? 'The push did not reach the task\'s branch')
    // Found running after a restart, with the branch where it was left
    if (operation.resultHeadSha && operation.runnerId && runner.isOnline(operation.runnerId)) return this.#gate(operation, ctx)
    return this.#fail(operation, ctx, endingText('interrupted'))
  }

  // The operation, the submission's integrated commit and Merged commit together
  async #complete(operation: OperationRow, ctx: Context, commitSha: string): Promise<void> {
    const { db } = this.#d
    const { submission, task, project } = ctx
    await db.transaction(async (tx) => {
      // Not lockTask: a deleted task's commit is on the branch all the same
      const [current] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for('update')
      const done = await moveOperation(tx, operation, ACTIVE_OPERATION_STATES, { state: 'succeeded', resultHeadSha: commitSha, error: null, updatedAt: this.#now() })
      if (!done) return
      await tx.update(submissions).set({ integratedCommitSha: commitSha, integratedAt: this.#now() }).where(eq(submissions.id, submission.id))
      await this.#audit(tx, operation, task.id, project.id, 'succeeded', { commitSha })
      if (current!.status === 'ready_to_merge' && !current!.deletedAt) {
        await recordTaskMerged(tx, { task: current!, project }, { type: 'integrated', confirmedOnEpicBranch: true }, { event: 'integrated', submissionId: submission.id, integratedCommitSha: commitSha }, { commitSha, at: this.#now() })
      } else {
        // Sent back while its push was landing: the commit stands, and the task stays open
        await addCommentWithTransition(tx, task.id, { body: `This submission reached the task's branch as ${commitSha} just as the task left Ready to merge. The task stays open; base any further work on \`origin/${submission.targetBranch}\`.` }, SERVER_ACTOR)
      }
    })
    await this.#finish(operation, ctx)
    await this.#d.settled(task.id)
  }

  // Ends an operation that didn't integrate. True: look at the epic again now,
  // for an ending that retries at once. Any other waits for a later pass, so one
  // bad moment can't use up every attempt. A submission that keeps failing for
  // its own reasons goes to a human.
  async #fail(operation: OperationRow, ctx: Context, error: string): Promise<boolean> {
    const { db } = this.#d
    const { submission, task, project } = ctx
    await db.transaction(async (tx) => {
      const failed = await moveOperation(tx, operation, ACTIVE_OPERATION_STATES, { state: 'failed', error, updatedAt: this.#now() })
      if (failed) await this.#audit(tx, operation, task.id, project.id, 'failed', { error })
    })
    await this.#finish(operation, ctx)
    const counted = await db.select({ id: operations.id }).from(operations)
      .where(and(eq(operations.submissionId, submission.id), eq(operations.state, 'failed'), countsAsFailure(RETRIES)))
    if (counted.length >= MAX_FAILED_OPERATIONS) {
      await this.#settle(task.id, { event: { type: 'fail', reason: `Integration failed ${counted.length} times: ${error}` }, detail: { event: 'merge_failed' }, cap: true })
    }
    return endedBy(error, ...RETRIES)
  }

  async #finish(operation: OperationRow, ctx: Context): Promise<void> {
    this.#awaitingChecks.delete(operation.id)
    if (ctx.project.requiredChecks.length === 0) return
    await this.#d.github.deleteBranch(ctx.project.repository, candidateRef(operation)).catch(error => console.error(`Could not delete ${candidateRef(operation)}`, error))
  }

  async #settle(taskId: string, change: ServerChange): Promise<void> {
    if (await settleTask(this.#d.db, taskId, change)) await this.#d.settled(taskId)
  }
}

type Context = { submission: SubmissionRow, task: TaskRow, project: ProjectRow, epic: EpicRow }

type CheckVerdict =
  | { state: 'waiting' }
  | { state: 'passed', deferred: string[] }
  | { state: 'failed', checks: ReturnType<typeof checkRows> }
  | { state: 'timed_out', checks: ReturnType<typeof checkRows> }

// Where CI sees a candidate. The operation's ID keeps a retry off an older run.
const candidateRef = (operation: OperationRow) => `corral/candidates/${operation.id}`
