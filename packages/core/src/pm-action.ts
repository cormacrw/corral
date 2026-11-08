export const PM_ACTION_STATUSES = ['pending', 'executing', 'confirmed', 'cancelled', 'failed'] as const
export type PmActionStatus = typeof PM_ACTION_STATUSES[number]

// A pending action is stored on its conversation message. The message owns
// the action's id, session and proposing run; this snapshot owns the inputs.
export interface PmAction {
  tool: string
  input: Record<string, unknown>
  summary: string
  status: PmActionStatus
  targetId: string | null
  error: string | null
  result: unknown
}
