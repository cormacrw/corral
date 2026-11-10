import type { RunJob } from '@corral/contracts'
import { actorLabel, AUTHORING_ROLES, isPrFree, taskRef } from '@corral/core'
import { schema, type Database, type Executor, type AgentRow, type TaskRow } from '@corral/db'
import { and, asc, desc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm'
import { listTaskAttachments } from './attachments.ts'
import { readCiFailures } from './ci-output.ts'
import type { GitHubClient } from './github.ts'
import { feedbackComment } from './outcome-text.ts'
import { describeRunner } from './placement.ts'
import { branchSlug } from './projects.ts'
import { cappedBranchDiff, designerPrompt, designerRevisionPrompt, developerCheckScope, developerPrompt, developerRevisionPrompt, reviewerPrompt, type PinnedDesign } from './prompts.ts'
import { latestRebaseCheckFailures } from './rebase-review.ts'
import type { RunContext } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import { workerJob } from './run-job.ts'
import type { RunnerHub } from './runner-hub.ts'
import { listEvidence } from './runs.ts'
import { taskBase } from './task-base.ts'
import { listTaskSubmissions, selectPrFreeProtocol } from './task-submissions.ts'
import { taskCriteria } from './criteria.ts'

const { comments, designVersions, epics, reviews, runs, taskDesignPins, tasks } = schema

interface RunJobsDeps {
  db: Database
  github: GitHubClient
  runner: RunnerHub
  now(): Date
  ending: Pick<RunEnding, 'note'>
}

// Prompt caches are written for an hour; this leaves room for the run to start
const WARM_SESSION_MS = 55 * 60 * 1000

export class RunJobs {
  #d: RunJobsDeps

  constructor(deps: RunJobsDeps) {
    this.#d = deps
  }

  async developerJob(ctx: RunContext): Promise<RunJob> {
    return this.#authorJob(ctx, {
      branch: ref => `corral/${ref.toLowerCase()}-${branchSlug(ctx.task!.title)}`,
      prompt: developerPrompt,
      revision: developerRevisionPrompt
    })
  }

  async designerJob(ctx: RunContext): Promise<RunJob> {
    const [latest] = await this.#d.db.select({ version: designVersions.version, createdAt: designVersions.createdAt }).from(designVersions)
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
    const { db } = this.#d
    let task = ctx.task!
    const ref = taskRef(ctx.project!.prefix, task.number)
    // A spike delivers findings, not a PR (D19), so it never gets a branch.
    // A design is built on design/<ref>, pushed but never merged (D20).
    const baseBranch = await taskBase(db, task, ctx.project!, this.#d.github)
    const spike = task.type === 'spike'
    const resumingBranch = task.branch !== null
    if (!task.branch && !spike) {
      const branch = author.branch(ref)
      ;[task] = await db.update(tasks).set({ branch }).where(eq(tasks.id, task.id)).returning() as [TaskRow]
    }
    if (ctx.run.role === 'developer' && !isPrFree(task) && await this.#canSkipTaskPr(ctx, task, resumingBranch)) {
      task = await selectPrFreeProtocol(db, task.id)
    }
    const criteria = await taskCriteria(db, task.id)
    const notes = await this.comments(task.id)
    const attached = await listTaskAttachments(db, ctx.project!.id, task, notes)
    const pin = await this.#pinnedDesign(ctx.project!.prefix, task.id)
    const previous = await this.previousAuthorRun(db, task.id, ctx.agent.id, ctx.run.role, ctx.run.id)
    const [lastRun] = await db.select().from(runs)
      .where(and(eq(runs.taskId, task.id), inArray(runs.role, [...AUTHORING_ROLES]), ne(runs.id, ctx.run.id)))
      .orderBy(desc(runs.number)).limit(1)
    const stoppedRun = lastRun && (lastRun.state === 'interrupted' || (lastRun.state === 'failed' && lastRun.summary === null))
      // A head that never moved isn't saved work
      ? { number: lastRun.number, reason: lastRun.error ?? 'Stopped', wipSha: lastRun.headSha === lastRun.retryContext?.head ? null : lastRun.headSha }
      : null
    // The server reads what developers can't (D8, D29). This never fails a job.
    const ciFailures = task.ciFix ? await readCiFailures(this.#d.github, ctx.project!.repository, task.ciFix) : null
    const checkScope = ctx.run.role === 'developer' ? developerCheckScope(ctx.project!.requiredChecks) : null
    const promptTask = {
      ref,
      title: task.title,
      description: task.description,
      implementationPlan: task.implementationPlan,
      branch: spike ? null : task.branch,
      spike,
      design: author.design ?? null,
      pin,
      defaultBranch: baseBranch,
      prFree: isPrFree(task),
      reviewRounds: task.reviewRounds,
      rebaseOnly: task.rebaseOnly,
      checkScope,
      approvedHeadSha: task.approvedHeadSha,
      reviewRoundCap: ctx.project!.reviewRoundCap,
      criteria: criteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })),
      comments: notes,
      attachments: attached,
      stoppedRun,
      ciFailures
    }
    const prompt = author.prompt(promptTask, ctx.agent.name)
    const since = previous?.queuedAt ?? null
    const feedback = since ? notes.filter(c => c.createdAt > since) : []
    // A revision continues the author's own session with
    // the feedback given since, when it runs where that session lives. The
    // full prompt is the fallback when the session can't be resumed, and the
    // prompt on another runner, which starts fresh from the pushed branch.
    const local = previous !== null && (previous.runnerId === null || previous.runnerId === ctx.run.runnerId)
    const lastActive = previous?.endedAt ?? previous?.startedAt ?? previous?.queuedAt
    const idleMinutes = lastActive ? Math.round((this.#d.now().getTime() - lastActive.getTime()) / 60_000) : 0
    const idle = `${previous?.endedAt ? 'it ended' : 'it was last active'} ${idleMinutes} ${idleMinutes === 1 ? 'minute' : 'minutes'} ago`
    const warm = lastActive !== undefined && this.#d.now().getTime() - lastActive.getTime() < WARM_SESSION_MS
    // Resuming costs a full cache write once the cache has expired, so a
    // developer's revision starts fresh instead. Rebase rounds and designers
    // keep their session whatever its age: it holds what they need. So does a
    // run that never reported, whose uncommitted work only the session knows.
    const reported = previous?.state === 'completed' && previous.outcome !== null && previous.outcome !== 'rate_limited'
    const expired = local && !warm && ctx.run.role === 'developer' && !task.rebaseOnly && reported
    const resume = local && !expired ? previous.agentSessionId : null
    const fresh = expired ? author.prompt({ ...promptTask, coldRevision: { feedback, diff: spike ? null : await this.#branchDiff(ctx, task, baseBranch) } }, ctx.agent.name) : prompt
    if (resume) {
      await this.#d.ending.note(ctx.run.id, warm
        ? `Resuming the agent session of run #${previous!.number} on ${describeRunner(this.#d.runner, ctx.run.runnerId)}: ${idle}, so its prompt cache is still warm`
        : `Resuming the agent session of run #${previous!.number} on ${describeRunner(this.#d.runner, ctx.run.runnerId)}: ${idle}, so its prompt cache has expired, but this kind of round keeps its session`)
    } else if (expired) {
      await this.#d.ending.note(ctx.run.id, `Starting a fresh session on ${describeRunner(this.#d.runner, ctx.run.runnerId)} after run #${previous!.number}: ${idle}, so resuming it would rewrite an expired prompt cache`)
    } else if (previous) {
      await this.#d.ending.note(ctx.run.id, `Run #${previous.number} ran on ${describeRunner(this.#d.runner, previous.runnerId)}, which is offline: starting a fresh session on ${describeRunner(this.#d.runner, ctx.run.runnerId)}${spike ? '' : ` from the pushed branch ${task.branch}`}`)
    }
    await db.update(runs).set({ sessionStart: !resume ? 'fresh' : warm ? 'resumed_warm' : 'resumed_cold' }).where(eq(runs.id, ctx.run.id))
    return {
      ...workerJob(ctx.run, ctx.agent.runtime, ctx.project!),
      role: ctx.run.role,
      baseBranch,
      taskId: task.id,
      taskRef: ref,
      integrationProtocol: task.integrationProtocol,
      taskType: task.type,
      designPinned: pin !== null,
      branch: spike ? null : task.branch,
      headSha: spike ? null : task.headSha,
      continueFrom: stoppedRun?.wipSha ?? null,
      checkScope,
      agentSessionId: resume,
      fallbackPrompt: resume ? prompt : null,
      prompt: !resume ? fresh : author.revision(promptTask, feedback)
    } as RunJob
  }

  // What the branch holds so far, for a revision starting without its session.
  // This never fails a job: the developer can still read the branch.
  async #branchDiff(ctx: RunContext, task: TaskRow, baseBranch: string): Promise<string | null> {
    if (!task.branch) return null
    const comparison = await this.#d.github.compare(ctx.project!.repository, baseBranch, task.branch).catch(() => null)
    return comparison ? cappedBranchDiff(comparison.files) : null
  }

  // A branch that already has a PR (one whose number was never recorded after
  // a crash) finishes on the legacy path. When GitHub can't say, it stays legacy.
  async #canSkipTaskPr(ctx: RunContext, task: TaskRow, resumingBranch: boolean): Promise<boolean> {
    if (!resumingBranch || !task.branch) return true
    const pr = await this.#d.github.findOpenPullRequest(ctx.project!.repository, task.branch).catch(() => undefined)
    return pr === null
  }

  // The design version a build task is pinned to (D20), for its prompt
  async #pinnedDesign(prefix: string, taskId: string): Promise<PinnedDesign | null> {
    const [pin] = await this.#d.db.select({ screens: taskDesignPins.screens, version: designVersions.version, branch: designVersions.branch, commitSha: designVersions.commitSha, number: tasks.number })
      .from(taskDesignPins).innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId)).innerJoin(tasks, eq(tasks.id, designVersions.taskId))
      .where(eq(taskDesignPins.taskId, taskId))
    return pin ? { designRef: taskRef(prefix, pin.number), version: pin.version, screens: pin.screens, branch: pin.branch, commitSha: pin.commitSha } : null
  }

  // This agent's last run in the same authoring role on the task that started a session: its
  // runner holds the worktree and session a revision resumes
  async previousAuthorRun(db: Executor, taskId: string, agentId: string, role: AgentRow['role'], exclude?: string) {
    const [previous] = await db.select({ number: runs.number, runnerId: runs.runnerId, agentSessionId: runs.agentSessionId, queuedAt: runs.queuedAt, startedAt: runs.startedAt, endedAt: runs.endedAt, state: runs.state, outcome: runs.outcome }).from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.role, role), eq(runs.agentId, agentId), exclude ? ne(runs.id, exclude) : undefined, isNotNull(runs.agentSessionId)))
      .orderBy(desc(runs.number)).limit(1)
    return previous ?? null
  }

  // flows.md step 6: the reviewer checks out the submitted commit
  async reviewerJob(ctx: RunContext): Promise<RunJob> {
    const { db } = this.#d
    const task = ctx.task!
    const ref = taskRef(ctx.project!.prefix, task.number)
    const criteria = await taskCriteria(db, task.id)
    const items = (await listEvidence(db, task.id)).filter(e => e.round === task.reviewRounds)
    const [previous] = await db.select().from(reviews).where(eq(reviews.taskId, task.id)).orderBy(desc(reviews.createdAt)).limit(1)
    const notes = await this.comments(task.id)
    const attached = await listTaskAttachments(db, ctx.project!.id, task, notes)
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
    const prFree = isPrFree(task)
    const submissions = prFree ? await listTaskSubmissions(db, task.id) : []
    return {
      ...workerJob(ctx.run, ctx.agent.runtime, ctx.project!),
      role: 'reviewer',
      baseBranch,
      taskId: task.id,
      taskRef: ref,
      integrationProtocol: task.integrationProtocol,
      taskType: task.type,
      designPinned: pin !== null,
      branch: spike ? null : task.branch,
      headSha: spike ? null : task.headSha,
      prompt: reviewerPrompt({
        ref,
        title: task.title,
        description: task.description,
        implementationPlan: task.implementationPlan,
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

  // A sub-task's run also reads what a human pinned on its parent (D31)
  async comments(taskId: string) {
    const { db } = this.#d
    const [parent] = await db.select({ id: epics.taskId }).from(tasks).innerJoin(epics, eq(epics.id, tasks.epicId)).where(eq(tasks.id, taskId))
    const rows = await db.select().from(comments).where(or(eq(comments.taskId, taskId), parent?.id ? and(eq(comments.taskId, parent.id), eq(comments.pinned, true)) : undefined)).orderBy(asc(comments.createdAt))
    return rows.map(c => ({ author: actorLabel(c.author), body: c.body, pinned: c.pinned, createdAt: c.createdAt }))
  }
}
