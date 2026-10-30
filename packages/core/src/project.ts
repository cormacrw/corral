// Project settings (D13, design/project-settings.md)

// Each project's task ID prefix: 2–5 letters, unique across projects
export const PROJECT_PREFIX_PATTERN = /^[A-Z]{2,5}$/

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const
export type MergeMethod = typeof MERGE_METHODS[number]

// How an epic's tasks reach the target branch (D23): through the epic
// branch with only flagged tasks seen by the human, through it with every
// task seen, or straight into the target branch as before
export const EPIC_REVIEW_MODES = ['epic', 'each_task', 'direct'] as const
export type EpicReviewMode = typeof EPIC_REVIEW_MODES[number]

// Where an epic's PR is in its review (D23); null on the epic until it opens
export const EPIC_REVIEW_STATES = ['open', 'in_review', 'human_review', 'changes_requested', 'ready_to_merge', 'merged'] as const
export type EpicReviewState = typeof EPIC_REVIEW_STATES[number]
