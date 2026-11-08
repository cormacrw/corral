// A deploy's release notes, written by the PM after it ships (D16)
export const DEPLOYMENT_NOTES_STATUSES = ['pending', 'ready', 'failed'] as const
export type DeploymentNotesStatus = typeof DEPLOYMENT_NOTES_STATUSES[number]

export interface DeploymentCommit {
  sha: string
  subject: string
}
