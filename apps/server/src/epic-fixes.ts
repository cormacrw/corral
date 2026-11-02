import type { EpicFixRun, EpicReviewActionInput, OutcomeReport, RunJob } from '@corral/contracts'
import { ACTIVE_RUN_STATES, isActiveRun, LEASE_DURATION_MS, type Actor, type EpicFixCheck, type EpicFixKind } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { MAX_CI_FIXES, readCiFailures } from './ci-output.ts'
import { ACTIVE_OPERATION as ACTIVE, answerOn, openDecision } from './epic-rebase-approval.ts'
import { recordSyncFailure } from './epic-sync.ts'
import { ApiFailure } from './errors.ts'
import { loadEpic } from './epics.ts'
import { epicFixCheckScope, epicFixPrompt } from './prompts.ts'
import { RUN_TIMEOUT_SECONDS, runEndValues } from './run-lifecycle.ts'
import { noteProblem } from './run-outcomes.ts'
import { ToolError, server, type RunContext, type RunCore, type RunRow } from './run-context.ts'
import { epicResolutionBranch } from './task-base.ts'
import type { ProjectRow } from './tasks.ts'

const { agents, epics, projects, runs, taskIntegrationOperations: operations } = schema
type OperationRow = typeof operations.$inferSelect
type EpicRow = typeof epics.$inferSelect

// Developer runs on one operation that come to nothing before a human has to
// retry: failed, interrupted unexpectedly, or refused at the publish check
export const MAX_FIX_ATTEMPTS = 3
// Published CI fixes since the last retry stop at MAX_CI_FIXES, and review fixes
// at the project's review round cap.

const FIX_LABEL: Record<EpicFixKind, string> = { conflict: 'rebase conflict', ci: 'CI failure', review: 'integration review changes' }

const nextEpoch = async (tx: Executor, epicId: string) => {
  const [newest] = await tx.select({ leaseEpoch: operations.leaseEpoch }).from(operations).where(eq(operations.epicId, epicId)).orderBy(desc(operations.leaseEpoch)).limit(1)
  return (newest?.leaseEpoch ?? 0) + 1
}

// Takes the writer lock for a CI or review fix, or null when something else
// holds it. `ontoSha` is the head itself: the candidate builds on it, and any
// rebase comes after, at the next checkpoint. Past the bound the operation
// still opens, stopped, so that Retry has a run to start.
export async function openEpicFix(tx: Executor, project: ProjectRow, epic: EpicRow, input: { fix: 'ci' | 'review', brief: string, headSha: string, checks?: EpicFixCheck[] }, actor: Actor, now: Date): Promise<OperationRow | null> {
  const [created] = await tx.insert(operations).values({ epicId: epic.id, kind: 'rebase', state: 'running', expectedTargetSha: input.headSha, ontoSha: input.headSha, fix: input.fix, fixBrief: input.brief, fixChecks: input.checks ?? null, leaseEpoch: await nextEpoch(tx, epic.id) }).onConflictDoNothing().returning()
  if (!created) return null
  await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId: epic.id, event: 'fix_started', fix: input.fix, operationId: created.id, summary: input.brief }))
  const [done] = await tx.select({ n: count() }).from(operations).where(and(eq(operations.epicId, epic.id), eq(operations.fix, input.fix), eq(operations.state, 'succeeded'), epic.syncRetriedAt ? gte(operations.createdAt, epic.syncRetriedAt) : undefined))
  const bound = input.fix === 'ci' ? MAX_CI_FIXES : project.reviewRoundCap
  if (done!.n >= bound) await recordSyncFailure(tx, project, epic.id, `${done!.n} fixes for ${FIX_LABEL[input.fix]} have been published and it's still failing. The last: ${input.brief}`, now)
  return created
}

// The developer's runs on an epic, newest first
export async function epicFixRuns(db: Executor, epicId: string): Promise<EpicFixRun[]> {
  const rows = await db.select({ run: runs, developer: agents.name, reason: operations.fixBrief }).from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId)).leftJoin(operations, eq(operations.id, runs.operationId))
    .where(and(eq(runs.epicId, epicId), eq(runs.role, 'developer'), isNotNull(runs.endedAt))).orderBy(desc(runs.number))
  return rows.map(({ run, developer, reason }) => ({
    runId: run.id, runNumber: run.number, fix: run.fixKind ?? 'conflict', developer, reason: reason ?? '', state: run.state, outcome: run.outcome,
    summary: run.summary ?? run.error, behaviourChanged: run.behaviourChanged, reReviewed: run.reReviewed, at: run.endedAt!.toISOString()
  }))
}

// Developer runs on an epic, with no task (D29). The operation they belong to
// holds the writer lock from before the first run until a candidate is
// published, so polls and reconnects find the same operation and at most one
// run; publishing stays with the synchronizer.
export class EpicFixes {
  #c: RunCore

  constructor(core: RunCore) {
    this.#c = core
  }

  // A claim, like an integration review's: nothing is sent yet
  async claim(agentId: string, place: (tx: Executor) => Promise<string | null>, skip: readonly string[] = []): Promise<string | null> {
    const now = this.#c.now()
    const closed = await this.#closedPrs()
    return this.#c.d.db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
      if (!agent || agent.role !== 'developer' || agent.paused || (agent.pausedUntil && agent.pausedUntil > now)) return null
      const [active] = await tx.select({ n: count() }).from(runs).where(and(eq(runs.agentId, agent.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      if (active!.n >= agent.concurrency) return null
      const candidates = await tx.select({ operation: operations, project: projects }).from(operations)
        .innerJoin(epics, eq(epics.id, operations.epicId)).innerJoin(projects, eq(projects.id, epics.projectId))
        .where(and(isNotNull(operations.fix), eq(operations.state, 'running'), isNull(operations.fixReport), isNull(epics.syncError), eq(projects.paused, false)))
        .orderBy(asc(operations.createdAt)).for('update', { of: operations, skipLocked: true })
      for (const { operation, project } of candidates) {
        if (openDecision(operation) || closed.has(operation.epicId) || skip.includes(operation.epicId)) continue
        const [live] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.epicId, operation.epicId), inArray(runs.state, [...ACTIVE_RUN_STATES]))).limit(1)
        if (live) continue
        const runnerId = await place(tx)
        if (!runnerId) return null
        const [run] = await tx.insert(runs).values({ projectId: project.id, epicId: operation.epicId, operationId: operation.id, fixKind: operation.fix, agentId, role: 'developer', runnerId, leaseEpoch: 1, leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS), headSha: operation.expectedTargetSha, queuedAt: now }).returning()
        return run!.id
      }
      return null
    })
  }

  // Epics waiting on a fix whose PR isn't open: a run there could never publish.
  // Read before the claim's transaction, and an unread PR counts until a later pass.
  async #closedPrs(): Promise<Set<string>> {
    const { db, github } = this.#c.d
    const waiting = await db.select({ epicId: epics.id, prNumber: epics.prNumber, repository: projects.repository }).from(operations)
      .innerJoin(epics, eq(epics.id, operations.epicId)).innerJoin(projects, eq(projects.id, epics.projectId))
      .where(and(isNotNull(operations.fix), eq(operations.state, 'running'), isNull(operations.fixReport), isNull(epics.syncError), isNotNull(epics.prNumber)))
    const closed = new Set<string>()
    await Promise.all(waiting.map(async ({ epicId, prNumber, repository }) => {
      const pr = await github.getPullRequest(repository, prNumber!).catch(() => null)
      if (!pr || pr.state !== 'open' || pr.merged) closed.add(epicId)
    }))
    return closed
  }

  // The candidate branch, once: a run after a refused publish carries on from it
  async job(ctx: RunContext): Promise<RunJob> {
    const { db, github } = this.#c.d
    const { run, agent } = ctx
    const project = ctx.project!
    const [row] = await db.select({ operation: operations, epic: epics }).from(operations).innerJoin(epics, eq(epics.id, operations.epicId)).where(eq(operations.id, run.operationId!))
    if (!row) throw new Error('The fix\'s operation is gone')
    const { operation, epic } = row
    const branch = epicResolutionBranch(operation.id)
    await github.createBranch(project.repository, branch, operation.expectedTargetSha)
    // A runner's kept worktree may predate a run on another runner
    const continueFrom = await github.branchHead(project.repository, branch) ?? null
    const failures = operation.fixChecks?.length ? await readCiFailures(github, project.repository, operation.fixChecks) : []
    await db.update(runs).set({ sessionStart: 'fresh' }).where(eq(runs.id, run.id))
    return {
      runId: run.id, runNumber: run.number, leaseEpoch: run.leaseEpoch!, role: 'developer', runtime: agent.runtime,
      projectId: project.id, repository: project.repository, defaultBranch: project.defaultBranch, baseBranch: project.defaultBranch,
      taskId: null, taskRef: null, epicId: epic.id, branch, headSha: operation.expectedTargetSha, continueFrom,
      checkScope: epicFixCheckScope(operation.fix!, project.requiredChecks),
      planSessionId: null, agentSessionId: null, fallbackPrompt: null, model: null, timeoutSeconds: RUN_TIMEOUT_SECONDS,
      prompt: epicFixPrompt({
        agentName: agent.name, epicTitle: epic.title, goal: epic.description, fix: operation.fix!, brief: operation.fixBrief ?? '', branch, epicBranch: epic.branch!,
        target: project.defaultBranch, ontoSha: operation.ontoSha!, files: operation.conflictFiles ?? [], failures, requiredChecks: project.requiredChecks,
        decisions: operation.decisions.filter(d => d.answer).map(d => ({ question: d.question, answer: [d.answer!.label, d.answer!.text].filter(Boolean).join(': ') }))
      })
    }
  }

  async publish(epicId: string): Promise<void> {
    this.#c.d.events.publish({ type: 'epic.updated', epic: await loadEpic(this.#c.d.db, epicId) })
  }

  async #active(tx: Executor, run: RunRow): Promise<OperationRow | null> {
    if (!run.operationId) return null
    const [operation] = await tx.select().from(operations).where(and(eq(operations.id, run.operationId), inArray(operations.state, [...ACTIVE]))).for('update')
    return operation ?? null
  }

  async report(ctx: RunContext, report: OutcomeReport): Promise<unknown> {
    const problem = noteProblem(report.note)
    if (problem) throw new ToolError(`Not reported. ${problem} Add \`note\`: one line saying what this run did, then report again.`)
    switch (report.outcome) {
      case 'pr_updated':
        return this.#submit(ctx, report)
      case 'stuck':
        return this.#stuck(ctx, report)
      case 'failed':
        await this.#c.ending.failRun(ctx, report.summary, { summary: report.summary })
        this.#c.ending.finished(ctx, 'Reported failed')
        return { ok: true, message: 'Recorded. You can stop now.' }
    }
    throw new ToolError('A developer on an epic reports pr_updated, stuck or failed')
  }

  // Nothing moves here: the synchronizer's pass publishes the reported commit
  async #submit(ctx: RunContext, report: OutcomeReport) {
    const { db, github } = this.#c.d
    const { run } = ctx
    const project = ctx.project!
    const { headSha, behaviourChanged } = report
    if (!headSha) throw new ToolError('There is no commit to submit. Commit your work, then report again.')
    if (behaviourChanged === undefined) throw new ToolError('Not submitted. Add behaviourChanged: true if this changes what the code does, false if approved behaviour is unchanged.')
    const fix = run.fixKind
    if (fix === 'conflict' && !report.conflictedFiles?.length) throw new ToolError('Not submitted. Add conflictedFiles: every file in which you resolved a conflict.')
    const [current] = await db.select().from(operations).where(eq(operations.id, run.operationId!))
    if (current && headSha === current.expectedTargetSha) throw new ToolError('Not submitted. The branch is still at the epic head: there is nothing to publish. Commit your work and report again.')
    const head = await github.branchHead(project.repository, epicResolutionBranch(run.operationId!))
    if (head !== headSha) throw new ToolError(`Not submitted. The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${headSha}. Try again.`)
    await db.transaction(async (tx) => {
      const operation = await this.#active(tx, run)
      const [live] = await tx.select({ state: runs.state }).from(runs).where(eq(runs.id, run.id)).for('update')
      if (!operation || !live || !isActiveRun(live.state)) throw new ToolError('This fix is over. Stop working.')
      await tx.update(operations).set({ fixReport: { runId: run.id, headSha, behaviourChanged, conflictedFiles: report.conflictedFiles ?? [], summary: report.summary }, updatedAt: this.#c.now() }).where(eq(operations.id, operation.id))
      await tx.update(runs).set({ ...runEndValues({ state: 'completed', outcome: 'pr_updated', summary: report.summary, headSha, conflictedFiles: report.conflictedFiles }, this.#c.now()), behaviourChanged }).where(eq(runs.id, run.id))
      await appendAudit(tx, { projectId: project.id, actor: this.#c.runs.actor(ctx) }, auditEvent('epic.pr', { epicId: run.epicId!, event: 'fix_reported', fix: fix!, operationId: operation.id, runId: run.id, headSha, behaviourChanged, files: report.conflictedFiles ?? [], summary: `${behaviourChanged ? 'Behaviour changed' : 'Behaviour unchanged'}. ${report.note}` }))
      await appendAudit(tx, { projectId: project.id, actor: server }, auditEvent('run.ended', { runId: run.id, runNumber: run.number, state: 'completed', outcome: 'pr_updated', error: null, behaviourChanged, ...(report.conflictedFiles && { conflictedFiles: report.conflictedFiles }) }))
    })
    await this.publish(run.epicId!)
    this.#c.ending.finished(ctx, 'Outcome accepted')
    return { ok: true, message: 'Corral checks the candidate and publishes it to the epic branch. You can stop now.' }
  }

  // A product question waits on the human with the lock held. Anything else
  // that stops a developer stops the epic until a human retries.
  async #stuck(ctx: RunContext, report: OutcomeReport) {
    const { db } = this.#c.d
    const { run } = ctx
    const project = ctx.project!
    if (!report.decision && run.fixKind === 'conflict') throw new ToolError('Not reported. An epic rebase asks the human through `decision`: one focused question, at least two alternatives and the changes affected. Add it and report again.')
    await db.transaction(async (tx) => {
      const operation = await this.#active(tx, run)
      if (!operation) throw new ToolError('This fix is over. Stop working.')
      if (report.decision) {
        const decision = { ...report.decision, id: crypto.randomUUID(), runId: run.id, raisedAt: this.#c.now().toISOString(), answer: null }
        await tx.update(operations).set({ decisions: [...operation.decisions, decision], updatedAt: this.#c.now() }).where(eq(operations.id, operation.id))
        await appendAudit(tx, { projectId: project.id, actor: this.#c.runs.actor(ctx) }, auditEvent('epic.pr', { epicId: run.epicId!, event: 'decision_requested', operationId: operation.id, decisionId: decision.id, summary: decision.question, bindingDecision: decision.bindingDecision ?? null, alternatives: decision.alternatives.map(a => a.label), affectedChanges: decision.affectedChanges }))
      } else await recordSyncFailure(tx, project, run.epicId!, `The developer needs a human: ${report.summary}`, this.#c.now())
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'stuck', summary: report.summary })
    })
    await this.publish(run.epicId!)
    this.#c.ending.finished(ctx, 'Stuck: waiting on a human')
    return { ok: true, message: 'The human has your question. You can stop now.' }
  }

  // Before the run ends, in its transaction. True when the epic stopped.
  async runFailed(tx: Executor, run: RunRow, error: string): Promise<boolean> {
    const operation = await this.#active(tx, run)
    if (!operation) return false
    const attempts = operation.fixAttempts + 1
    await tx.update(operations).set({ fixAttempts: attempts, updatedAt: this.#c.now() }).where(eq(operations.id, operation.id))
    if (attempts < MAX_FIX_ATTEMPTS) return false
    const [project] = await tx.select().from(projects).where(eq(projects.id, run.projectId!))
    await recordSyncFailure(tx, project!, run.epicId!, `The developer failed ${attempts} times to fix the ${FIX_LABEL[operation.fix!]}. The last run: ${error}`, this.#c.now())
    return true
  }
}

// The human's answer lets the claim start another run on the same operation
export async function answerEpicDecision(db: Executor, epicId: string, input: Pick<EpicReviewActionInput, 'alternative' | 'text'>, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [operation] = await tx.select().from(operations).where(and(eq(operations.epicId, epicId), isNotNull(operations.fix), inArray(operations.state, [...ACTIVE]))).for('update')
    const decision = operation && openDecision(operation)
    if (!operation || !decision) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_decision_changed' })
    const answer = answerOn(decision, { alternative: input.alternative, text: input.text })
    await tx.update(operations).set({ decisions: operation.decisions.map(d => d.id === decision.id ? { ...d, answer } : d), updatedAt: new Date() }).where(eq(operations.id, operation.id))
    const [epic] = await tx.select({ projectId: epics.projectId }).from(epics).where(eq(epics.id, epicId))
    await appendAudit(tx, { projectId: epic!.projectId, actor }, auditEvent('epic.pr', { epicId, event: 'decision_answered', operationId: operation.id, decisionId: decision.id, summary: `${decision.question} ${answer.label}${input.text ? `: ${input.text}` : ''}`, changesBehaviour: answer.changesBehaviour }))
  })
}
