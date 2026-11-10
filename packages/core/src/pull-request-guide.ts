// A guided review of a PR (COR-525): the runner's small model orders the PR's
// hunks into steps that tell the story of the change.
export const PULL_REQUEST_GUIDE_STATUSES = ['generating', 'ready', 'failed'] as const
export type PullRequestGuideStatus = typeof PULL_REQUEST_GUIDE_STATUSES[number]

interface PullRequestGuideHunk {
  path: string
  // The hunk's position in the file's patch: the nth `@@` block, from 0
  hunk: number
}

export interface PullRequestGuideStep {
  id: string
  title: string
  // One or two sentences tied to the task's goal or criteria
  why: string
  // The acceptance criteria this step works towards, by id
  criterionIds: string[]
  hunks: PullRequestGuideHunk[]
}
