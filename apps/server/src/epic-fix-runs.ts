import type { OutcomeReport, RunJob } from '@corral/contracts'
import { ACTIVE_RUN_STATES, isActiveRun, leaseExpiry } from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { hasCapacity } from './claim.ts'
import { readCiFailures } from './ci-output.ts'
import { activeFixOperation } from './epic-fixes.ts'
import type { GitHubClient } from './github.ts'
import { answeredDecisions, openDecision, raiseDecision, recordSyncFailure } from './operations.ts'
import { noteProblem } from './outcome-text.ts'
import { epicFixCheckScope, epicFixPrompt } from './prompts.ts'
import { runActor, type RunContext } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import { workerJob } from './run-job.ts'
import { epicResolutionBranch } from './task-base.ts'
import { ToolError } from './tool-error.ts'

const { agents, epics, projects, runs, taskIntegrationOperations: operations } = schema

export interface EpicFixesDeps {
  db: Database
  github: GitHubClient
  now(): Date
  ending: Pick<RunEnding, 'failRun' | 'finished' | 'endRunIn'>
  publishEpic(epicId: string): Promise<void>
}

// Developer runs on an epic, with no task (D29). The operation they belong to
// holds the writer lock from before the first run until a candidate is
// published, so polls and reconnects find the same operation and at most one
// run; publishing stays with the synchronizer.
export class EpicFixes {
  #d: EpicFixesDeps

  constructor(deps: EpicFixesDeps) {
    this.#d = deps
  }

  // A claim, like an integration review's: nothing is sent yet
  async claim(agentId: string, place: (tx: Executor) => Promise<string | null>, skip: readonly string[] = []): Promise<string | null> {
    const now = this.#d.now()
    const closed = await this.#closedPrs()
    return this.#d.db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
      if (agent?.role !== 'developer' || !await hasCapacity(tx, agent, now)) return null
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
        const [run] = await tx.insert(runs).values({ projectId: project.id, epicId: operation.epicId, operationId: operation.id, fixKind: operation.fix, agentId, role: 'developer', runnerId, leaseEpoch: 1, leaseExpiresAt: leaseExpiry(now), headSha: operation.expectedTargetSha, queuedAt: now }).returning()
        return run!.id
      }
      return null
    })
  }

  // Epics waiting on a fix whose PR isn't open: a run there could never publish.
  // Read before the claim's transaction, and an unread PR counts until a later pass.
  async #closedPrs(): Promise<Set<string>> {
    const { db, github } = this.#d
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
    const { db, github } = this.#d
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
      ...workerJob(run, agent.runtime, project), role: 'developer', baseBranch: project.defaultBranch,
      taskId: null, taskRef: null, epicId: epic.id, branch, headSha: operation.expectedTargetSha, continueFrom,
      checkScope: epicFixCheckScope(operation.fix!, project.requiredChecks),
      prompt: epicFixPrompt({
        agentName: agent.name, epicTitle: epic.title, goal: epic.description, fix: operation.fix!, brief: operation.fixBrief ?? '', branch, epicBranch: epic.branch!,
        target: project.defaultBranch, ontoSha: operation.ontoSha!, files: operation.conflictFiles ?? [], failures, requiredChecks: project.requiredChecks,
        decisions: answeredDecisions(operation)
      })
    }
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
        await this.#d.ending.failRun(ctx, report.summary, { summary: report.summary })
        this.#d.ending.finished(ctx, 'Reported failed')
        return { ok: true, message: 'Recorded. You can stop now.' }
    }
    throw new ToolError('A developer on a task with subtasks reports pr_updated, stuck or failed')
  }

  // Nothing moves here: the synchronizer's pass publishes the reported commit
  async #submit(ctx: RunContext, report: OutcomeReport) {
    const { db, github } = this.#d
    const { run } = ctx
    const project = ctx.project!
    const { headSha, behaviourChanged } = report
    if (!headSha) throw new ToolError('There is no commit to submit. Commit your work, then report again.')
    if (behaviourChanged === undefined) throw new ToolError('Not submitted. Add behaviourChanged: true if this changes what the code does, false if approved behaviour is unchanged.')
    const fix = run.fixKind
    if (fix === 'conflict' && !report.conflictedFiles?.length) throw new ToolError('Not submitted. Add conflictedFiles: every file in which you resolved a conflict.')
    const [current] = await db.select().from(operations).where(eq(operations.id, run.operationId!))
    if (current && headSha === current.expectedTargetSha) throw new ToolError('Not submitted. The branch is still at the task\'s head: there is nothing to publish. Commit your work and report again.')
    const head = await github.branchHead(project.repository, epicResolutionBranch(run.operationId!))
    if (head !== headSha) throw new ToolError(`Not submitted. The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${headSha}. Try again.`)
    await db.transaction(async (tx) => {
      const operation = await activeFixOperation(tx, run)
      const [live] = await tx.select({ state: runs.state }).from(runs).where(eq(runs.id, run.id)).for('update')
      if (!operation || !live || !isActiveRun(live.state)) throw new ToolError('This fix is over. Stop working.')
      await tx.update(operations).set({ fixReport: { runId: run.id, headSha, behaviourChanged, conflictedFiles: report.conflictedFiles ?? [], summary: report.summary }, updatedAt: this.#d.now() }).where(eq(operations.id, operation.id))
      await appendAudit(tx, { projectId: project.id, actor: runActor(ctx) }, auditEvent('epic.pr', { epicId: run.epicId!, event: 'fix_reported', fix: fix!, operationId: operation.id, runId: run.id, headSha, behaviourChanged, files: report.conflictedFiles ?? [], summary: `${behaviourChanged ? 'Behaviour changed' : 'Behaviour unchanged'}. ${report.note}` }))
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'pr_updated', summary: report.summary, headSha, conflictedFiles: report.conflictedFiles, behaviourChanged })
    })
    await this.#d.publishEpic(run.epicId!)
    this.#d.ending.finished(ctx, 'Outcome accepted')
    return { ok: true, message: 'Corral checks the candidate and publishes it to the task\'s branch. You can stop now.' }
  }

  // A product question waits on the human with the lock held. Anything else
  // that stops a developer stops the epic until a human retries.
  async #stuck(ctx: RunContext, report: OutcomeReport) {
    const { db } = this.#d
    const { run } = ctx
    const project = ctx.project!
    if (!report.decision && run.fixKind === 'conflict') throw new ToolError('Not reported. A task rebase asks the human through `decision`: one focused question, at least two alternatives and the changes affected. Add it and report again.')
    await db.transaction(async (tx) => {
      const operation = await activeFixOperation(tx, run)
      if (!operation) throw new ToolError('This fix is over. Stop working.')
      if (report.decision) await raiseDecision(tx, operation, report.decision, run.id, { projectId: project.id, actor: runActor(ctx) }, this.#d.now())
      else await recordSyncFailure(tx, project, run.epicId!, `The developer needs a human: ${report.summary}`, this.#d.now())
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'stuck', summary: report.summary })
    })
    await this.#d.publishEpic(run.epicId!)
    this.#d.ending.finished(ctx, 'Stuck: waiting on a human')
    return { ok: true, message: 'The human has your question. You can stop now.' }
  }
}
