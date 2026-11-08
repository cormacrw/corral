import type { EpicReviewReport, RunJob } from '@corral/contracts'
import { ACTIVE_RUN_STATES, boardComplete, isActiveRun, leaseExpiry, REVIEW_VERDICTS, SERVER_ACTOR, type Actor, type TargetFileChange } from '@corral/core'
import { schema, type Database, type Executor, type RunRow } from '@corral/db'
import { and, asc, desc, eq, gte, inArray, isNotNull, ne } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { hasCapacity } from './claim.ts'
import { readCiFailures } from './ci-output.ts'
import { requiredChecks } from './checks.ts'
import { openEpicFix } from './epic-fixes.ts'
import { approvalSnapshot, epicReviewContext, REVIEW_FAILED } from './epic-review.ts'
import { publishEpic } from './epics.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import { activeOperation, activeRebase } from './operations.ts'
import { epicBoard } from './parents.ts'
import { epicReviewCiSection, epicReviewPrompt, findingsText, type EpicReviewCi } from './prompts.ts'
import { endRunIn } from './run-lifecycle.ts'
import { workerJob } from './run-job.ts'

const { agents, epicReviewRounds, epics, projects, runs, taskIntegrationOperations: operations } = schema

// What fixes published since the last approval changed in files only the target
// changed, newest per file. A verdict of changes requested doesn't clear them.
async function unreviewedTargetFiles(tx: Executor, epicId: string): Promise<TargetFileChange[]> {
  const [approved] = await tx.select({ endedAt: runs.endedAt }).from(runs)
    .where(and(eq(runs.epicId, epicId), eq(runs.role, 'reviewer'), eq(runs.state, 'completed'), eq(runs.outcome, 'approved'))).orderBy(desc(runs.number)).limit(1)
  const published = await tx.select({ report: operations.fixReport }).from(operations)
    .where(and(eq(operations.epicId, epicId), eq(operations.state, 'succeeded'), isNotNull(operations.fix), approved?.endedAt ? gte(operations.updatedAt, approved.endedAt) : undefined))
    .orderBy(desc(operations.updatedAt))
  const files = new Map<string, TargetFileChange>()
  for (const { report } of published) {
    for (const file of report?.targetFiles ?? []) {
      if (!files.has(file.path)) files.set(file.path, file)
    }
  }
  return [...files.values()]
}

export interface EpicReviewRunsDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  now: () => Date
}

// Integration review runs on a task's PR (D23, D27): claiming one for a
// reviewer, what CI says, its verdict, and giving up after repeated failures
export class EpicReviewRuns {
  #d: EpicReviewRunsDeps

  constructor(deps: EpicReviewRunsDeps) {
    this.#d = deps
  }

  #now() { return this.#d.now() }

  async claim(agentId: string, place: (tx: Executor) => Promise<string | null>): Promise<RunJob | null> {
    return this.#d.db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
      if (agent?.role !== 'reviewer' || !await hasCapacity(tx, agent, this.#now())) return null
      const candidates = await tx.select({ epic: epics, project: projects }).from(epics)
        .innerJoin(projects, eq(projects.id, epics.projectId))
        .where(and(eq(epics.reviewState, 'in_review'), eq(projects.paused, false)))
        .orderBy(asc(epics.updatedAt)).for('update', { of: epics, skipLocked: true })
      for (const { epic, project } of candidates) {
        const [live] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.epicId, epic.id), inArray(runs.state, [...ACTIVE_RUN_STATES]))).limit(1)
        if (live || await activeRebase(tx, epic.id) || !epic.prHeadSha || !epic.branch || !boardComplete(await epicBoard(tx, epic.id))) continue
        // No reviewer runner free: the epic stays in review for the next pass
        const runnerId = await place(tx)
        if (!runnerId) return null
        const [run] = await tx.insert(runs).values({ projectId: project.id, epicId: epic.id, agentId, role: 'reviewer', runnerId, leaseEpoch: 1, leaseExpiresAt: leaseExpiry(this.#now()), headSha: epic.prHeadSha, queuedAt: this.#now() }).returning()
        const context = await epicReviewContext(tx, epic, project)
        const [last] = await tx.select({ id: runs.id, headSha: runs.headSha, summary: runs.summary, outcome: runs.outcome, findings: epicReviewRounds.findings }).from(runs)
          .leftJoin(epicReviewRounds, eq(epicReviewRounds.runId, runs.id))
          .where(and(eq(runs.epicId, epic.id), eq(runs.role, 'reviewer'), eq(runs.state, 'completed'), inArray(runs.outcome, [...REVIEW_VERDICTS]), ne(runs.id, run!.id))).orderBy(desc(runs.number)).limit(1)
        const targetFiles = await unreviewedTargetFiles(tx, epic.id)
        const fixes = last?.headSha ? await tx.select({ summary: runs.summary, kind: runs.fixKind }).from(runs).where(and(eq(runs.epicId, epic.id), eq(runs.role, 'developer'), eq(runs.outcome, 'pr_updated'))).orderBy(desc(runs.number)).limit(5) : []
        return {
          ...workerJob(run!, agent.runtime, project), role: 'reviewer', baseBranch: project.defaultBranch,
          taskId: null, taskRef: null, epicId: epic.id, branch: epic.branch, headSha: epic.prHeadSha,
          prompt: epicReviewPrompt({ agentName: agent.name, title: epic.title, context, target: project.defaultBranch, headSha: epic.prHeadSha, requiredChecks: project.requiredChecks, targetFiles, lastReview: last?.headSha ? { headSha: last.headSha, findings: last.findings ?? [], summary: last.summary ?? '', outcome: last.outcome!, fixes: fixes.map(f => f.summary ?? '').filter(Boolean) } : null })
        }
      }
      return null
    })
  }

  // Reads what CI says about the head under review, once the claim's
  // transaction is over. The reviewer leaves the gates to it (D26, D29).
  async addCiResult(job: RunJob, requiredNames: string[]): Promise<RunJob> {
    if (requiredNames.length === 0 || !job.headSha) return job
    const ci = await this.#ciResult(job.repository, job.headSha, requiredNames)
    return { ...job, prompt: `${job.prompt}\n\n${epicReviewCiSection(ci)}` }
  }

  async #ciResult(repository: string, headSha: string, required: string[]): Promise<EpicReviewCi> {
    // An unread CI result is said so in the prompt, not a failed claim
    const checks = await this.#d.github.checks(repository, headSha).catch(() => null)
    if (!checks) return { read: false, passed: [], pending: required, failures: [] }
    const { failed, passed, pending } = requiredChecks(required, checks)
    return { read: true, passed: passed.map(c => c.name), pending: pending.filter(name => !failed.some(c => c.name === name)), failures: await readCiFailures(this.#d.github, repository, failed.map(c => ({ name: c.name, url: c.url }))) }
  }

  async report(run: RunRow, report: EpicReviewReport): Promise<void> {
    const { outcome } = report
    if (!run.projectId) throw new Error('Task reviews require a project')
    // GitHub first, holding no lock. The verdict only moves the epic on: the
    // merge pass reads the head again, under the lock, before anything merges.
    const [found] = await this.#d.db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, run.epicId!))
    if (!found || found.epic.reviewState !== 'in_review' || found.epic.prHeadSha !== run.headSha) throw new Error('The task changed during review; this verdict is stale')
    const pr = await this.#d.github.getPullRequest(found.project.repository, found.epic.prNumber!)
    if (pr.state !== 'open' || pr.merged || pr.headSha !== run.headSha) throw new Error('The task\'s PR head changed; this verdict is stale')
    await this.#d.db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, run.projectId!)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, run.epicId!)).for('update')
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for('update')
      if (!project || !epic || !current || !isActiveRun(current.state) || epic.reviewState !== 'in_review' || epic.prHeadSha !== run.headSha || !boardComplete(await epicBoard(tx, epic.id))) throw new Error('The task changed during review; this verdict is stale')
      // Nothing else should hold the lock here, and a fix needs it
      if (report.outcome === 'changes_requested' && await activeOperation(tx, epic.id)) throw new Error('The task changed during review; this verdict is stale')
      const actor: Actor = { kind: 'agent', role: 'reviewer', runId: run.id }
      const [previous] = await tx.select({ round: epicReviewRounds.round }).from(epicReviewRounds)
        .where(eq(epicReviewRounds.epicId, epic.id)).orderBy(desc(epicReviewRounds.round)).limit(1)
      await tx.insert(epicReviewRounds).values({
        epicId: epic.id, runId: run.id, reviewerId: run.agentId,
        round: (previous?.round ?? 0) + 1, headSha: run.headSha!,
        verdict: outcome, summary: report.summary, findings: report.findings, createdAt: this.#now()
      })
      await endRunIn(tx, run, { state: 'completed', outcome, summary: report.summary }, this.#now())
      await tx.update(epics).set({ reviewState: report.outcome === 'approved' ? 'human_review' : 'changes_requested', ...report.outcome === 'approved' ? await approvalSnapshot(this.#d.github, project, run.headSha!) : { approvedHeadSha: null, approvedBaseSha: null }, updatedAt: this.#now() }).where(eq(epics.id, epic.id))
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId: epic.id, event: outcome, headSha: run.headSha, summary: report.summary }))
      if (report.outcome === 'changes_requested') await openEpicFix(tx, project, epic, { fix: 'review', brief: report.findings.length ? `${report.summary}\n\n${findingsText(report.findings)}` : report.summary, headSha: run.headSha! }, actor, this.#now())
    })
    await publishEpic(this.#d.db, this.#d.events, run.epicId!)
  }

  // D10's failed-run cap for integration reviews, whose runs have no task to
  // count on: this many failures in a row on one head stop the retries and
  // put the PR in front of the human. D27 has no failed state, so it's Human
  // review, where a refused merge also lands. Call before ending the run, in
  // its transaction: the epic's lock comes first, as it does in `report`.
  async reviewFailed(tx: Executor, run: RunRow, error: string): Promise<boolean> {
    const [epic] = await tx.select().from(epics).where(eq(epics.id, run.epicId!)).for('update')
    if (epic?.reviewState !== 'in_review' || epic.prHeadSha !== run.headSha) return false
    const [project] = await tx.select({ failedRunCap: projects.failedRunCap }).from(projects).where(eq(projects.id, run.projectId!))
    const cap = project!.failedRunCap
    const recent = await tx.select({ state: runs.state }).from(runs)
      .where(and(eq(runs.epicId, epic.id), eq(runs.role, 'reviewer'), eq(runs.headSha, epic.prHeadSha!), ne(runs.id, run.id), inArray(runs.state, ['failed', 'completed'])))
      .orderBy(desc(runs.number)).limit(cap - 1)
    if (recent.length < cap - 1 || recent.some(r => r.state !== 'failed')) return false
    await tx.update(epics).set({ reviewState: 'human_review', updatedAt: this.#now() }).where(eq(epics.id, epic.id))
    await appendAudit(tx, { projectId: run.projectId, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId: epic.id, event: 'review_failed', headSha: epic.prHeadSha, summary: `${REVIEW_FAILED} ${cap} times on this commit. The last run: ${error}` }))
    return true
  }
}
