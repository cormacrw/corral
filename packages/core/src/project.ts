// Project settings (D13, design/project-settings.md)

// Each project's task ID prefix: 2–5 letters, unique across projects
export const PROJECT_PREFIX_PATTERN = /^[A-Z]{2,5}$/

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const
export type MergeMethod = typeof MERGE_METHODS[number]
