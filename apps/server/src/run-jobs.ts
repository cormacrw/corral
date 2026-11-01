import { TASK_INTEGRATION_PROTOCOL, type RunJob } from '@corral/contracts'
import { taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, desc, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm'
import { listTaskAttachments } from './attachments.ts'
import { slugify } from './projects.ts'
import { designerPrompt, designerRevisionPrompt, developerPrompt, developerRevisionPrompt, reviewerPrompt, type PinnedDesign } from './prompts.ts'
import { latestRebaseCheckFailures } from './rebase-review.ts'
import { RUN_TIMEOUT_SECONDS } from './run-lifecycle.ts'
import { listEvidence } from './runs.ts'
import { isEpicRebaseTask, taskBase } from './task-base.ts'
import { listTaskSubmissions, selectPrFreeProtocol } from './task-submissions.ts'
import type { TaskRow } from './tasks.ts'
import { type AgentRow, type RunContext, type RunCore } from './run-context.ts'
import { feedbackComment } from './run-outcomes.ts'

const { acceptanceCriteria, comments, designVersions, reviews, runs, taskDesignPins, tasks } = schema

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'human': return 'Human'
    case 'agent': return actor.role === 'pm' ? 'PM' : actor.role === 'developer' ? 'Developer' : actor.role === 'designer' ? 'Designer' : 'Reviewer'
    case 'system': return 'Corral'
  }
}

export class RunJobs {
  #c: RunCore

  constructor(core: RunCore) {
    this.#c = core
  }

  runnerName(runnerId: string | null): string {
    const name = this.#c.d.runner.status().runners.find(r => r.id === runnerId)?.name
    return name ? `runner ${name}` : 'a runner this server no longer knows'
  }

  async developerJob(ctx: RunContext): Promise<RunJob> {
    return this.#authorJob(ctx, {
      branch: ref => `corral/${ref.toLowerCase()}-${slugify(ctx.task!.title).slice(0, 40).replace(/-+$/, '')}`,
      prompt: developerPrompt,
      revision: developerRevisionPrompt
    })
  }

  async designerJob(ctx: RunContext): Promise<RunJob> {
    const [latest] = await this.#c.d.db.select({ version: designVersions.version, createdAt: designVersions.createdAt }).from(designVersions)
      .where(eq(designVersions.taskId, ctx.task!.id)).orderBy(desc(designVersions.version)).limit(1)
    return this.#authorJob(ctx, {
      branch: ref => `design/${ref}`,
      design: { version: latest?.version ?? null },
      prompt: designerPrompt,
      revision: task => latest ? designerRevisionPrompt(task, task.comments.filter(c => c.createdAt > latest.createdAt)) : designerPrompt(task, ctx.agent.name)
    })
  }

  async #authorJob(ctx: RunContext, author: {
    branch: (ref: string) => string
    design?: { version: number | null }
    prompt: typeof developerPrompt
    revision: typeof developerRevisionPrompt
  }): Promise<RunJob> {
    const { db } = this.#c.d
    let task = ctx.task!
    const ref = taskRef(ctx.project!.prefix, task.number)
    // A spike delivers findings, not a PR (D19), so it never gets a branch.
    // A design is built on design/<ref>, pushed but never merged (D20).
    const baseBranch = await taskBase(db, task, ctx.project!, this.#c.d.github)
    const spike = task.type === 'spike'
    const resumingBranch = task.branch !== null
    if (!task.branch && !spike) {
      const branch = author.branch(ref)
      ;[task] = await db.update(tasks).set({ branch }).where(eq(tasks.id, task.id)).returning() as [TaskRow]
    }
    if (ctx.run.role === 'developer' && !task.integrationProtocol && await this.#canSkipTaskPr(ctx, task, resumingBranch)) {
      task = await selectPrFreeProtocol(db, task.id)
    }
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const notes = await this.comments(task.id)
    const attached = await listTaskAttachments(db, ctx.project!.id, task.description, notes)
    const pin = await this.#pinnedDesign(ctx.project!.prefix, task.id)
    const previous = await this.previousAuthorRun(db, task.id, ctx.agent.id, ctx.run.role, ctx.run.id)
    const [lastRun] = await db.select().from(runs)
      .where(and(eq(runs.taskId, task.id), inArray(runs.role, ['developer', 'designer']), ne(runs.id, ctx.run.id)))
      .orderBy(desc(runs.number)).limit(1)
    const stoppedRun = lastRun && (lastRun.state === 'interrupted' || (lastRun.state === 'failed' && lastRun.summary === null))
      ? { number: lastRun.number, reason: lastRun.error ?? 'Stopped', wipSha: lastRun.headSha }
      : null
    const promptTask = {
      ref,
      title: task.title,
      description: task.description,
      branch: spike ? null : task.branch,
      spike,
      design: author.design ?? null,
      pin,
      defaultBranch: baseBranch,
      prFree: task.integrationProtocol > 0,
      reviewRounds: task.reviewRounds,
      rebaseOnly: task.rebaseOnly,
      squashRebase: ctx.project!.requiredChecks.length > 0 && await isEpicRebaseTask(db, task),
      approvedHeadSha: task.approvedHeadSha,
      reviewRoundCap: ctx.project!.reviewRoundCap,
      criteria: criteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })),
      comments: notes,
      attachments: attached,
      stoppedRun
    }
    const prompt = author.prompt(promptTask, ctx.agent.name)
    // A revision continues the author's own session with
    // the feedback given since, when it runs where that session lives. The
    // full prompt is the fallback when the session can't be resumed, and the
    // prompt on another runner, which starts fresh from the pushed branch.
    const local = previous !== null && (previous.runnerId === null || previous.runnerId === ctx.run.runnerId)
    const resume = local ? previous.agentSessionId : null
    if (resume) {
      await this.#c.ending.note(ctx.run.id, `Resuming the agent session of run #${previous!.number} on ${this.runnerName(ctx.run.runnerId)}`)
    } else if (previous) {
      await this.#c.ending.note(ctx.run.id, `Run #${previous.number} ran on ${this.runnerName(previous.runnerId)}, which is offline: starting a fresh session on ${this.runnerName(ctx.run.runnerId)}${spike ? '' : ` from the pushed branch ${task.branch}`}`)
    }
    const since = previous?.queuedAt ?? null
    const feedback = since ? notes.filter(c => c.createdAt > since) : []
    return {
      runId: ctx.run.id,
      runNumber: ctx.run.number,
      leaseEpoch: ctx.run.leaseEpoch!,
      role: ctx.run.role,
      runtime: ctx.agent.runtime,
      projectId: ctx.project!.id,
      repository: ctx.project!.repository,
      defaultBranch: ctx.project!.defaultBranch,
      baseBranch,
      taskId: task.id,
      taskRef: ref,
      integrationProtocol: task.integrationProtocol,
      taskType: task.type,
      designPinned: pin !== null,
      branch: spike ? null : task.branch,
      headSha: spike ? null : task.headSha,
      continueFrom: stoppedRun?.wipSha ?? null,
      planSessionId: null,
      agentSessionId: resume,
      fallbackPrompt: resume ? prompt : null,
      model: null,
      timeoutSeconds: RUN_TIMEOUT_SECONDS,
      prompt: !resume ? prompt : author.revision(promptTask, feedback)
    } as RunJob
  }

  // D27 rollout: only a supporting runner may start the PR-free path, and a
  // branch that already has a PR (one whose number was never recorded after a
  // crash) finishes on the legacy path. When GitHub can't say, it stays legacy.
  async #canSkipTaskPr(ctx: RunContext, task: TaskRow, resumingBranch: boolean): Promise<boolean> {
    const runner = this.#c.d.runner.status().runners.find(r => r.id === ctx.run.runnerId)
    if (!runner?.taskIntegrationProtocols?.includes(TASK_INTEGRATION_PROTOCOL)) return false
    if (!resumingBranch || !task.branch) return true
    const pr = await this.#c.d.github.findOpenPullRequest(ctx.project!.repository, task.branch).catch(() => undefined)
    return pr === null
  }

  // The design version a build task is pinned to (D20), for its prompt
  async #pinnedDesign(prefix: string, taskId: string): Promise<PinnedDesign | null> {
    const [pin] = await this.#c.d.db.select({ screens: taskDesignPins.screens, version: designVersions.version, branch: designVersions.branch, commitSha: designVersions.commitSha, number: tasks.number })
      .from(taskDesignPins).innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId)).innerJoin(tasks, eq(tasks.id, designVersions.taskId))
      .where(eq(taskDesignPins.taskId, taskId))
    return pin ? { designRef: taskRef(prefix, pin.number), version: pin.version, screens: pin.screens, branch: pin.branch, commitSha: pin.commitSha } : null
  }

  // This agent's last run in the same authoring role on the task that started a session: its
  // runner holds the worktree and session a revision resumes
  async previousAuthorRun(db: Executor, taskId: string, agentId: string, role: AgentRow['role'], exclude?: string) {
    // A developer-authored design is a session boundary (D23), including
    // when this agent had an older designer session before that developer run.
    const [legacy] = role === 'designer'
      ? await db.select({ number: runs.number }).from(runs)
          .where(and(eq(runs.taskId, taskId), eq(runs.role, 'developer')))
          .orderBy(desc(runs.number)).limit(1)
      : []
    const [previous] = await db.select({ number: runs.number, runnerId: runs.runnerId, agentSessionId: runs.agentSessionId, queuedAt: runs.queuedAt }).from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.role, role), eq(runs.agentId, agentId), legacy ? gt(runs.number, legacy.number) : undefined, exclude ? ne(runs.id, exclude) : undefined, isNotNull(runs.agentSessionId)))
      .orderBy(desc(runs.number)).limit(1)
    return previous ?? null
  }

  // flows.md step 6: the reviewer checks out the submitted commit
  async reviewerJob(ctx: RunContext): Promise<RunJob> {
    const { db } = this.#c.d
    const task = ctx.task!
    const ref = taskRef(ctx.project!.prefix, task.number)
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const items = (await listEvidence(db, task.id)).filter(e => e.round === task.reviewRounds)
    const [previous] = await db.select().from(reviews).where(eq(reviews.taskId, task.id)).orderBy(desc(reviews.createdAt)).limit(1)
    const notes = await this.comments(task.id)
    const attached = await listTaskAttachments(db, ctx.project!.id, task.description, notes)
    // A spike has no commit: the reviewer gets a checkout of the default
    // branch and judges the findings the developer last reported (D19)
    const baseBranch = await taskBase(db, task, ctx.project!)
    const spike = task.type === 'spike'
    const [reported] = spike
      ? await db.select({ summary: runs.summary }).from(runs)
          .where(and(eq(runs.taskId, task.id), eq(runs.outcome, 'findings_reported'))).orderBy(desc(runs.number)).limit(1)
      : []
    // A design: the reviewer checks the version submitted at this commit (D20)
    const design = task.type === 'design'
    const [version] = design && task.headSha
      ? await db.select().from(designVersions)
          .where(and(eq(designVersions.taskId, task.id), eq(designVersions.commitSha, task.headSha))).orderBy(desc(designVersions.version)).limit(1)
      : []
    const [rebase] = task.rebaseOnly
      ? await db.select().from(runs).where(and(eq(runs.taskId, task.id), eq(runs.outcome, 'pr_rebased'), eq(runs.headSha, task.headSha!))).orderBy(desc(runs.number)).limit(1)
      : []
    const pin = await this.#pinnedDesign(ctx.project!.prefix, task.id)
    const rebaseCheckFailures = task.rebaseOnly ? await latestRebaseCheckFailures(db, task.id) : []
    const prFree = task.integrationProtocol > 0
    const submissions = prFree ? await listTaskSubmissions(db, task.id) : []
    return {
      runId: ctx.run.id,
      runNumber: ctx.run.number,
      leaseEpoch: ctx.run.leaseEpoch!,
      role: 'reviewer',
      runtime: ctx.agent.runtime,
      projectId: ctx.project!.id,
      repository: ctx.project!.repository,
      defaultBranch: ctx.project!.defaultBranch,
      baseBranch,
      taskId: task.id,
      taskRef: ref,
      integrationProtocol: task.integrationProtocol,
      taskType: task.type,
      designPinned: pin !== null,
      branch: spike ? null : task.branch,
      headSha: spike ? null : task.headSha,
      planSessionId: null,
      agentSessionId: null,
      fallbackPrompt: null,
      model: null,
      timeoutSeconds: RUN_TIMEOUT_SECONDS,
      prompt: reviewerPrompt({
        ref,
        title: task.title,
        description: task.description,
        branch: spike ? null : task.branch,
        spike,
        findings: reported?.summary ?? null,
        rebaseReport: rebase ? { review: rebase.review, conflictedFiles: rebase.conflictedFiles } : null,
        design: design ? { version: version?.version ?? null } : null,
        pin,
        underReview: version ? { version: version.version, commitSha: version.commitSha, screenshots: version.screenshots.map(s => s.fileName) } : null,
        defaultBranch: baseBranch,
        prFree,
        submissions: submissions.map(s => ({ sequence: s.sequence, headSha: s.submittedHeadSha, baseSha: s.baseSha, targetBranch: s.targetBranch, createdAt: s.createdAt })),
        rebaseOnly: task.rebaseOnly,
        approvedHeadSha: task.approvedHeadSha,
        rebaseCheckFailures,
        reviewRounds: task.reviewRounds,
        reviewRoundCap: ctx.project!.reviewRoundCap,
        criteria: criteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })),
        comments: notes,
        attachments: attached,
        headSha: task.headSha!,
        prUrl: task.prUrl,
        evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName })),
        requiredChecks: ctx.project!.requiredChecks,
        previousFeedback: previous ? feedbackComment(previous.summary, previous.criteria, criteria) : null
      }, ctx.agent.name)
    }
  }

  async comments(taskId: string) {
    const rows = await this.#c.d.db.select().from(comments).where(eq(comments.taskId, taskId)).orderBy(asc(comments.createdAt))
    return rows.map(c => ({ author: actorLabel(c.author), body: c.body, pinned: c.pinned, createdAt: c.createdAt }))
  }
}
