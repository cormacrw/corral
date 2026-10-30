import { taskRef, type Actor } from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, desc, eq, inArray, isNotNull, isNull, gt, notInArray } from 'drizzle-orm'
import { appendAudit, auditEvent, type TransitionDetail } from './audit.ts'
import type { EventBus } from './events.ts'
import type { CheckResult, GitHubClient } from './github.ts'
import type { RunnerHub } from './runner-hub.ts'
import { applyTransition, lockTask, type ProjectRow } from './tasks.ts'

const { comments, epics, projects, taskIntegrationOperations: operations, taskSubmissions: submissions, tasks } = schema
type OperationRow = typeof operations.$inferSelect
type SubmissionRow = typeof submissions.$inferSelect
type EpicRow = typeof epics.$inferSelect

const server: Actor = { kind: 'system', component: 'server' }
const ACTIVE = ['pending', 'running', 'reconciling'] as const

// Why an operation ended, when that says nothing against the submission: these
// retry freely, and anything else counts towards MAX_FAILED_OPERATIONS
const TARGET_MOVED = 'The epic branch moved'
const INTERRUPTED = 'Interrupted before a candidate was ready'
const CANCELLED = 'The task left Ready to merge'
const MAX_FAILED_OPERATIONS = 3
// Fresh operations one epic may go through in a pass, when its branch keeps moving
const MAX_OPERATIONS_PER_PASS = 5

const PREPARE_TIMEOUT_MS = 12 * 60_000
const PUSH_TIMEOUT_MS = 3 * 60_000
const INSPECT_TIMEOUT_MS = 11 * 60_000
// A required check that hasn't appeared on the candidate by now doesn't run on
// such a commit (a PR-only workflow, say), and is left to the epic PR's merge gate
const CHECK_APPEAR_MS = 3 * 60_000
const CHECK_FINISH_MS = 60 * 60_000

export interface IntegrationDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  runner: RunnerHub
  now?: () => Date
}

// `settled` is told about every task whose status this changed
type Settled = (taskId: string) => Promise<void>

// Moves approved PR-free tasks onto their epic branch (D27, flows.md section 4),
// one at a time per epic. Every step is journaled in task_integration_operations
// first, so each tick can work out where an operation had got to from the
// database and the remote alone: a restart loses nothing. The runner does the
// git work and the server decides. The push is a compare-and-swap on the expected
// epic head, and a task becomes Merged only from a fresh read of the remote.
export class TaskIntegrator {
  #d: IntegrationDeps
  #settled: Settled
  #busy = new Set<string>()
  // Operations whose candidate is waiting on CI, which needs no remote read
  #awaitingChecks = new Set<string>()

  constructor(deps: IntegrationDeps, settled: Settled) {
    this.#d = deps
    this.#settled = settled
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date()
  }

  get inFlight(): number {
    return this.#busy.size
  }

  async tick(stopped: () => boolean): Promise<void> {
    const { db } = this.#d
    if (!this.#d.runner.integrationRunner()) return
    const active = await db.select({ epicId: operations.epicId }).from(operations).where(inArray(operations.state, [...ACTIVE]))
    const waiting = await this.#waiting().then(rows => rows.map(r => ({ epicId: r.task.epicId! })))
    for (const epicId of new Set([...active, ...waiting].map(r => r.epicId))) {
      if (stopped()) return
      if (this.#busy.has(epicId)) continue
      this.#busy.add(epicId)
      try {
        await this.#advance(epicId, stopped)
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

  async #advance(epicId: string, stopped: () => boolean): Promise<void> {
    for (let n = 0; n < MAX_OPERATIONS_PER_PASS && !stopped(); n++) {
      const [active] = await this.#d.db.select().from(operations).where(and(eq(operations.epicId, epicId), inArray(operations.state, [...ACTIVE])))
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
        await this.#transition(task.id, { type: 'block', reason: `Epic branch ${epic.branch ?? '(none)'} doesn't exist, so this task can't be integrated` }, { event: 'merge_failed' })
        continue
      }
      const operation = await db.transaction(async (tx) => {
        const locked = await lockTask(tx, task.id)
        if (locked.task.status !== 'ready_to_merge' || locked.task.leaseRunId) return null
        const [submission] = await tx.select().from(submissions).where(eq(submissions.taskId, task.id)).orderBy(desc(submissions.sequence)).limit(1)
        // Approval binds to one commit: anything else goes back for review
        if (!submission || submission.agentApprovedHeadSha !== locked.task.headSha) {
          await applyTransition(tx, locked.task, locked.project, { type: 'head_moved' }, server, { event: 'head_moved', headSha: locked.task.headSha ?? '' })
          return null
        }
        const [last] = await tx.select({ leaseEpoch: operations.leaseEpoch }).from(operations).where(eq(operations.epicId, epicId)).orderBy(desc(operations.leaseEpoch)).limit(1)
        const [created] = await tx.insert(operations).values({ submissionId: submission.id, epicId, kind: 'integrate', expectedTargetSha: expected, leaseEpoch: (last?.leaseEpoch ?? 0) + 1 }).onConflictDoNothing().returning()
        if (created) await this.#audit(tx, created, locked.task.id, project.id, 'started')
        return created ?? null
      })
      if (operation) return operation
    }
    return null
  }

  async #audit(tx: Executor, operation: OperationRow, taskId: string, projectId: string, event: 'started' | 'succeeded' | 'failed' | 'checks_deferred', extra: { commitSha?: string, error?: string } = {}): Promise<void> {
    await appendAudit(tx, { projectId, taskId, actor: server }, auditEvent('integration.operation', {
      operationId: operation.id, submissionId: operation.submissionId, event, expectedTargetSha: operation.expectedTargetSha, leaseEpoch: operation.leaseEpoch, ...extra
    }))
  }

  async #context(operation: OperationRow) {
    const [row] = await this.#d.db.select({ submission: submissions, task: tasks, project: projects, epic: epics }).from(submissions)
      .innerJoin(tasks, eq(tasks.id, submissions.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(epics, eq(epics.id, operation.epicId))
      .where(eq(submissions.id, operation.submissionId))
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
    if (task.status !== 'ready_to_merge' || task.deletedAt) return this.#fail(pending, ctx, CANCELLED)
    const runnerId = runner.integrationRunner()
    if (!runnerId) return false
    const [operation] = await db.update(operations).set({ state: 'running', runnerId, updatedAt: this.#now() })
      .where(and(eq(operations.id, pending.id), eq(operations.state, 'pending'), eq(operations.leaseEpoch, pending.leaseEpoch))).returning()
    if (!operation) return false
    let prepared
    try {
      prepared = await runner.requestOn<'integration_prepare'>(runnerId, {
        kind: 'integration_prepare', repository: project.repository, targetBranch: epic.branch!, expectedTargetSha: operation.expectedTargetSha,
        submissionId: submission.id, headSha: submission.agentApprovedHeadSha!, baseSha: submission.baseSha,
        message: `${taskRef(project.prefix, task.number)}: ${task.title}\n\nCorral-Submission: ${submission.id}\n`,
        committedAt: operation.createdAt.toISOString(),
        candidateRef: project.requiredChecks.length > 0 ? candidateRef(operation) : null
      }, PREPARE_TIMEOUT_MS)
    } catch (error) {
      return this.#fail(operation, ctx, `Could not prepare the integration: ${message(error)}`)
    }
    switch (prepared.status) {
      case 'integrated':
        await this.#complete(operation, ctx, prepared.commitSha!)
        return true
      case 'moved':
        return this.#fail(operation, ctx, TARGET_MOVED)
      case 'conflict':
        await this.#fail(operation, ctx, `Conflicts with the epic branch: ${prepared.files.join(', ')}`)
        await this.#transition(task.id, { type: 'base_conflict', approvedHeadSha: task.headSha! }, { event: 'base_conflict' },
          `The epic branch \`${epic.branch}\` has moved and this work no longer applies to it cleanly${prepared.files.length ? `: ${prepared.files.map(f => `\`${f}\``).join(', ')}` : ''}. Rebase onto \`origin/${epic.branch}\`, resolve the conflicts, and report commit_submitted.`)
        return true
      case 'empty':
        await this.#fail(operation, ctx, 'The change is already on the epic branch')
        await this.#transition(task.id, { type: 'ci_failed' }, { event: 'ci_failed', checks: [] },
          `Applied to the epic branch \`${epic.branch}\`, this submission changes nothing, so there is nothing to integrate. Check it against \`origin/${epic.branch}\` and report commit_submitted.`)
        return true
      case 'prepared': {
        const [ready] = await db.update(operations).set({ resultHeadSha: prepared.commitSha, updatedAt: this.#now() }).where(eq(operations.id, operation.id)).returning()
        return this.#gate(ready!, ctx)
      }
    }
  }

  // The last look before the shared branch moves: the task is still approved
  // for this submission, and the exact candidate has passed what it can be
  // checked by. Required checks that only run on the epic PR stay at its merge.
  async #gate(operation: OperationRow, ctx: Context): Promise<boolean> {
    const { db, runner } = this.#d
    const { submission, task, project, epic } = ctx
    if (task.status !== 'ready_to_merge' || task.deletedAt || task.headSha !== submission.agentApprovedHeadSha) return this.#fail(operation, ctx, CANCELLED)
    const verdict = await this.#checks(project, operation)
    if (verdict.state === 'waiting') {
      this.#awaitingChecks.add(operation.id)
      return false
    }
    this.#awaitingChecks.delete(operation.id)
    if (verdict.state === 'failed') {
      await this.#fail(operation, ctx, `Required checks failed on candidate ${operation.resultHeadSha}: ${verdict.checks.map(c => c.name).join(', ')}`)
      await this.#transition(task.id, { type: 'ci_failed' }, { event: 'ci_failed', checks: verdict.checks.map(c => c.name) },
        ['CI failed on this task\'s work applied to the epic branch, which has not moved. Fix it and report commit_submitted.', '', ...verdict.checks.map(c => `- ${c.name}: failed${c.url ? ` (${c.url})` : ''}`)].join('\n'))
      return true
    }
    if (verdict.state === 'timed_out') {
      const reason = `Required checks never finished on candidate ${operation.resultHeadSha}: ${verdict.checks.map(c => c.name).join(', ')}`
      await this.#fail(operation, ctx, reason)
      await this.#transition(task.id, { type: 'block', reason }, { event: 'merge_failed' })
      return true
    }
    if (verdict.deferred.length > 0) await this.#audit(db, operation, task.id, project.id, 'checks_deferred', { error: verdict.deferred.join(', ') })
    // From here the result is unknown until the remote has been read
    const [pushing] = await db.update(operations).set({ state: 'reconciling', updatedAt: this.#now() })
      .where(and(eq(operations.id, operation.id), eq(operations.state, 'running'), eq(operations.leaseEpoch, operation.leaseEpoch))).returning()
    if (!pushing) return false
    let error: string | null
    try {
      error = (await runner.requestOn<'integration_push'>(operation.runnerId!, {
        kind: 'integration_push', repository: project.repository, targetBranch: epic.branch!, expectedTargetSha: operation.expectedTargetSha, candidateSha: operation.resultHeadSha!
      }, PUSH_TIMEOUT_MS)).error
    } catch (failure) {
      error = message(failure)
    }
    if (error) await db.update(operations).set({ error }).where(eq(operations.id, operation.id))
    return true
  }

  async #checks(project: ProjectRow, operation: OperationRow): Promise<CheckVerdict> {
    const required = project.requiredChecks
    if (required.length === 0) return { state: 'passed', deferred: [] }
    const found = await this.#d.github.checks(project.repository, operation.resultHeadSha!).catch(() => null)
    if (!found) return { state: 'waiting' }
    const reported = required.map(name => found.find(c => c.name === name)).filter((c): c is CheckResult => c !== undefined)
    const failed = reported.filter(c => c.conclusion === 'failure')
    if (failed.length > 0) return { state: 'failed', checks: failed }
    const age = this.#now().getTime() - operation.updatedAt.getTime()
    const pending = reported.filter(c => c.conclusion === 'pending')
    if (pending.length > 0) return age >= CHECK_FINISH_MS ? { state: 'timed_out', checks: pending } : { state: 'waiting' }
    const deferred = required.filter(name => !reported.some(c => c.name === name))
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
      remote = await runner.requestOn<'integration_inspect'>(runnerId, { kind: 'integration_inspect', repository: ctx.project.repository, targetBranch: ctx.epic.branch!, submissionId: ctx.submission.id }, INSPECT_TIMEOUT_MS)
    } catch (error) {
      console.error(`Could not read the epic branch for integration ${operation.id}`, error)
      return false
    }
    if (remote.integratedSha) {
      await this.#complete(operation, ctx, remote.integratedSha)
      return true
    }
    if (remote.targetSha !== operation.expectedTargetSha) return this.#fail(operation, ctx, TARGET_MOVED)
    if (operation.state === 'reconciling') return this.#fail(operation, ctx, operation.error ?? 'The push did not reach the epic branch')
    // Found running after a restart, with the branch where it was left
    if (operation.resultHeadSha && operation.runnerId && runner.isOnline(operation.runnerId)) return this.#gate(operation, ctx)
    return this.#fail(operation, ctx, INTERRUPTED)
  }

  // The operation, the submission's integrated commit and Merged commit together
  async #complete(operation: OperationRow, ctx: Context, commitSha: string): Promise<void> {
    const { db } = this.#d
    const { submission, task, project } = ctx
    await db.transaction(async (tx) => {
      // Not lockTask: a deleted task's commit is on the branch all the same
      const [current] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for('update')
      const [done] = await tx.update(operations).set({ state: 'succeeded', resultHeadSha: commitSha, error: null, updatedAt: this.#now() })
        .where(and(eq(operations.id, operation.id), inArray(operations.state, [...ACTIVE]), eq(operations.leaseEpoch, operation.leaseEpoch))).returning()
      if (!done) return
      await tx.update(submissions).set({ integratedCommitSha: commitSha, integratedAt: this.#now() }).where(eq(submissions.id, submission.id))
      await this.#audit(tx, operation, task.id, project.id, 'succeeded', { commitSha })
      if (current!.status === 'ready_to_merge' && !current!.deletedAt) {
        await applyTransition(tx, current!, project, { type: 'integrated', confirmedOnEpicBranch: true }, server, { event: 'integrated', submissionId: submission.id, integratedCommitSha: commitSha })
        await tx.update(tasks).set({ mergeCommitSha: commitSha, mergedAt: this.#now(), updatedAt: this.#now() }).where(eq(tasks.id, task.id))
      } else {
        // Sent back while its push was landing: the commit stands, and the task stays open
        await tx.insert(comments).values({ taskId: task.id, author: server, body: `This submission reached the epic branch as ${commitSha} just as the task left Ready to merge. The task stays open; base any further work on \`origin/${submission.targetBranch}\`.` })
      }
    })
    await this.#finish(operation, ctx)
    await this.#settled(task.id)
  }

  // Ends an operation that didn't integrate. True: look at the epic again. A
  // submission that keeps failing for its own reasons goes to a human.
  async #fail(operation: OperationRow, ctx: Context, error: string): Promise<boolean> {
    const { db } = this.#d
    const { submission, task, project } = ctx
    await db.transaction(async (tx) => {
      const [failed] = await tx.update(operations).set({ state: 'failed', error, updatedAt: this.#now() })
        .where(and(eq(operations.id, operation.id), inArray(operations.state, [...ACTIVE]), eq(operations.leaseEpoch, operation.leaseEpoch))).returning()
      if (failed) await this.#audit(tx, operation, task.id, project.id, 'failed', { error })
    })
    await this.#finish(operation, ctx)
    const counted = await db.select({ id: operations.id }).from(operations)
      .where(and(eq(operations.submissionId, submission.id), eq(operations.state, 'failed'), notInArray(operations.error, [TARGET_MOVED, INTERRUPTED, CANCELLED])))
    if (counted.length >= MAX_FAILED_OPERATIONS) {
      await this.#transition(task.id, { type: 'fail', reason: `Integration failed ${counted.length} times: ${error}` }, { event: 'merge_failed' })
    }
    return true
  }

  async #finish(operation: OperationRow, ctx: Context): Promise<void> {
    this.#awaitingChecks.delete(operation.id)
    if (ctx.project.requiredChecks.length === 0) return
    await this.#d.github.deleteBranch(ctx.project.repository, candidateRef(operation)).catch(error => console.error(`Could not delete ${candidateRef(operation)}`, error))
  }

  async #transition(taskId: string, event: Parameters<typeof applyTransition>[3], detail: TransitionDetail, comment?: string): Promise<void> {
    await this.#d.db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, taskId)
      if (task.status !== 'ready_to_merge' || task.leaseRunId) return
      await applyTransition(tx, task, project, event, server, detail)
      if (comment) await tx.insert(comments).values({ taskId, author: server, body: comment })
    })
    await this.#settled(taskId)
  }
}

type Context = { submission: SubmissionRow, task: typeof tasks.$inferSelect, project: ProjectRow, epic: EpicRow }

type CheckVerdict =
  | { state: 'waiting' }
  | { state: 'passed', deferred: string[] }
  | { state: 'failed', checks: CheckResult[] }
  | { state: 'timed_out', checks: CheckResult[] }

// Where CI sees a candidate. The operation's ID keeps a retry off an older run.
const candidateRef = (operation: OperationRow) => `corral/candidates/${operation.id}`

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
