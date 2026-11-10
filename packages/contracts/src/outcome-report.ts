import { FINDING_LEVELS, REBASE_REVIEWS, RUN_OUTCOMES, REVIEW_VERDICTS, type EpicReviewFinding, type ReviewVerdict } from '@corral/core'
import { z } from 'zod'

// What a run reports through report_outcome, and how the server reads it.

// What an agent can report. `rate_limited` comes from the run's exit, never from
// the agent.
const REPORTED_OUTCOMES = z.enum(RUN_OUTCOMES).exclude(['rate_limited'])
const NON_REVIEW_OUTCOMES = REPORTED_OUTCOMES.exclude([...REVIEW_VERDICTS])
const REVIEW_OUTCOMES = z.enum(REVIEW_VERDICTS)
const unknownOutcome = `must be one of ${REPORTED_OUTCOMES.options.join(', ')}`
const criterionVerdict = z.object({ criterionId: z.string(), met: z.boolean(), note: z.string().default('') })
const missingCriteria = 'Give a verdict for every acceptance criterion'

// What an epic rebase's developer or reviewer asks the human when keeping both
// sides would mean choosing product behaviour (COR-291)
const epicDecisionInput = z.object({
  question: z.string().trim().min(1).describe('One focused question for the human'),
  bindingDecision: z.string().trim().min(1).optional().describe('The binding decision that changed, if that is the cause, e.g. "D31 in docs/decisions.md"'),
  alternatives: z.array(z.object({
    label: z.string().trim().min(1).describe('A short name for this choice'),
    effect: z.string().trim().min(1).describe('What the product does if this is chosen'),
    changesBehaviour: z.boolean().describe('True when this changes the behaviour the human approved, so the task goes back through review')
  })).min(2, 'Give at least two alternatives').max(5),
  affectedChanges: z.array(z.string().trim().min(1)).min(1, 'Name the changes affected').describe('The commits, files or tasks on each side this decision affects')
})
const epicReviewFindingSchema = z.object({
  level: z.enum(FINDING_LEVELS),
  text: z.string().trim().min(1),
  taskRefs: z.array(z.string().trim().min(1))
}) satisfies z.ZodType<EpicReviewFinding>

// The developer's one-line work note, posted as a comment on every outcome
export const MAX_NOTE_LENGTH = 200

// The report_outcome tool's arguments. MCP clients need a plain object as a
// tool's input, so this stays flat; the schemas below decide which fields each
// outcome needs.
export const reportOutcomeInput = z.object({
  outcome: REPORTED_OUTCOMES.describe('One of the outcomes listed for your role'),
  summary: z.string().trim().min(1, 'Add a summary').describe('Plain-English summary of what you did, or your question when stuck'),
  review: z.enum(REBASE_REVIEWS).optional().describe('Required for pr_rebased: trivial only for combining both sides with no new logic, renames or behaviour changes; otherwise needs_review'),
  conflictedFiles: z.array(z.string().trim().min(1)).min(1, 'conflictedFiles must contain at least one file').optional().describe('Required for pr_rebased, and for pr_updated on a task conflict fix: every file in which you resolved a conflict'),
  behaviourChanged: z.boolean().optional().describe('Required for pr_rebased, for a round started by a CI failure, and on a task fix: true if this changes what the code does; false only if approved behaviour is unchanged, so no reviewer looks at it again'),
  note: z.string().trim().optional().describe(`Developer only, required: one line of at most ${MAX_NOTE_LENGTH} characters saying what this run did, posted as a comment on the task, e.g. "Addressed review: dropped idle-thread fixture"`),
  criteria: z.array(criterionVerdict).optional().describe('Reviewer only: a verdict per acceptance criterion'),
  decision: epicDecisionInput.optional().describe('A developer fixing a task\'s PR only, with stuck: the question for the human, with alternatives and the changes affected. A conflict fix needs it; any other fix without it stops for a human to retry'),
  findings: z.array(epicReviewFindingSchema).optional().describe('Task reviewer only: integration problems, marked blocking or non_blocking, with the task refs they concern')
})

// Set by the runner, never the agent. headSha: the commit a developer's run
// pushed, or the one a reviewer's checkout is at. baseSha: where a submitted
// commit forked from its epic branch.
const reportFields = { summary: reportOutcomeInput.shape.summary, note: reportOutcomeInput.shape.note, review: reportOutcomeInput.shape.review, conflictedFiles: reportOutcomeInput.shape.conflictedFiles, behaviourChanged: reportOutcomeInput.shape.behaviourChanged, decision: reportOutcomeInput.shape.decision, headSha: z.string().optional(), baseSha: z.string().optional() }
const taskReview = <Outcome extends z.ZodType<ReviewVerdict>>(outcome: Outcome) => z.object({ ...reportFields, outcome, criteria: z.array(criterionVerdict, { error: missingCriteria }) })
const nonReview = z.object({ ...reportFields, outcome: NON_REVIEW_OUTCOMES })

export const outcomeReportSchema = z.discriminatedUnion('outcome', [
  taskReview(REVIEW_OUTCOMES), nonReview
], { error: unknownOutcome })

// D24: an approved rebase review carries the earlier approval's verdicts over,
// so it needs none of its own
export const rebaseReviewReportSchema = z.discriminatedUnion('outcome', [
  z.object({ ...reportFields, outcome: z.literal('approved'), criteria: z.array(criterionVerdict).optional() }),
  taskReview(REVIEW_OUTCOMES.exclude(['approved'])), nonReview
], { error: unknownOutcome })

// D23: an integration review judges the whole epic, not one task's criteria
export const epicReviewReportSchema = z.object({
  ...reportFields, findings: z.array(epicReviewFindingSchema).default([]), outcome: z.enum(REVIEW_VERDICTS, { error: `must be one of ${REVIEW_VERDICTS.join(', ')}` })
})

export type OutcomeReport = z.infer<typeof outcomeReportSchema> | z.infer<typeof rebaseReviewReportSchema>
export type EpicReviewReport = z.infer<typeof epicReviewReportSchema>
