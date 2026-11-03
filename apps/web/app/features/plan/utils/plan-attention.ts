import type { PlanSession } from '@corral/contracts'

// Why an open thread wants the human, if it does
export function planAttention(session: Pick<PlanSession, 'status'> & { unread?: boolean }): string | null {
  if (session.status === 'needs_approval') return 'Needs approval'
  if (session.status === 'question') return 'Question'
  if (session.status === 'failed') return 'Failed turn'
  return session.unread ? 'Unread reply' : null
}

// The badge for a thread's status; a thread with nothing pending has none
export const PLAN_STATUS_BADGE = {
  needs_approval: { label: 'Needs approval', color: 'primary' },
  question: { label: 'Question', color: 'info' },
  failed: { label: 'Failed', color: 'error' }
} as const
