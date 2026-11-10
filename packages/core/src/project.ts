// Project settings (D13, design/project-settings.md)

// Each project's task ID prefix: 2–5 letters, unique across projects
export const PROJECT_PREFIX_PATTERN = /^[A-Z]{2,5}$/
export const PROJECT_PREFIX_HINT = 'Use 2–5 letters, A–Z.'

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const
export type MergeMethod = typeof MERGE_METHODS[number]

// How an epic's tasks reach the target branch (D27): through the epic
// branch, reviewed by the human as a whole, or straight into the target
// branch as before. `each_task`, where the human also reviewed every task, is
// retired: it's stored only on merged epics, and nothing accepts it.
export const EPIC_REVIEW_MODES = ['epic', 'each_task', 'direct'] as const
export type EpicReviewMode = typeof EPIC_REVIEW_MODES[number]

// The review modes a project, a task or a plan may choose
export const REVIEW_MODE_CHOICES = ['epic', 'direct'] as const satisfies readonly EpicReviewMode[]
export type ReviewModeChoice = typeof REVIEW_MODE_CHOICES[number]

// Where an epic's PR is in its review (D27); null on the epic until it opens
export const EPIC_REVIEW_STATES = ['open', 'in_review', 'human_review', 'changes_requested', 'ready_to_merge', 'merged'] as const
export type EpicReviewState = typeof EPIC_REVIEW_STATES[number]
