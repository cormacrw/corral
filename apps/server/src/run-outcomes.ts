import { DESIGN_TOO_LARGE, DESIGN_VERSION_MAX_BYTES, outcomeName, SPIKE_OPENS_NO_PR, toolName, type Comment, type OutcomeReport } from '@corral/contracts'
import { errorText, feedbackSimilarity, humanCheckTally, isAuthoringRole, isPrFree, nextDesignVersion, reviewFeedbackText, SERVER_ACTOR, shortSha, taskRef, transition, type EpicDecisionRequest, type ReviewVerdict } from '@corral/core'
import { schema, type Database, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { appendAudit, auditEvent } from './audit.ts'
import { bundleProblem } from './designs.ts'
import { raiseDecision, recordResolutionReview } from './epic-rebase-approval.ts'
import type { GitHubClient, PullRequest } from './github.ts'
import type { BlobStore } from './blob-store.ts'
import type { EventBus } from './events.ts'
import { feedbackComment, findingsComment, noteProblem, WORK_NOTE_RULE } from './outcome-text.ts'
import { carryOverApproval } from './rebase-review.ts'
import { triageBlocked } from './retry-recovery.ts'
import { evidenceState, isEpicRebaseTask, isEpicResolution, taskBase } from './task-base.ts'
import { recordTaskSubmission } from './task-submissions.ts'
import { applyTransition } from './tasks.ts'
import { runActor, type RunContext, type RunContexts } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import { ToolError } from './tool-error.ts'
import { addComment, addCommentWithTransition } from './comments.ts'
import { toTaskState } from './task-rows.ts'
import { checkTrivialRebase } from './github-diff.ts'
import { taskCriteria } from './criteria.ts'

const { designVersions, reviews, taskSubmissions, tasks } = schema

// What the runner sends for submit_design (D20)
const designSchema = z.object({
  headSha: z.string().min(1),
  spec: z.string().trim().min(1, 'design.md is empty'),
  bundle: z.object({ dataBase64: z.string().min(1) }),
  screenshots: z.array(z.object({ fileName: z.string().min(1), contentType: z.string().regex(/^image\//), dataBase64: z.string().min(1) })).min(1, 'Add at least one screenshot')
})

// What stands in for a commit on a spike's submission: reviews are kept per
// submission, and a spike has no commits to tell them apart
function findingsMarker(runId: string): string {
  return `findings-${runId}`
}

interface RunOutcomesDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  blobs: BlobStore
  // Where people open Corral, for links in PR bodies
  publicUrl: string
  runs: Pick<RunContexts, 'lockHeld'>
  ending: Pick<RunEnding, 'failRun' | 'finished' | 'endRunIn' | 'postNote'>
}

export class RunOutcomes {
  #d: RunOutcomesDeps

  constructor(deps: RunOutcomesDeps) {
    this.#d = deps
  }

  async reportOutcome(ctx: RunContext, report: OutcomeReport): Promise<unknown> {
    if (ctx.run.role === 'reviewer') {
      switch (report.outcome) {
        case 'approved':
        case 'changes_requested':
          return this.#review(ctx, report, report.outcome)
        case 'blocked':
          if (!ctx.task?.rebaseOnly && !(ctx.task && isEpicResolution(ctx.task))) throw new ToolError('Only a rebase review can report blocked.')
          return this.#blockedRebaseReview(ctx, report.summary, report.decision)
        case 'failed':
          await this.#d.ending.failRun(ctx, report.summary, { summary: report.summary, headSha: report.headSha })
          this.#d.ending.finished(ctx, 'Reported failed')
          return { ok: true, message: 'Recorded. You can stop now.' }
      }
      throw new ToolError('A reviewer reports approved, changes_requested, blocked (rebase review only) or failed')
    }
    if (isAuthoringRole(ctx.run.role)) {
      const problem = noteProblem(report.note)
      if (problem) throw new ToolError(`Not reported. ${problem} Add \`note\`: ${WORK_NOTE_RULE}. Then report again.`)
      const spike = ctx.task!.type === 'spike'
      const design = ctx.task!.type === 'design'
      const prFree = isPrFree(ctx.task!)
      const expected = design ? 'design_submitted' : spike ? 'findings_reported' : prFree ? 'commit_submitted' : 'pr_opened or pr_updated'
      switch (report.outcome) {
        case 'commit_submitted':
          if (!prFree) throw new ToolError(`Not submitted. Only a subtask without a PR submits a commit; this task reports ${ctx.task!.rebaseOnly ? 'pr_rebased' : expected}.`)
          this.#requireBehaviour(ctx, report)
          return this.#submitCommit(ctx, { ...report, outcome: report.outcome })
        case 'pr_opened':
        case 'pr_updated':
        case 'pr_rebased':
          if (prFree) throw new ToolError(`Not submitted. This subtask opens no PR: report ${outcomeName('commit_submitted')}.`)
          if (ctx.task!.rebaseOnly && report.outcome !== 'pr_rebased') throw new ToolError('Not submitted. A rebase-only round expects pr_rebased.')
          if (!ctx.task!.rebaseOnly && report.outcome === 'pr_rebased') throw new ToolError('Not submitted. This round expects pr_opened or pr_updated, not pr_rebased.')
          if (spike) throw new ToolError(`Not submitted. ${SPIKE_OPENS_NO_PR}`)
          if (design) throw new ToolError(`Not submitted. A design task opens no PR: call ${toolName('submit_design')}, then report ${outcomeName('design_submitted')}.`)
          if (report.outcome === 'pr_rebased') {
            if (!report.review) throw new ToolError('Not submitted. Add review: trivial or needs_review.')
            if (!report.conflictedFiles?.length) throw new ToolError('Not submitted. Add conflictedFiles: every file in which you resolved a conflict.')
          }
          this.#requireBehaviour(ctx, report)
          return this.#submit(ctx, { ...report, outcome: report.outcome })
        case 'findings_reported':
          if (!spike) throw new ToolError(`Not submitted. Only a spike reports findings; this task reports ${expected}.`)
          return this.#reportFindings(ctx, report)
        case 'design_submitted':
          if (!design) throw new ToolError(`Not submitted. Only a design task reports design_submitted; this task reports ${expected}.`)
          return this.#reportDesign(ctx, report)
        case 'stuck':
          return this.#stuck(ctx, report.summary, report.note!, report.decision)
        case 'failed':
          await this.#d.ending.failRun(ctx, report.summary, { summary: report.summary, headSha: report.headSha }, report.note)
          this.#d.ending.finished(ctx, 'Reported failed')
          return { ok: true, message: 'Recorded. You can stop now.' }
      }
      throw new ToolError(spike
        ? 'A spike’s developer reports findings_reported, stuck or failed'
        : design ? 'A design task’s designer reports design_submitted, stuck or failed' : prFree ? 'A developer reports commit_submitted, stuck or failed' : 'A developer reports pr_opened, pr_updated, pr_rebased (rebase-only rounds), stuck or failed')
    }
    throw new ToolError(`Outcomes for ${ctx.run.role} runs aren't supported yet`)
  }

  // D29: the developer says what a round keeping a PR healthy did
  #requireBehaviour(ctx: RunContext, report: OutcomeReport) {
    if (report.behaviourChanged !== undefined || report.outcome === 'pr_opened') return
    if (ctx.task!.ciFix || report.outcome === 'pr_rebased') throw new ToolError('Not submitted. Add behaviourChanged: true if this changes what the code does, false if approved behaviour is unchanged.')
  }

  // The developer's report, in the task's activity. Only a round with a
  // say in it gets one. Call before the task's lease ends.
  async #behaviourComment(tx: Executor, ctx: RunContext, report: OutcomeReport, reviewed: boolean): Promise<Comment | null> {
    if (report.behaviourChanged === undefined) return null
    const said = report.behaviourChanged ? 'The developer reported that behaviour changed.' : 'The developer reported that behaviour did not change.'
    return addComment(tx, ctx.task!.id, { body: `${said} ${reviewed ? 'It goes to Agent review.' : 'No reviewer looks at it again; CI runs on the new head.'}`, pinned: false }, SERVER_ACTOR)
  }

  // flows.md steps 6–7: record the verdict for this commit. Changes
  // requested goes through core (round cap → Blocked) and the feedback is
  // posted as a comment; an approval moves the task to Human review or
  // Ready to merge, where the merge orchestrator takes over.
  async #review(ctx: RunContext, report: Extract<OutcomeReport, { outcome: ReviewVerdict }>, verdict: ReviewVerdict) {
    const { db } = this.#d
    const task = ctx.task!
    if (task.rebaseOnly && verdict === 'approved') return this.#approvedRebaseReview(ctx, report)
    const criteria = await taskCriteria(db, task.id)
    const verdicts = report.criteria ?? []
    const missing = criteria.filter(c => !c.checkedByHuman && !verdicts.some(v => v.criterionId === c.id))
    if (missing.length > 0) {
      throw new ToolError(`Not recorded. Give a verdict for every criterion; missing: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}.`)
    }
    const unknown = verdicts.filter(v => !criteria.some(c => c.id === v.criterionId))
    if (unknown.length > 0) throw new ToolError(`Not recorded. Unknown criterion IDs: ${unknown.map(v => v.criterionId).join(', ')}.`)
    if (verdict === 'approved' && verdicts.some(v => !v.met && !criteria.find(c => c.id === v.criterionId)?.checkedByHuman)) {
      throw new ToolError('Not recorded. An approval needs every criterion met; otherwise report changes_requested.')
    }
    const kept = criteria.map(c => c.checkedByHuman
      ? { criterionId: c.id, met: null, note: 'Needs human check' }
      : { criterionId: c.id, met: verdicts.find(v => v.criterionId === c.id)!.met, note: verdicts.find(v => v.criterionId === c.id)!.note ?? '' })
    // An approval is a short note; the per-criterion notes are kept on the
    // review and shown next to the evidence. Changes requested spells out
    // every criterion for the developer, except the narrow rebase comment.
    const summary = report.summary
    const feedback = task.rebaseOnly ? `Rebase review changes requested: ${report.summary.trim()}` : verdict === 'approved' ? `Approved: ${kept.some(v => v.met === null) ? humanCheckTally(kept.filter(v => v.met).length, kept.filter(v => v.met === null).length) : `all ${kept.length} criteria met`}. ${report.summary.trim()}`.trim() : feedbackComment(report.summary, kept, criteria)

    const prFree = isPrFree(task)
    const branchHead = prFree ? await this.#d.github.branchHead(ctx.project!.repository, task.branch!) : null
    const next = await db.transaction(async (tx) => {
      const locked = await this.#d.runs.lockHeld(tx, ctx)
      const headSha = locked.task.headSha!
      await this.#bindVerdict(tx, locked.task, report, verdict, branchHead)
      if (verdict === 'approved' && isEpicResolution(locked.task)) await recordResolutionReview(tx, task.id, { runId: ctx.run.id, headSha, preserved: report.preservesApproval === true, summary: report.summary })
      // A change request is compared with the previous round's, if that
      // one requested changes too; near-identical feedback blocks the task
      const similarity = verdict === 'changes_requested' ? await this.#feedbackSimilarity(tx, task.id, locked.task.reviewRounds, report.summary, kept) : undefined
      await tx.insert(reviews).values({
        taskId: task.id, runId: ctx.run.id, round: locked.task.reviewRounds, headSha, verdict, summary, criteria: kept, author: runActor(ctx)
      })
      await addCommentWithTransition(tx, task.id, { body: feedback }, runActor(ctx))
      await appendAudit(tx, { projectId: ctx.run.projectId, taskId: task.id, actor: runActor(ctx) }, auditEvent('review.recorded', { runId: ctx.run.id, verdict, headSha, round: locked.task.reviewRounds, met: kept.filter(v => v.met).length, of: kept.length, ...(similarity !== undefined && { similarity }) }))
      // Changes requested → the developer; approved → Human review when
      // flagged, otherwise Ready to merge (D10). PR-free work always takes
      // Ready to merge: the human sees it at the epic review (D27)
      const state = await applyTransition(tx, locked.task, locked.project, verdict === 'approved' ? { type: 'review_approved' } : { type: 'changes_requested', similarity }, SERVER_ACTOR, { event: verdict === 'approved' ? 'review_approved' : 'changes_requested', runId: ctx.run.id, headSha, ...(similarity !== undefined && { similarity }) })
      // The review-round cap and repeated feedback get the PM's diagnosis first (D11)
      if (state.status === 'blocked') await triageBlocked(tx, ctx.run, locked.task)
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: verdict, summary: report.summary, headSha })
      return state
    })
    this.#d.ending.finished(ctx, `Review recorded: ${verdict}`, { handoff: true })
    const spike = task.type === 'spike'
    return {
      ok: true,
      message: verdict === 'changes_requested'
        ? next.status === 'blocked'
          ? `Changes requested. The task is Blocked for a human (${next.reason}). You can stop now.`
          : 'Changes requested; your feedback was sent to the developer. You can stop now.'
        : task.type === 'design'
          ? 'Approval recorded. The human reviews the design next. You can stop now.'
          : spike
            ? 'Approval recorded. A human reviews the findings next. You can stop now.'
            : prFree
              ? 'Approval recorded for this commit. Corral integrates it into the task\'s branch, and any human checks go to the human at the task review. You can stop now.'
              : 'Approval recorded. Corral handles human review, CI and the merge from here. You can stop now.'
    }
  }

  // A verdict binds to one commit. Without a PR nothing later re-checks the
  // head, so this is where a moved branch or checkout is caught (D27).
  async #bindVerdict(tx: Executor, task: TaskRow, report: OutcomeReport, verdict: ReviewVerdict, branchHead: string | null) {
    const headSha = task.headSha!
    const prFree = isPrFree(task)
    const reviewed = report.headSha ?? (prFree ? null : headSha)
    if (reviewed !== headSha) throw new ToolError(`Not recorded. This verdict is for ${reviewed ?? 'an unknown commit'}, but the submitted commit is ${headSha}. Check out the submitted commit and review it, or report failed.`)
    if (!prFree) return
    if (branchHead !== headSha) throw new ToolError(`Not recorded. Branch ${task.branch} is at ${branchHead ?? 'nothing'}, not the submitted commit ${headSha}, so this verdict no longer applies. Report failed for a human to look at.`)
    const [submission] = await tx.select({ id: taskSubmissions.id, submittedHeadSha: taskSubmissions.submittedHeadSha }).from(taskSubmissions).where(eq(taskSubmissions.taskId, task.id)).orderBy(desc(taskSubmissions.sequence)).limit(1)
    if (submission?.submittedHeadSha !== headSha) throw new ToolError(`Not recorded. No submission exists for commit ${headSha}. Report failed for a human to look at.`)
    if (verdict === 'approved') await tx.update(taskSubmissions).set({ agentApprovedHeadSha: headSha }).where(eq(taskSubmissions.id, submission.id))
  }

  // How alike this change request is to the previous round's (0 to 1);
  // undefined when the previous round didn't request changes
  // (the first round, or the first since the task was unblocked)
  async #feedbackSimilarity(tx: Executor, taskId: string, round: number, summary: string, criteria: { met: boolean | null, note: string }[]): Promise<number | undefined> {
    if (round === 0) return undefined
    const [previous] = await tx.select({ summary: reviews.summary, criteria: reviews.criteria }).from(reviews)
      .where(and(eq(reviews.taskId, taskId), eq(reviews.round, round - 1), eq(reviews.verdict, 'changes_requested')))
      .orderBy(desc(reviews.createdAt)).limit(1)
    if (!previous) return undefined
    return feedbackSimilarity(reviewFeedbackText(previous.summary, previous.criteria), reviewFeedbackText(summary, criteria))
  }

  // D24: the reviewer found the rebase clean, so the earlier approval stands
  async #approvedRebaseReview(ctx: RunContext, report: OutcomeReport) {
    const task = ctx.task!
    const branchHead = isPrFree(task) ? await this.#d.github.branchHead(ctx.project!.repository, task.branch!) : null
    await this.#d.db.transaction(async (tx) => {
      const locked = await this.#d.runs.lockHeld(tx, ctx)
      await this.#bindVerdict(tx, locked.task, report, 'approved', branchHead)
      const carried = await carryOverApproval(tx, locked, { actor: runActor(ctx), runId: ctx.run.id, via: 'a reviewed rebase', note: report.summary })
      if (!carried.ok) throw new ToolError(`Not recorded. ${carried.problem}`)
      await addCommentWithTransition(tx, locked.task.id, { body: `Rebase review approved: ${report.summary.trim()}` }, runActor(ctx))
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'approved', summary: report.summary, headSha: locked.task.headSha! })
    })
    this.#d.ending.finished(ctx, 'Review recorded: approved', { handoff: true })
    return { ok: true, message: 'Approval carried over. Corral handles any human check, CI and the merge from here. You can stop now.' }
  }

  // D24: a substantial change or a changed binding decision is the human's call.
  async #blockedRebaseReview(ctx: RunContext, reason: string, structured?: EpicDecisionRequest) {
    if (!reason.trim()) throw new ToolError('Explain the substantial change and the affected criteria for the human.')
    const decision = this.#decisionFor(ctx, reason, structured)
    await this.#d.db.transaction(async (tx) => {
      const { task, project } = await this.#d.runs.lockHeld(tx, ctx)
      await addCommentWithTransition(tx, task.id, { body: `Rebase review blocked: ${reason.trim()}` }, runActor(ctx))
      if (decision) await raiseDecision(tx, task, project, decision, ctx.run.id, runActor(ctx))
      await applyTransition(tx, task, project, { type: 'block', reason: decision?.question ?? reason }, SERVER_ACTOR, { event: 'blocked', runId: ctx.run.id })
      await triageBlocked(tx, ctx.run, task)
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'blocked', summary: reason })
    })
    this.#d.ending.finished(ctx, 'Rebase review blocked: waiting on PM triage')
    return { ok: true, message: 'The task is Blocked for PM triage. You can stop now.' }
  }

  // An epic rebase holds its writer lock until the human answers on the
  // operation, so a question always goes there. Refusing a report that lacks
  // `decision` would lose the question: an agent with no way to supply one can
  // only fail, and the task retries with nobody asked. Without alternatives the
  // human answers in words, which counts as changing approved behaviour.
  #decisionFor(ctx: RunContext, summary: string, decision?: EpicDecisionRequest): EpicDecisionRequest | undefined {
    if (decision || !ctx.task || !isEpicResolution(ctx.task)) return decision
    return { question: summary.trim(), alternatives: [], affectedChanges: [] }
  }

  // Holds the task for PM diagnosis before any human question (D11).
  async #stuck(ctx: RunContext, question: string, note: string, structured?: EpicDecisionRequest) {
    const decision = this.#decisionFor(ctx, question, structured)
    const comment = await this.#d.db.transaction(async (tx) => {
      const { task, project } = await this.#d.runs.lockHeld(tx, ctx)
      const comment = await this.#d.ending.postNote(tx, ctx, note)
      if (decision) await raiseDecision(tx, task, project, decision, ctx.run.id, runActor(ctx))
      await applyTransition(tx, task, project, { type: 'block', reason: decision?.question ?? question }, SERVER_ACTOR, { event: 'stuck', runId: ctx.run.id })
      await triageBlocked(tx, ctx.run, task)
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'stuck', summary: question })
      return comment
    })
    this.#d.events.publish({ type: 'comment.created', comment })
    this.#d.ending.finished(ctx, 'Stuck: waiting on PM triage')
    return { ok: true, message: 'The task is Blocked for PM triage. You can stop now.' }
  }

  // What every code submission must pass before anything changes: the branch
  // is at the pushed commit, and the criteria have this round's evidence
  async #checkSubmission(ctx: RunContext, headSha: string) {
    const { db, github } = this.#d
    const task = ctx.task!
    const head = await github.branchHead(ctx.project!.repository, task.branch!)
    const { criteria, attached, missing } = await evidenceState(db, task)
    // CI failed on this commit, so it can't be the fix
    if (task.ciFix !== null && !task.rebaseOnly && headSha === task.headSha) throw new ToolError('Not submitted. The branch is still at the commit CI failed on: there is nothing new to check. Commit your fix and report again, or report `stuck` if it isn\'t yours to fix.')

    // Check with core before touching GitHub, so a rejected outcome leaves no trace
    const check = transition(toTaskState(task), {
      type: 'submit',
      branchAtExpectedCommit: head === headSha,
      evidenceComplete: missing.length === 0
    }, SERVER_ACTOR)
    if (!check.ok) {
      const problems = [
        head !== headSha ? `The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${headSha}.` : '',
        missing.length > 0 ? `No evidence yet for: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}.` : ''
      ].filter(Boolean)
      throw new ToolError(`Not submitted. ${problems.join(' ') || JSON.stringify(check.error)} Fix this and report again.`)
    }
    return { criteria, attached }
  }

  // D27: the pushed commit is the submission. It goes to Agent review with its
  // own record, and nothing touches a PR or the shared epic branch.
  async #submitCommit(ctx: RunContext, report: OutcomeReport & { outcome: 'commit_submitted' }) {
    const { db } = this.#d
    const task = ctx.task!
    const { headSha, baseSha } = report
    if (!headSha || !baseSha || headSha === baseSha) throw new ToolError('There is no commit to submit. Commit your work on this branch, then report again.')
    await this.#checkSubmission(ctx, headSha)

    const posted = await db.transaction(async (tx) => {
      const locked = await this.#d.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      const ciFix = locked.task.ciFix !== null
      // D29: a CI fix that changes nothing keeps its approval on the new commit
      const carried = ciFix && report.behaviourChanged === false && locked.task.approvedHeadSha
        ? await this.#carryCiFix(tx, ctx, { task: { ...locked.task, headSha }, project: locked.project }, report)
        : false
      if (!carried) {
        await applyTransition(tx, locked.task, locked.project, {
          type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
        }, SERVER_ACTOR, { event: 'commit_submitted', runId: ctx.run.id, headSha, pr: null })
      }
      const submission = await recordTaskSubmission(tx, { taskId: task.id, submittedHeadSha: headSha, baseSha }).catch((error: unknown) => {
        throw new ToolError(`Not submitted. ${errorText(error)}`)
      })
      if (carried) await tx.update(taskSubmissions).set({ agentApprovedHeadSha: headSha }).where(eq(taskSubmissions.id, submission.id))
      await tx.update(tasks).set({ ciFix: null, ...(carried && { headSha }) }).where(eq(tasks.id, task.id))
      const comment = await this.#d.ending.postNote(tx, ctx, report.note!)
      const said = await this.#behaviourComment(tx, ctx, report, !carried)
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'commit_submitted', summary: report.summary, headSha, behaviourChanged: report.behaviourChanged, ...(ciFix && { fixKind: 'ci' as const, reReviewed: !carried }), ...(locked.task.rebaseOnly && { fixKind: 'conflict' as const, reReviewed: true }) })
      return said ? [comment, said] : [comment]
    })
    for (const comment of posted) this.#d.events.publish({ type: 'comment.created', comment })
    this.#d.ending.finished(ctx, 'Outcome accepted', { handoff: true })
    return { ok: true, commit: headSha, message: `Commit ${shortSha(headSha)} on ${task.branch} is ready for review. You can stop now.` }
  }

  // flows.md step 5: validate the developer's submission, open or update the
  // PR, then move the task to Agent review
  async #submit(ctx: RunContext, report: OutcomeReport & { outcome: 'pr_opened' | 'pr_updated' | 'pr_rebased' }) {
    const { db, github } = this.#d
    const task = ctx.task!
    if (!report.headSha) throw new ToolError('There is no commit to submit. Commit your work, then report again.')
    const { criteria, attached } = await this.#checkSubmission(ctx, report.headSha)

    const ref = taskRef(ctx.project!.prefix, task.number)
    const body = this.#prBody(ref, task.title, report.summary, criteria, attached)
    // A rebase task's commits are already on the epic PR; it has no PR of its own
    let pr: PullRequest | null = null
    if (!await isEpicRebaseTask(db, task)) {
      const existing = task.prNumber
        ? await github.getPullRequest(ctx.project!.repository, task.prNumber)
        : await github.findOpenPullRequest(ctx.project!.repository, task.branch!)
      pr = existing && existing.state === 'open' ? existing : null
      if (pr) await github.updatePullRequest(ctx.project!.repository, pr.number, { body })
      else pr = await github.openPullRequest(ctx.project!.repository, { head: task.branch!, base: await taskBase(db, task, ctx.project!, github), title: `${ref}: ${task.title}`, body })
    }

    // D24: a trivial rebase goes to the reviewer unless the server can confirm
    // it. GitHub failing proves nothing, so that also means a review.
    const rebaseCheck = report.outcome === 'pr_rebased' && report.review === 'trivial' && report.behaviourChanged === false
      ? await checkTrivialRebase(github, ctx.project!.repository, {
          baseBranch: await taskBase(db, task, ctx.project!, github),
          approvedHeadSha: task.approvedHeadSha!,
          newHeadSha: report.headSha,
          conflictedFiles: report.conflictedFiles!
        })
      : null

    const { posted, verified, ciCarried } = await db.transaction(async (tx) => {
      const locked = await this.#d.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      await tx.update(tasks).set({ headSha: report.headSha, ...(pr && { prNumber: pr.number, prUrl: pr.url }) }).where(eq(tasks.id, task.id))
      const carried = rebaseCheck && !rebaseCheck.error && rebaseCheck.failures.length === 0
        ? await this.#carryVerifiedRebase(tx, ctx, { task: { ...locked.task, headSha: report.headSha!, prNumber: pr?.number ?? locked.task.prNumber }, project: locked.project }, report)
        : null
      const ciFix = locked.task.ciFix !== null && !task.rebaseOnly
      const ciCarried = ciFix && report.behaviourChanged === false && locked.task.approvedHeadSha
        ? await this.#carryCiFix(tx, ctx, { task: { ...locked.task, headSha: report.headSha!, prNumber: pr?.number ?? locked.task.prNumber }, project: locked.project }, report)
        : false
      await tx.update(tasks).set({ ciFix: null }).where(eq(tasks.id, task.id))
      if (!carried?.comment && !ciCarried) {
        const checkError = carried?.problem ?? rebaseCheck?.error
        const checkResult = rebaseCheck && { checkFailures: rebaseCheck.failures, ...(checkError && { checkError }) }
        await applyTransition(tx, locked.task, locked.project, {
          type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
        }, SERVER_ACTOR, { event: report.outcome, runId: ctx.run.id, headSha: report.headSha, pr: pr?.number ?? null, ...checkResult })
      }
      const note = await this.#d.ending.postNote(tx, ctx, report.note!)
      const skipped = Boolean(carried?.comment) || ciCarried
      const said = await this.#behaviourComment(tx, ctx, report, !skipped)
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: report.outcome, summary: report.summary, headSha: report.headSha, behaviourChanged: report.behaviourChanged, ...(report.outcome === 'pr_rebased' ? { review: report.review, conflictedFiles: report.conflictedFiles, fixKind: 'conflict' as const, reReviewed: !skipped } : {}), ...(ciFix && { fixKind: 'ci' as const, reReviewed: !skipped }) })
      return { posted: [note, ...said ? [said] : [], ...carried?.comment ? [carried.comment] : []], verified: Boolean(carried?.comment), ciCarried }
    })
    for (const comment of posted) this.#d.events.publish({ type: 'comment.created', comment })
    this.#d.ending.finished(ctx, 'Outcome accepted', { handoff: true })
    if (!pr) return { ok: true, message: 'The rebased task\'s branch is ready for review. You can stop now.' }
    if (ciCarried) return { ok: true, pr: pr.url, message: 'The approval carried over. CI runs on your new head, and Corral merges once it passes. You can stop now.' }
    if (verified) return { ok: true, pr: pr.url, message: 'The server verified your trivial rebase, so the approval carried over. Corral handles any human check, CI and the merge from here. You can stop now.' }
    return { ok: true, pr: pr.url, message: `PR #${pr.number} is ready for review. You can stop now.` }
  }

  // D29: the developer reports a CI fix changes nothing, so the approval and
  // verdicts carry to the new head, which CI still has to pass. False when
  // they can't: the round then goes to Agent review.
  async #carryCiFix(tx: Executor, ctx: RunContext, locked: { task: TaskRow, project: ProjectRow }, report: OutcomeReport): Promise<boolean> {
    const carried = await carryOverApproval(tx, locked, { actor: SERVER_ACTOR, runId: ctx.run.id, via: 'a CI fix reported as not changing behaviour', note: report.summary })
    return carried.ok
  }

  // D24: the server check passed, so no reviewer is needed. The comment is the
  // task's Activity entry. Call with `headSha` on the new head.
  async #carryVerifiedRebase(tx: Executor, ctx: RunContext, locked: { task: TaskRow, project: ProjectRow }, report: OutcomeReport): Promise<{ comment?: Comment, problem?: string }> {
    const files = report.conflictedFiles!.map(file => `\`${file}\``).join(', ')
    const carried = await carryOverApproval(tx, locked, {
      actor: SERVER_ACTOR,
      runId: ctx.run.id,
      via: 'a server-verified trivial rebase',
      note: `Only the conflicted files changed (${report.conflictedFiles!.join(', ')}) and no project doc moved on the base.`
    })
    if (!carried.ok) return { problem: carried.problem }
    await appendAudit(tx, { projectId: locked.project.id, taskId: locked.task.id, actor: SERVER_ACTOR }, auditEvent('rebase.verified', { runId: ctx.run.id, pr: locked.task.prNumber, approvedHeadSha: locked.task.approvedHeadSha, headSha: report.headSha, conflictedFiles: report.conflictedFiles }))
    return { comment: await addComment(tx, locked.task.id, { body: `Trivial rebase verified without review: only the conflicted files changed (${files}) and no project doc changed on the base. The approval carried over to ${report.headSha}.`, pinned: false }, SERVER_ACTOR) }
  }

  // D19: a spike's findings are its deliverable. Like a submission they
  // need evidence for every criterion, but nothing is pushed or opened on
  // GitHub: the findings go on the task as a comment and the reviewer judges
  // them. The submission is marked by this run, in place of a commit, so
  // each report gets its own review.
  async #reportFindings(ctx: RunContext, report: OutcomeReport) {
    const { db } = this.#d
    const task = ctx.task!
    const { missing } = await evidenceState(db, task)
    if (missing.length > 0) {
      throw new ToolError(`Not submitted. No evidence yet for: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}. Attach it and report again.`)
    }
    const marker = findingsMarker(ctx.run.id)
    const posted = await db.transaction(async (tx) => {
      const locked = await this.#d.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, SERVER_ACTOR, { event: 'findings_reported', runId: ctx.run.id, headSha: marker })
      await tx.update(tasks).set({ headSha: marker }).where(eq(tasks.id, task.id))
      const note = await this.#d.ending.postNote(tx, ctx, report.note!)
      const findings = await addComment(tx, task.id, { body: findingsComment(report.summary), pinned: false }, runActor(ctx))
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'findings_reported', summary: report.summary })
      return [note, findings]
    })
    for (const comment of posted) this.#d.events.publish({ type: 'comment.created', comment })
    this.#d.ending.finished(ctx, 'Findings accepted for review', { handoff: true })
    return { ok: true, message: 'Your findings are on the task and go to the reviewer next. You can stop now.' }
  }

  // D20: a new design version at the commit the runner just pushed. The
  // bundle must be a sound archive with index.html at its root so the
  // preview can serve it.
  async submitDesign(ctx: RunContext, input: unknown) {
    const { db, github, blobs } = this.#d
    const task = ctx.task!
    if (task.type !== 'design') throw new ToolError('Only a design task submits a design')
    const parsed = designSchema.safeParse(input)
    if (!parsed.success) throw new ToolError(`Not submitted. ${parsed.error.issues.map(i => i.message).join('; ')}.`)
    const submission = parsed.data
    const bundle = Buffer.from(submission.bundle.dataBase64, 'base64')
    const shots = submission.screenshots.map(s => ({ ...s, data: Buffer.from(s.dataBase64, 'base64') }))
    if (bundle.length + shots.reduce((n, s) => n + s.data.length, 0) > DESIGN_VERSION_MAX_BYTES) throw new ToolError(DESIGN_TOO_LARGE)
    const problem = bundleProblem(bundle)
    if (problem) throw new ToolError(`Not submitted. ${problem}`)
    const head = await github.branchHead(ctx.project!.repository, task.branch!)
    if (head !== submission.headSha) throw new ToolError(`Not submitted. The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${submission.headSha}. Try again.`)

    const bundleBlob = await blobs.put(bundle)
    const specBlob = await blobs.put(Buffer.from(submission.spec))
    const screenshots: { blob: string, fileName: string, contentType: string }[] = []
    for (const shot of shots) screenshots.push({ blob: await blobs.put(shot.data), fileName: shot.fileName, contentType: shot.contentType })
    const version = await db.transaction(async (tx) => {
      await this.#d.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      const existing = await tx.select({ version: designVersions.version, status: designVersions.status }).from(designVersions).where(eq(designVersions.taskId, task.id))
      const [row] = await tx.insert(designVersions).values({
        taskId: task.id, version: nextDesignVersion(existing), bundleBlob, specBlob, screenshots, branch: task.branch!, commitSha: submission.headSha
      }).returning()
      await appendAudit(tx, { projectId: ctx.run.projectId, taskId: task.id, actor: runActor(ctx) }, auditEvent('design.submitted', { runId: ctx.run.id, version: row!.version, headSha: submission.headSha, screenshots: screenshots.length }))
      return row!
    })
    return {
      ok: true,
      version: version.version,
      commitSha: version.commitSha,
      message: `Design v${version.version} recorded at ${shortSha(version.commitSha)}. Attach evidence for every criterion, then call ${toolName('report_outcome')} with outcome ${outcomeName('design_submitted')}.`
    }
  }

  // D20: the designer's outcome on a design task. Accepted only when a
  // version exists for the branch's current commit and every criterion has
  // evidence. Nothing is opened on GitHub.
  async #reportDesign(ctx: RunContext, report: OutcomeReport) {
    const { db, github } = this.#d
    const task = ctx.task!
    if (!report.headSha) throw new ToolError(`There is no commit to submit. Commit your work, call ${toolName('submit_design')}, then report again.`)
    const head = await github.branchHead(ctx.project!.repository, task.branch!)
    const [version] = await db.select().from(designVersions)
      .where(and(eq(designVersions.taskId, task.id), eq(designVersions.commitSha, report.headSha))).orderBy(desc(designVersions.version)).limit(1)
    const { missing } = await evidenceState(db, task)
    const problems = [
      head !== report.headSha ? `The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${report.headSha}.` : '',
      !version ? `No design version was submitted at your latest commit ${report.headSha}: call ${toolName('submit_design')} first.` : '',
      missing.length > 0 ? `No evidence yet for: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}.` : ''
    ].filter(Boolean)
    if (problems.length > 0) throw new ToolError(`Not submitted. ${problems.join(' ')} Fix this and report again.`)

    const comment = await db.transaction(async (tx) => {
      const locked = await this.#d.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, SERVER_ACTOR, { event: 'design_submitted', runId: ctx.run.id, headSha: report.headSha, version: version!.version })
      await tx.update(tasks).set({ headSha: report.headSha }).where(eq(tasks.id, task.id))
      const comment = await this.#d.ending.postNote(tx, ctx, report.note!)
      await this.#d.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'design_submitted', summary: report.summary, headSha: report.headSha })
      return comment
    })
    this.#d.events.publish({ type: 'comment.created', comment })
    this.#d.ending.finished(ctx, `Design v${version!.version} submitted for review`, { handoff: true })
    return { ok: true, message: `Design v${version!.version} goes to the reviewer next, then to the human. You can stop now.` }
  }

  #prBody(ref: string, title: string, summary: string, criteria: { id: string, text: string, checkedByHuman: boolean }[], attached: { criterionId: string | null }[]): string {
    const link = `${this.#d.publicUrl}/tasks/${ref}`
    // Table cells can't hold newlines or bare pipes
    const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|')
    return [
      '## Summary',
      '',
      summary.trim(),
      '',
      '## Acceptance criteria',
      '',
      '| Criterion | Evidence |',
      '| --- | --- |',
      ...criteria.map((c) => {
        const n = attached.filter(e => e.criterionId === c.id).length
        return `| ${cell(c.text)} | ${c.checkedByHuman ? 'Needs human check' : `${n} item${n === 1 ? '' : 's'}`} |`
      }),
      '',
      `Screenshots, logs and the reviewer's verdicts are on the [evidence page](${link}?evidence=1).`,
      '',
      '---',
      '',
      `Corral task [${ref}: ${cell(title)}](${link})`
    ].join('\n')
  }
}
