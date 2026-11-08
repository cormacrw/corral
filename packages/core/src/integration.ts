// Journaled writes to a task's shared branch (D27): integrating one
// submission, or rebasing the whole branch. An epic has one active operation
// at a time; that row is its writer lock.
export const OPERATION_KINDS = ['integrate', 'rebase'] as const
export type OperationKind = typeof OPERATION_KINDS[number]

export const OPERATION_STATES = ['pending', 'running', 'reconciling', 'succeeded', 'failed'] as const
export type OperationState = typeof OPERATION_STATES[number]

export const ACTIVE_OPERATION_STATES = ['pending', 'running', 'reconciling'] as const satisfies readonly OperationState[]
