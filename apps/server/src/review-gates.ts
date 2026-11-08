import { requiresHumanReview, type EpicReviewMode, type TaskType } from '@corral/core'

// What counts as lowering a gate (D30), shared by the PM's edits and plan
// revisions so neither can take a route the other refuses. Each lowered gate
// comes back in the words a confirm card and a refusal both use.

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

export interface HeldCriterion { id: string, text: string, checkedByHuman: boolean }
export interface NextCriterion { id?: string | undefined, text: string, checkedByHuman?: boolean | undefined }

// The stored mode `epic` is review at the level of the task with subtasks
export function reviewModeName(mode: EpicReviewMode | undefined): string | undefined {
  return mode === 'epic' ? 'task' : mode
}

export interface TaskGates {
  type: TaskType
  humanReview: boolean
  paused: boolean
  // The review mode of the task it's a subtask of
  mode: EpicReviewMode | null
  criteria: readonly HeldCriterion[]
}

export interface TaskGateChange {
  type?: TaskType | undefined
  humanReview?: boolean | undefined
  paused?: boolean | undefined
  // Set when it moves: the review mode of where it goes
  movesTo?: { mode: EpicReviewMode | null }
  acceptanceCriteria?: readonly NextCriterion[] | undefined
}

export function taskGatesLowered(task: TaskGates, change: TaskGateChange): string[] {
  const lowered: string[] = []
  if (change.paused === false && task.paused) lowered.push('resume the paused task')
  const next = { type: change.type ?? task.type, humanReview: change.humanReview ?? task.humanReview }
  if (requiresHumanReview(task.type, task.humanReview) && !requiresHumanReview(next.type, next.humanReview)) lowered.push('turn off human review')
  if (change.movesTo && taskReview(next, change.movesTo.mode) < taskReview(task, task.mode)) lowered.push('move it somewhere with less human review')
  const criteria = change.acceptanceCriteria
  if (criteria) {
    for (const lost of lostHumanChecks(task.criteria, criteria)) {
      lowered.push(criteria.some(c => c.id === lost.id) ? `stop requiring a human for "${lost.text}"` : `remove the human check "${lost.text}"`)
    }
    for (const held of task.criteria.filter(c => c.checkedByHuman)) {
      const reworded = criteria.find(c => c.id === held.id && c.text !== held.text && c.checkedByHuman !== false)
      if (reworded) lowered.push(`reword the human check "${held.text}" to "${reworded.text}"`)
    }
  }
  return lowered
}

// A new task left without human review where its project reviews by default
export function newTaskLowersReview(project: { humanReviewDefault: boolean }, task: { type: TaskType, humanReview?: boolean | undefined }): boolean {
  return task.humanReview === false && project.humanReviewDefault && !requiresHumanReview(task.type, false)
}

interface ProjectGates {
  requiredChecks: string[]
  humanReviewDefault: boolean
  epicReviewModeDefault: EpicReviewMode
  reviewRoundCap: number
  failedRunCap: number
  paused: boolean
}

export function projectGatesLowered(project: ProjectGates, change: { [K in keyof ProjectGates]?: ProjectGates[K] | undefined }): string[] {
  const lowered: string[] = []
  const removed = change.requiredChecks ? project.requiredChecks.filter(check => !change.requiredChecks!.includes(check)) : []
  if (removed.length) lowered.push(`stop requiring ${removed.join(', ')}`)
  if (change.humanReviewDefault === false && project.humanReviewDefault) lowered.push('turn off human review by default')
  if (lowersMode(project.epicReviewModeDefault, change.epicReviewModeDefault)) lowered.push(`change the default task review mode from ${reviewModeName(project.epicReviewModeDefault)} to ${reviewModeName(change.epicReviewModeDefault)}`)
  if (change.reviewRoundCap !== undefined && change.reviewRoundCap > project.reviewRoundCap) lowered.push(`raise the review round cap from ${project.reviewRoundCap} to ${change.reviewRoundCap}`)
  if (change.failedRunCap !== undefined && change.failedRunCap > project.failedRunCap) lowered.push(`raise the failed run cap from ${project.failedRunCap} to ${change.failedRunCap}`)
  if (change.paused === false && project.paused) lowered.push('resume the paused project, which restarts its runs and merges')
  return lowered
}

// The project settings the gates above cover
export const PROJECT_GATES = ['humanReviewDefault', 'epicReviewModeDefault', 'reviewRoundCap', 'failedRunCap', 'paused'] as const

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
