// A pending action is stored on its conversation message. The message owns
// the action's id, session and proposing run; this snapshot owns the inputs.
export interface PmAction {
  tool: string
  input: Record<string, unknown>
  summary: string
  status: 'pending' | 'executing' | 'confirmed' | 'cancelled' | 'failed'
  targetId: string | null
  error: string | null
  result: unknown
}
