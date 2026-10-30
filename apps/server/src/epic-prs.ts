import type { EpicReviewActionInput, EpicReviewItem, OutcomeReport, RunJob } from '@corral/contracts'
import { ACTIVE_RUN_STATES, feedbackFixTitle, feedbackPoints, LEASE_DURATION_MS, markdownToRichText, taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import type { OrchestratorDeps } from './orchestrator.ts'
import { ApiFailure, notFound } from './errors.ts'
import { getEpic } from './epics.ts'
import { listEvidence } from './runs.ts'
import { thumbnailUrl } from './projects.ts'
import { createTask, loadTask, toTasks, type ProjectRow } from './tasks.ts'

const { agents, auditLog, epics, projects, runs, tasks } = schema
const system: Actor = { kind: 'system', component: 'server' }
type EpicRow = typeof epics.$inferSelect
type RunRow = typeof runs.$inferSelect

export async function epicBoard(db: Executor, epicId: string) {
  const rows = await db.select().from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
  return rows.filter(t => t.status !== 'draft' && t.status !== 'backlog')
}

const complete = (board: Awaited<ReturnType<typeof epicBoard>>) => board.length > 0 && board.every(t => t.status === 'merged')

export class EpicPullRequests {
  private d: OrchestratorDeps
  constructor(deps: OrchestratorDeps) { this.d = deps }
  private now() { return this.d.now?.() ?? new Date() }

  // The scheduler already serializes passes. Row locks also protect this
  // path against task additions and concurrent review reports.
  async reconcile(): Promise<void> {
    const { db } = this.d
    const candidates = await db.select({ epic: epics, project: projects }).from(epics)
      .innerJoin(projects, eq(projects.id, epics.projectId))
      .where(and(ne(epics.reviewMode, 'direct'), isNotNull(epics.branch), eq(projects.paused, false)))
    for (const { epic: candidate, project } of candidates) {
      if (candidate.reviewState === 'merged') continue
      try {
        let changed = false
        await db.transaction(async (tx) => {
          const [epic] = await tx.select().from(epics).where(eq(epics.id, candidate.id)).for('update')
          if (!epic || epic.reviewState === 'merged') return
          const board = await epicBoard(tx, epic.id)
          if (!complete(board)) return
          const pr = epic.prNumber
            ? await this.d.github.getPullRequest(project.repository, epic.prNumber)
            : await this.d.github.findOpenPullRequest(project.repository, epic.branch!)
              ?? await this.d.github.openPullRequest(project.repository, {
                head: epic.branch!, base: project.defaultBranch, title: epic.title,
                body: this.body(epic, board, project)
              })
          if (pr.state !== 'open' || pr.merged) return
          if (epic.prNumber && epic.prHeadSha === pr.headSha && epic.reviewState !== 'open' && epic.reviewState !== 'changes_requested') return
          await this.d.github.updatePullRequest(project.repository, pr.number, { body: this.body(epic, board, project) })
          // A moved epic head invalidates approval, even if board membership
          // didn't change. Active runs on the old head are fenced by state.
          await tx.update(runs).set({ state: 'interrupted', endedAt: this.now(), error: 'Epic PR changed' })
            .where(and(eq(runs.epicId, epic.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
          await tx.update(epics).set({ prNumber: pr.number, prHeadSha: pr.headSha, reviewState: 'in_review', updatedAt: this.now() }).where(eq(epics.id, epic.id))
          changed = true
          await tx.insert(auditLog).values({ projectId: project.id, actor: system, action: 'epic.pr', detail: { epicId: epic.id, event: epic.prNumber ? 'review_started' : 'opened', prNumber: pr.number } })
        })
        if (changed) await this.publish(candidate.id)
      } catch (error) {
        console.error(`Epic PR ${candidate.id}:`, error)
      }
    }
  }

  private body(epic: EpicRow, board: Awaited<ReturnType<typeof epicBoard>>, project: ProjectRow) {
    return [epic.description, '## Tasks and evidence', ...board.map((t) => {
      const ref = taskRef(project.prefix, t.number)
      return `- ${ref}: ${t.title}${t.prUrl ? ` ([PR](${t.prUrl}))` : ''} — [criteria and evidence](${this.d.publicUrl}/tasks/${ref})`
    })].join('\n\n')
  }

  async claim(agentId: string, place: (tx: Executor) => Promise<string | null>): Promise<RunJob | null> {
    return this.d.db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
      if (!agent || agent.role !== 'reviewer' || agent.paused || (agent.pausedUntil && agent.pausedUntil > this.now())) return null
      const [active] = await tx.select({ n: count() }).from(runs).where(and(eq(runs.agentId, agent.id), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      if (active!.n >= agent.concurrency) return null
      const candidates = await tx.select({ epic: epics, project: projects }).from(epics)
        .innerJoin(projects, eq(projects.id, epics.projectId))
        .where(and(eq(epics.reviewState, 'in_review'), eq(projects.paused, false)))
        .orderBy(asc(epics.updatedAt)).for('update', { of: epics, skipLocked: true })
      for (const { epic, project } of candidates) {
        const [live] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.epicId, epic.id), inArray(runs.state, [...ACTIVE_RUN_STATES]))).limit(1)
        if (live || !epic.prHeadSha || !epic.branch || !complete(await epicBoard(tx, epic.id))) continue
        // No reviewer runner free: the epic stays in review for the next pass
        const runnerId = await place(tx)
        if (!runnerId) return null
        const [run] = await tx.insert(runs).values({ projectId: project.id, epicId: epic.id, agentId, role: 'reviewer', runnerId, leaseEpoch: 1, leaseExpiresAt: new Date(this.now().getTime() + LEASE_DURATION_MS), headSha: epic.prHeadSha, queuedAt: this.now() }).returning()
        const context = await epicReviewContext(tx, epic, project)
        return {
          runId: run!.id, runNumber: run!.number, leaseEpoch: 1, role: 'reviewer', runtime: agent.runtime,
          projectId: project.id, repository: project.repository, defaultBranch: project.defaultBranch, baseBranch: project.defaultBranch,
          taskId: null, taskRef: null, epicId: epic.id, branch: epic.branch, headSha: epic.prHeadSha,
          planSessionId: null, agentSessionId: null, fallbackPrompt: null, model: null, timeoutSeconds: 3600,
          prompt: `You are ${agent.name}, reviewing the integration of epic "${epic.title}".\n\n${JSON.stringify(context, null, 2)}\n\nReview the whole combined diff with git diff origin/${project.defaultBranch}...HEAD at commit ${epic.prHeadSha}. This is a read-only checkout: do not edit, commit or push. Check the epic goal and every task's criteria, looking for integration problems between tasks (API/UI mismatches, inconsistent docs, duplicate helpers). The evidence is context; do not re-judge individual task evidence. Use get_task for the whole epic and get_evidence to fetch any listed evidence ID. Rerun the project's lint, typecheck, tests and build as gates WITHOUT THE CACHE (for Turbo use --force). Always finish with report_outcome, outcome approved or changes_requested, and specific reasoning in summary. No per-task criteria verdicts are required. Changes requested create a fix task in the epic; approval sends the epic PR to human review.`
        }
      }
      return null
    })
  }

  async report(run: RunRow, report: OutcomeReport): Promise<void> {
    if (!run.projectId) throw new Error('Epic reviews require a project')
    if (!['approved', 'changes_requested'].includes(report.outcome)) throw new Error('Epic review outcomes are approved or changes_requested')
    let fixId: string | null = null
    await this.d.db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, run.projectId!)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, run.epicId!)).for('update')
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for('update')
      if (!project || !epic || !current || !ACTIVE_RUN_STATES.includes(current.state as typeof ACTIVE_RUN_STATES[number]) || epic.reviewState !== 'in_review' || epic.prHeadSha !== run.headSha || !complete(await epicBoard(tx, epic.id))) throw new Error('Epic changed during review; this verdict is stale')
      const pr = await this.d.github.getPullRequest(project.repository, epic.prNumber!)
      if (pr.state !== 'open' || pr.merged || pr.headSha !== run.headSha) throw new Error('Epic PR head changed; this verdict is stale')
      const actor: Actor = { kind: 'agent', role: 'reviewer', runId: run.id }
      await tx.update(runs).set({ state: 'completed', outcome: report.outcome, summary: report.summary, endedAt: this.now() }).where(eq(runs.id, run.id))
      await tx.update(epics).set({ reviewState: report.outcome === 'approved' ? 'human_review' : 'changes_requested', updatedAt: this.now() }).where(eq(epics.id, epic.id))
      if (report.outcome === 'changes_requested') fixId = await this.fixTask(tx, project, epic, report.summary, actor)
      await tx.insert(auditLog).values({ projectId: project.id, actor, action: 'epic.pr', detail: { epicId: epic.id, event: report.outcome, headSha: run.headSha, summary: report.summary } })
    })
    if (fixId) this.d.events.publish({ type: 'task.created', task: await loadTask(this.d.db, fixId) })
    await this.publish(run.epicId!)
  }

  private async fixTask(tx: Executor, project: ProjectRow, epic: EpicRow, feedback: string, actor: Actor) {
    return createTask(tx, project, { type: 'task', title: feedbackFixTitle(feedback), description: markdownToRichText(feedback), epicId: epic.id, acceptanceCriteria: feedbackPoints(feedback) }, actor, { epicFix: true })
  }

  async humanAction(epicId: string, input: EpicReviewActionInput, actor: Actor) {
    if (!/^[0-9a-f-]{36}$/i.test(epicId)) throw notFound()
    if (actor.kind !== 'human') throw new ApiFailure(409, { code: 'conflict', constraint: 'human_only' })
    let fixId: string | null = null
    await this.d.db.transaction(async (tx) => {
      const [found] = await tx.select().from(epics).where(eq(epics.id, epicId))
      if (!found) throw notFound()
      const [project] = await tx.select().from(projects).where(eq(projects.id, found.projectId)).for('update')
      const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
      if (!project || !epic || epic.reviewState !== 'human_review' || epic.prHeadSha !== input.headSha || !complete(await epicBoard(tx, epic.id))) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_review_changed' })
      const pr = await this.d.github.getPullRequest(project.repository, epic.prNumber!)
      if (pr.headSha !== input.headSha || pr.state !== 'open' || pr.merged) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_pr_changed' })
      if (input.action === 'request_changes' && !input.text?.trim()) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ message: 'Describe the changes needed' }] })
      await tx.update(epics).set({ reviewState: input.action === 'approve' ? 'ready_to_merge' : 'changes_requested', updatedAt: this.now() }).where(eq(epics.id, epic.id))
      if (input.action === 'request_changes') fixId = await this.fixTask(tx, project, epic, input.text!.trim(), actor)
      await tx.insert(auditLog).values({ projectId: project.id, actor, action: 'epic.pr', detail: { epicId, event: input.action === 'approve' ? 'human_approved' : 'human_changes_requested', headSha: input.headSha, summary: input.text ?? '' } })
    })
    if (fixId) this.d.events.publish({ type: 'task.created', task: await loadTask(this.d.db, fixId) })
    await this.publish(epicId)
    return { ok: true }
  }

  async publish(id: string) {
    this.d.events.publish({ type: 'epic.updated', epic: await getEpic(this.d.db, id) })
  }
}

export async function epicReviewContext(db: Executor, epic: EpicRow, project: ProjectRow) {
  const board = await toTasks(db, project, await epicBoard(db, epic.id))
  return { epicId: epic.id, title: epic.title, goal: epic.description, branch: epic.branch, headSha: epic.prHeadSha,
    tasks: await Promise.all(board.map(async task => ({ task, evidence: await listEvidence(db, task.id) }))) }
}

export async function epicInboxItems(db: Executor): Promise<EpicReviewItem[]> {
  const rows = await db.select({ epic: epics, project: projects }).from(epics).innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.reviewState, 'human_review'))
  const items: EpicReviewItem[] = []
  for (const { epic, project } of rows) {
    if (!epic.prNumber || !epic.prHeadSha || !complete(await epicBoard(db, epic.id))) continue
    const [review] = await db.select({ run: runs, agent: agents }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(eq(runs.epicId, epic.id), eq(runs.outcome, 'approved'), eq(runs.headSha, epic.prHeadSha))).orderBy(desc(runs.number)).limit(1)
    if (!review) continue
    items.push({ id: epic.id, type: 'epic_review', epicId: epic.id, taskId: null, taskRef: null, subject: epic.title,
      project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: thumbnailUrl(project) },
      preview: review.run.summary ?? 'Integration approved', body: review.run.summary ?? 'Integration approved', sender: { name: review.agent.name, role: 'reviewer' }, at: epic.updatedAt.toISOString(),
      prUrl: `https://github.com/${project.repository}/pull/${epic.prNumber}`, resolution: null, headSha: epic.prHeadSha,
      tasks: (await epicReviewContext(db, epic, project)).tasks })
  }
  return items
}
