import { requiresHumanReview, type EpicReviewMode, type TaskType } from '@corral/core'

// What counts as lowering a gate, shared by the PM's edits and plan revisions
// so neither can take a route the other refuses (D30).

// Most human review first: each_task sends every task to the human, epic only
// its epic PR, and direct leaves it to each task's flag
const REVIEW_MODE_RANK: Record<EpicReviewMode, number> = { each_task: 2, epic: 1, direct: 0 }

export function lowersMode(from: EpicReviewMode, to: EpicReviewMode | undefined): boolean {
  return to !== undefined && REVIEW_MODE_RANK[to] < REVIEW_MODE_RANK[from]
}

// How much human review a task gets from its own flag and its epic
export function taskReview(task: { type: TaskType, humanReview: boolean }, mode: EpicReviewMode | null): number {
  return requiresHumanReview(task.type, task.humanReview) ? REVIEW_MODE_RANK.each_task : REVIEW_MODE_RANK[mode ?? 'direct']
}

interface HeldCriterion { id: string, text: string, checkedByHuman: boolean }
interface NextCriterion { id?: string | undefined, text: string, checkedByHuman?: boolean | undefined }

// A task's new criteria, each with the ID of an existing one that has the same
// text, so evidence and verdicts stay attached to it. A human check whose text
// changed takes the next unmatched criterion, so rewording can't lose its flag.
export function matchCriteria(existing: readonly HeldCriterion[], criteria: readonly (string | Omit<NextCriterion, 'id'>)[]): NextCriterion[] {
  const unused = [...existing]
  const asked = criteria.map(criterion => typeof criterion === 'string' ? { text: criterion, checkedByHuman: undefined } : criterion)
  const matched = asked.map((criterion) => {
    const index = unused.findIndex(c => c.text === criterion.text)
    return index === -1 ? null : unused.splice(index, 1)[0]!
  })
  const reworded = unused.filter(c => c.checkedByHuman)
  return asked.map(({ text, checkedByHuman }, i) => {
    const held = matched[i]
    if (held) return { id: held.id, text, checkedByHuman: checkedByHuman ?? held.checkedByHuman }
    const human = reworded.shift()
    return human ? { id: human.id, text, checkedByHuman: checkedByHuman ?? true } : { text, checkedByHuman: checkedByHuman ?? false }
  })
}

// The human checks these criteria would drop or clear
export function lostHumanChecks(existing: readonly HeldCriterion[], criteria: readonly NextCriterion[]): HeldCriterion[] {
  return existing.filter(held => held.checkedByHuman && !criteria.some(c => c.id === held.id && c.checkedByHuman !== false))
}
