// Who wrote a Plan conversation message, and what kind it is (D9, D30). Only
// the PM asks questions or reports on actions; `thread` is another PM thread.
export const PLAN_MESSAGE_KINDS_BY_ROLE = {
  human: ['message'],
  thread: ['message', 'notification'],
  pm: ['message', 'question', 'error', 'confirmation', 'action_result']
} as const
export type PlanMessageRole = keyof typeof PLAN_MESSAGE_KINDS_BY_ROLE
export type PlanMessageKind = typeof PLAN_MESSAGE_KINDS_BY_ROLE[PlanMessageRole][number]
