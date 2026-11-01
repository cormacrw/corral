import type { Comment, OutcomeReport } from '@corral/contracts'
import { feedbackSimilarity, nextDesignVersion, reviewFeedbackText, transition, humanCheckTally, taskRef, type ReviewVerdict } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { appendAudit, auditEvent } from './audit.ts'
import { bundleProblem } from './designs.ts'
import type { PullRequest } from './github.ts'
import { carryOverApproval, checkTrivialRebase } from './rebase-review.ts'
import { evidenceState, isEpicRebaseTask, taskBase } from './task-base.ts'
import { recordTaskSubmission } from './task-submissions.ts'
import { addComment, applyTransition, toTaskState, type ProjectRow, type TaskRow } from './tasks.ts'
import { ToolError, server, type RunContext, type RunCore } from './run-context.ts'

const { acceptanceCriteria, comments, designVersions, reviews, taskSubmissions, tasks } = schema

// The developer's one-line work note, posted as a comment on every outcome
export const MAX_NOTE_LENGTH = 200
const NOTE_EXAMPLE = 'Rebased onto 6e67d6f; resolved conflict in docs/architecture.md keeping main’s SSE wording'

// What the runner sends for submit_design (D20)
const designSchema = z.object({
  headSha: z.string().min(1),
  spec: z.string().trim().min(1, 'design.md is empty'),
  bundle: z.object({ dataBase64: z.string().min(1) }),
  screenshots: z.array(z.object({ fileName: z.string().min(1), contentType: z.string().regex(/^image\//), dataBase64: z.string().min(1) })).min(1, 'Add at least one screenshot')
})

const MAX_DESIGN_BYTES = 25 * 1024 * 1024

// What stands in for a commit on a spike's submission: reviews are kept per
// submission, and a spike has no commits to tell them apart
export function findingsMarker(runId: string): string {
  return `findings-${runId}`
}

// Why a developer's work note is not acceptable, if it isn't
export function noteProblem(note: string | undefined): string | null {
  if (!note) return 'The work note is missing.'
  if (/[\r\n]/.test(note)) return 'The work note must be a single line.'
  if (note.length > MAX_NOTE_LENGTH) return `The work note is ${note.length} characters; the limit is ${MAX_NOTE_LENGTH}.`
  return null
}

// The review as a comment the developer reads next round
export function feedbackComment(summary: string, verdicts: { criterionId: string, met: boolean | null, note: string }[], criteria: { id: string, text: string }[]): string {
  const lines = verdicts.map((v) => {
    const text = criteria.find(c => c.id === v.criterionId)?.text ?? v.criterionId
    return `- ${v.met === null ? 'Needs human check:' : v.met ? '✅' : '❌'} ${text}${v.note ? ` — ${v.note}` : ''}`
  })
  return [summary.trim(), '', ...lines].join('\n').trim()
}

export class RunOutcomes {
  #c: RunCore

  constructor(core: RunCore) {
    this.#c = core
  }

  async reportOutcome(ctx: RunContext, report: OutcomeReport): Promise<unknown> {
    if (ctx.run.role === 'reviewer') {
      switch (report.outcome) {
        case 'approved':
        case 'changes_requested':
          return this.#review(ctx, report, report.outcome)
        case 'blocked':
          if (!ctx.task?.rebaseOnly) throw new ToolError('Only a rebase review can report blocked.')
          return this.#blockedRebaseReview(ctx, report.summary)
        case 'failed':
          await this.#c.ending.failRun(ctx, report.summary, { summary: report.summary })
          this.#c.ending.finished(ctx, 'Reported failed')
          return { ok: true, message: 'Recorded. You can stop now.' }
      }
      throw new ToolError('A reviewer reports approved, changes_requested, blocked (rebase review only) or failed')
    }
    if (ctx.run.role === 'developer' || ctx.run.role === 'designer') {
      const problem = noteProblem(report.note)
      if (problem) throw new ToolError(`Not reported. ${problem} Add \`note\`: one line of at most ${MAX_NOTE_LENGTH} characters saying what this run did, e.g. "${NOTE_EXAMPLE}". Then report again.`)
      const spike = ctx.task!.type === 'spike'
      const design = ctx.task!.type === 'design'
      const prFree = ctx.task!.integrationProtocol > 0
      const expected = design ? 'design_submitted' : spike ? 'findings_reported' : prFree ? 'commit_submitted' : 'pr_opened or pr_updated'
      switch (report.outcome) {
        case 'commit_submitted':
          if (!prFree) throw new ToolError(`Not submitted. Only an epic task without a PR submits a commit; this task reports ${ctx.task!.rebaseOnly ? 'pr_rebased' : expected}.`)
          return this.#submitCommit(ctx, { ...report, outcome: report.outcome })
        case 'pr_opened':
        case 'pr_updated':
        case 'pr_rebased':
          if (prFree) throw new ToolError('Not submitted. This epic task opens no PR: report commit_submitted.')
          if (ctx.task!.rebaseOnly && report.outcome !== 'pr_rebased') throw new ToolError('Not submitted. A rebase-only round expects pr_rebased.')
          if (!ctx.task!.rebaseOnly && report.outcome === 'pr_rebased') throw new ToolError('Not submitted. This round expects pr_opened or pr_updated, not pr_rebased.')
          if (spike) throw new ToolError('Not submitted. A spike opens no PR: report your findings with outcome findings_reported.')
          if (design) throw new ToolError('Not submitted. A design task opens no PR: call submit_design, then report design_submitted.')
          if (report.outcome === 'pr_rebased') {
            if (!report.review) throw new ToolError('Not submitted. Add review: trivial or needs_review.')
            if (!report.conflictedFiles?.length) throw new ToolError('Not submitted. Add conflictedFiles: every file in which you resolved a conflict.')
          }
          return this.#submit(ctx, { ...report, outcome: report.outcome })
        case 'findings_reported':
          if (!spike) throw new ToolError(`Not submitted. Only a spike reports findings; this task reports ${expected}.`)
          return this.#reportFindings(ctx, report)
        case 'design_submitted':
          if (!design) throw new ToolError(`Not submitted. Only a design task reports design_submitted; this task reports ${expected}.`)
          return this.#reportDesign(ctx, report)
        case 'stuck':
          return this.#stuck(ctx, report.summary, report.note!)
        case 'failed':
          await this.#c.ending.failRun(ctx, report.summary, { summary: report.summary }, report.note)
          this.#c.ending.finished(ctx, 'Reported failed')
          return { ok: true, message: 'Recorded. You can stop now.' }
      }
      throw new ToolError(spike
        ? 'A spike’s developer reports findings_reported, stuck or failed'
        : design ? 'A design task’s designer reports design_submitted, stuck or failed' : prFree ? 'A developer reports commit_submitted, stuck or failed' : 'A developer reports pr_opened, pr_updated, pr_rebased (rebase-only rounds), stuck or failed')
    }
    throw new ToolError(`Outcomes for ${ctx.run.role} runs aren't supported yet`)
  }

  // flows.md steps 6–7: record the verdict for this commit. Changes
  // requested goes through core (round cap → Blocked) and the feedback is
  // posted as a comment; an approval moves the task to Human review or
  // Ready to merge, where the merge orchestrator takes over.
  async #review(ctx: RunContext, report: Extract<OutcomeReport, { outcome: ReviewVerdict }>, verdict: ReviewVerdict) {
    const { db } = this.#c.d
    const task = ctx.task!
    if (task.rebaseOnly && verdict === 'approved') return this.#approvedRebaseReview(ctx, report)
    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
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

    const prFree = task.integrationProtocol > 0
    const branchHead = prFree ? await this.#c.d.github.branchHead(ctx.project!.repository, task.branch!) : null
    const next = await db.transaction(async (tx) => {
      const locked = await this.#c.runs.lockHeld(tx, ctx)
      const headSha = locked.task.headSha!
      await this.#bindVerdict(tx, locked.task, report, verdict, branchHead)
      // A change request is compared with the previous round's, if that
      // one requested changes too; near-identical feedback blocks the task
      const similarity = verdict === 'changes_requested' ? await this.#feedbackSimilarity(tx, task.id, locked.task.reviewRounds, report.summary, kept) : undefined
      await tx.insert(reviews).values({
        taskId: task.id, runId: ctx.run.id, round: locked.task.reviewRounds, headSha, verdict, summary, criteria: kept, author: this.#c.runs.actor(ctx)
      })
      await tx.insert(comments).values({ taskId: task.id, author: this.#c.runs.actor(ctx), body: feedback })
      await appendAudit(tx, { projectId: ctx.run.projectId, taskId: task.id, actor: this.#c.runs.actor(ctx) }, auditEvent('review.recorded', { runId: ctx.run.id, verdict, headSha, round: locked.task.reviewRounds, met: kept.filter(v => v.met).length, of: kept.length, ...(similarity !== undefined && { similarity }) }))
      // Changes requested → the developer; approved → Human review when
      // flagged, otherwise Ready to merge (D10). PR-free work always takes
      // Ready to merge: the human sees it at the epic review (D27)
      const state = await applyTransition(tx, locked.task, locked.project, verdict === 'approved' ? { type: 'review_approved' } : { type: 'changes_requested', similarity }, server, { event: verdict === 'approved' ? 'review_approved' : 'changes_requested', runId: ctx.run.id, headSha, ...(similarity !== undefined && { similarity }) })
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: verdict, summary: report.summary, headSha })
      return state
    })
    this.#c.ending.finished(ctx, `Review recorded: ${verdict}`, { handoff: true })
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
              ? 'Approval recorded for this commit. Corral integrates it into the epic branch, and any human checks go to the human at the epic review. You can stop now.'
              : 'Approval recorded. Corral handles human review, CI and the merge from here. You can stop now.'
    }
  }

  // A verdict binds to one commit. Without a PR nothing later re-checks the
  // head, so this is where a moved branch or checkout is caught (D27).
  async #bindVerdict(tx: Executor, task: TaskRow, report: OutcomeReport, verdict: ReviewVerdict, branchHead: string | null) {
    const headSha = task.headSha!
    const prFree = task.integrationProtocol > 0
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
    const branchHead = task.integrationProtocol > 0 ? await this.#c.d.github.branchHead(ctx.project!.repository, task.branch!) : null
    await this.#c.d.db.transaction(async (tx) => {
      const locked = await this.#c.runs.lockHeld(tx, ctx)
      await this.#bindVerdict(tx, locked.task, report, 'approved', branchHead)
      const carried = await carryOverApproval(tx, locked, { actor: this.#c.runs.actor(ctx), runId: ctx.run.id, via: 'a reviewed rebase', note: report.summary })
      if (!carried.ok) throw new ToolError(`Not recorded. ${carried.problem}`)
      await tx.insert(comments).values({ taskId: locked.task.id, author: this.#c.runs.actor(ctx), body: `Rebase review approved: ${report.summary.trim()}` })
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'approved', summary: report.summary, headSha: locked.task.headSha! })
    })
    this.#c.ending.finished(ctx, 'Review recorded: approved', { handoff: true })
    return { ok: true, message: 'Approval carried over. Corral handles any human check, CI and the merge from here. You can stop now.' }
  }

  // D24: a substantial change or a changed binding decision is the human's call.
  async #blockedRebaseReview(ctx: RunContext, reason: string) {
    if (!reason.trim()) throw new ToolError('Explain the substantial change and the affected criteria for the human.')
    await this.#c.d.db.transaction(async (tx) => {
      const { task, project } = await this.#c.runs.lockHeld(tx, ctx)
      await tx.insert(comments).values({ taskId: task.id, author: this.#c.runs.actor(ctx), body: `Rebase review blocked: ${reason.trim()}` })
      await applyTransition(tx, task, project, { type: 'block', reason }, server, { event: 'blocked', runId: ctx.run.id })
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'blocked', summary: reason })
    })
    this.#c.ending.finished(ctx, 'Rebase review blocked: waiting on a human')
    return { ok: true, message: 'The task is Blocked for a human decision. You can stop now.' }
  }

  // Asks a human: the task becomes Blocked with the question as its reason (D11)
  async #stuck(ctx: RunContext, question: string, note: string) {
    const comment = await this.#c.d.db.transaction(async (tx) => {
      const { task, project } = await this.#c.runs.lockHeld(tx, ctx)
      const comment = await this.#c.ending.postNote(tx, ctx, note)
      await applyTransition(tx, task, project, { type: 'block', reason: question }, server, { event: 'stuck', runId: ctx.run.id })
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'stuck', summary: question })
      return comment
    })
    this.#c.d.events.publish({ type: 'comment.created', comment })
    this.#c.ending.finished(ctx, 'Stuck: waiting on a human')
    return { ok: true, message: 'The task is Blocked until a human answers. You can stop now.' }
  }

  // What every code submission must pass before anything changes: the branch
  // is at the pushed commit, and the criteria have this round's evidence
  async #checkSubmission(ctx: RunContext, headSha: string) {
    const { db, github } = this.#c.d
    const task = ctx.task!
    const head = await github.branchHead(ctx.project!.repository, task.branch!)
    const { criteria, attached, missing } = await evidenceState(db, task)

    // Check with core before touching GitHub, so a rejected outcome leaves no trace
    const check = transition(toTaskState(task), {
      type: 'submit',
      branchAtExpectedCommit: head === headSha,
      evidenceComplete: missing.length === 0
    }, server)
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
    const { db } = this.#c.d
    const task = ctx.task!
    const { headSha, baseSha } = report
    if (!headSha || !baseSha || headSha === baseSha) throw new ToolError('There is no commit to submit. Commit your work on this branch, then report again.')
    await this.#checkSubmission(ctx, headSha)

    const comment = await db.transaction(async (tx) => {
      const locked = await this.#c.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, server, { event: 'commit_submitted', runId: ctx.run.id, headSha, pr: null })
      await recordTaskSubmission(tx, { taskId: task.id, submittedHeadSha: headSha, baseSha }).catch((error: unknown) => {
        throw new ToolError(`Not submitted. ${error instanceof Error ? error.message : String(error)}`)
      })
      const comment = await this.#c.ending.postNote(tx, ctx, report.note!)
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'commit_submitted', summary: report.summary, headSha })
      return comment
    })
    this.#c.d.events.publish({ type: 'comment.created', comment })
    this.#c.ending.finished(ctx, 'Outcome accepted', { handoff: true })
    return { ok: true, commit: headSha, message: `Commit ${headSha.slice(0, 10)} on ${task.branch} is ready for review. You can stop now.` }
  }

  // flows.md step 5: validate the developer's submission, open or update the
  // PR, then move the task to Agent review
  async #submit(ctx: RunContext, report: OutcomeReport & { outcome: 'pr_opened' | 'pr_updated' | 'pr_rebased' }) {
    const { db, github } = this.#c.d
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
    const rebaseCheck = report.outcome === 'pr_rebased' && report.review === 'trivial'
      ? await checkTrivialRebase(github, ctx.project!.repository, {
          baseBranch: await taskBase(db, task, ctx.project!, github),
          approvedHeadSha: task.approvedHeadSha!,
          newHeadSha: report.headSha,
          conflictedFiles: report.conflictedFiles!
        })
      : null

    const { posted, verified } = await db.transaction(async (tx) => {
      const locked = await this.#c.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      await tx.update(tasks).set({ headSha: report.headSha, ...(pr && { prNumber: pr.number, prUrl: pr.url }) }).where(eq(tasks.id, task.id))
      const carried = rebaseCheck && !rebaseCheck.error && rebaseCheck.failures.length === 0
        ? await this.#carryVerifiedRebase(tx, ctx, { task: { ...locked.task, headSha: report.headSha!, prNumber: pr?.number ?? locked.task.prNumber }, project: locked.project }, report)
        : null
      if (!carried?.comment) {
        const checkError = carried?.problem ?? rebaseCheck?.error
        const checkResult = rebaseCheck && { checkFailures: rebaseCheck.failures, ...(checkError && { checkError }) }
        await applyTransition(tx, locked.task, locked.project, {
          type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
        }, server, { event: report.outcome, runId: ctx.run.id, headSha: report.headSha, pr: pr?.number ?? null, ...checkResult })
      }
      const note = await this.#c.ending.postNote(tx, ctx, report.note!)
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: report.outcome, summary: report.summary, headSha: report.headSha, ...(report.outcome === 'pr_rebased' ? { review: report.review, conflictedFiles: report.conflictedFiles } : {}) })
      return { posted: carried?.comment ? [note, carried.comment] : [note], verified: Boolean(carried?.comment) }
    })
    for (const comment of posted) this.#c.d.events.publish({ type: 'comment.created', comment })
    this.#c.ending.finished(ctx, 'Outcome accepted', { handoff: true })
    if (!pr) return { ok: true, message: 'The rebased epic branch is ready for review. You can stop now.' }
    if (verified) return { ok: true, pr: pr.url, message: 'The server verified your trivial rebase, so the approval carried over. Corral handles any human check, CI and the merge from here. You can stop now.' }
    return { ok: true, pr: pr.url, message: `PR #${pr.number} is ready for review. You can stop now.` }
  }

  // D24: the server check passed, so no reviewer is needed. The comment is the
  // task's Activity entry. Call with `headSha` on the new head.
  async #carryVerifiedRebase(tx: Executor, ctx: RunContext, locked: { task: TaskRow, project: ProjectRow }, report: OutcomeReport): Promise<{ comment?: Comment, problem?: string }> {
    const files = report.conflictedFiles!.map(file => `\`${file}\``).join(', ')
    const carried = await carryOverApproval(tx, locked, {
      actor: server,
      runId: ctx.run.id,
      via: 'a server-verified trivial rebase',
      note: `Only the conflicted files changed (${report.conflictedFiles!.join(', ')}) and no project doc moved on the base.`
    })
    if (!carried.ok) return { problem: carried.problem }
    await appendAudit(tx, { projectId: locked.project.id, taskId: locked.task.id, actor: server }, auditEvent('rebase.verified', { runId: ctx.run.id, pr: locked.task.prNumber, approvedHeadSha: locked.task.approvedHeadSha, headSha: report.headSha, conflictedFiles: report.conflictedFiles }))
    return { comment: await addComment(tx, locked.task.id, { body: `Trivial rebase verified without review: only the conflicted files changed (${files}) and no project doc changed on the base. The approval carried over to ${report.headSha}.`, pinned: false }, server) }
  }

  // D19: a spike's findings are its deliverable. Like a submission they
  // need evidence for every criterion, but nothing is pushed or opened on
  // GitHub: the findings go on the task as a comment and the reviewer judges
  // them. The submission is marked by this run, in place of a commit, so
  // each report gets its own review.
  async #reportFindings(ctx: RunContext, report: OutcomeReport) {
    const { db } = this.#c.d
    const task = ctx.task!
    const { missing } = await evidenceState(db, task)
    if (missing.length > 0) {
      throw new ToolError(`Not submitted. No evidence yet for: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}. Attach it and report again.`)
    }
    const marker = findingsMarker(ctx.run.id)
    const posted = await db.transaction(async (tx) => {
      const locked = await this.#c.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, server, { event: 'findings_reported', runId: ctx.run.id, headSha: marker })
      await tx.update(tasks).set({ headSha: marker }).where(eq(tasks.id, task.id))
      const note = await this.#c.ending.postNote(tx, ctx, report.note!)
      const findings = await addComment(tx, task.id, { body: `## Findings\n\n${report.summary.trim()}`, pinned: false }, this.#c.runs.actor(ctx))
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'findings_reported', summary: report.summary })
      return [note, findings]
    })
    for (const comment of posted) this.#c.d.events.publish({ type: 'comment.created', comment })
    this.#c.ending.finished(ctx, 'Findings accepted for review', { handoff: true })
    return { ok: true, message: 'Your findings are on the task and go to the reviewer next. You can stop now.' }
  }

  // D20: a new design version at the commit the runner just pushed. The
  // bundle must be a sound archive with index.html at its root so the
  // preview can serve it.
  async submitDesign(ctx: RunContext, input: unknown) {
    const { db, github, blobs } = this.#c.d
    const task = ctx.task!
    if (task.type !== 'design') throw new ToolError('Only a design task submits a design')
    const parsed = designSchema.safeParse(input)
    if (!parsed.success) throw new ToolError(`Not submitted. ${parsed.error.issues.map(i => i.message).join('; ')}.`)
    const submission = parsed.data
    const bundle = Buffer.from(submission.bundle.dataBase64, 'base64')
    const shots = submission.screenshots.map(s => ({ ...s, data: Buffer.from(s.dataBase64, 'base64') }))
    if (bundle.length + shots.reduce((n, s) => n + s.data.length, 0) > MAX_DESIGN_BYTES) throw new ToolError('Not submitted. A design version is limited to 25 MB.')
    const problem = bundleProblem(bundle)
    if (problem) throw new ToolError(`Not submitted. ${problem}`)
    const head = await github.branchHead(ctx.project!.repository, task.branch!)
    if (head !== submission.headSha) throw new ToolError(`Not submitted. The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${submission.headSha}. Try again.`)

    const bundleBlob = await blobs.put(bundle)
    const specBlob = await blobs.put(Buffer.from(submission.spec))
    const screenshots: { blob: string, fileName: string, contentType: string }[] = []
    for (const shot of shots) screenshots.push({ blob: await blobs.put(shot.data), fileName: shot.fileName, contentType: shot.contentType })
    const version = await db.transaction(async (tx) => {
      await this.#c.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      const existing = await tx.select({ version: designVersions.version, status: designVersions.status }).from(designVersions).where(eq(designVersions.taskId, task.id))
      const [row] = await tx.insert(designVersions).values({
        taskId: task.id, version: nextDesignVersion(existing), bundleBlob, specBlob, screenshots, branch: task.branch!, commitSha: submission.headSha
      }).returning()
      await appendAudit(tx, { projectId: ctx.run.projectId, taskId: task.id, actor: this.#c.runs.actor(ctx) }, auditEvent('design.submitted', { runId: ctx.run.id, version: row!.version, headSha: submission.headSha, screenshots: screenshots.length }))
      return row!
    })
    return {
      ok: true,
      version: version.version,
      commitSha: version.commitSha,
      message: `Design v${version.version} recorded at ${version.commitSha.slice(0, 10)}. Attach evidence for every criterion, then call report_outcome with outcome design_submitted.`
    }
  }

  // D20: the designer's outcome on a design task. Accepted only when a
  // version exists for the branch's current commit and every criterion has
  // evidence. Nothing is opened on GitHub.
  async #reportDesign(ctx: RunContext, report: OutcomeReport) {
    const { db, github } = this.#c.d
    const task = ctx.task!
    if (!report.headSha) throw new ToolError('There is no commit to submit. Commit your work, call submit_design, then report again.')
    const head = await github.branchHead(ctx.project!.repository, task.branch!)
    const [version] = await db.select().from(designVersions)
      .where(and(eq(designVersions.taskId, task.id), eq(designVersions.commitSha, report.headSha))).orderBy(desc(designVersions.version)).limit(1)
    const { missing } = await evidenceState(db, task)
    const problems = [
      head !== report.headSha ? `The branch on GitHub is at ${head ?? 'nothing'}, not your commit ${report.headSha}.` : '',
      !version ? `No design version was submitted at your latest commit ${report.headSha}: call submit_design first.` : '',
      missing.length > 0 ? `No evidence yet for: ${missing.map(c => `[${c.id}] ${c.text}`).join('; ')}.` : ''
    ].filter(Boolean)
    if (problems.length > 0) throw new ToolError(`Not submitted. ${problems.join(' ')} Fix this and report again.`)

    const comment = await db.transaction(async (tx) => {
      const locked = await this.#c.runs.lockHeld(tx, ctx, 'This run lost its lease while submitting. Stop working.')
      await applyTransition(tx, locked.task, locked.project, {
        type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true
      }, server, { event: 'design_submitted', runId: ctx.run.id, headSha: report.headSha, version: version!.version })
      await tx.update(tasks).set({ headSha: report.headSha }).where(eq(tasks.id, task.id))
      const comment = await this.#c.ending.postNote(tx, ctx, report.note!)
      await this.#c.ending.endRunIn(tx, ctx, { state: 'completed', outcome: 'design_submitted', summary: report.summary, headSha: report.headSha })
      return comment
    })
    this.#c.d.events.publish({ type: 'comment.created', comment })
    this.#c.ending.finished(ctx, `Design v${version!.version} submitted for review`, { handoff: true })
    return { ok: true, message: `Design v${version!.version} goes to the reviewer next, then to the human. You can stop now.` }
  }

  #prBody(ref: string, title: string, summary: string, criteria: { id: string, text: string, checkedByHuman: boolean }[], attached: { criterionId: string | null }[]): string {
    const link = `${this.#c.d.publicUrl}/tasks/${ref}`
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
