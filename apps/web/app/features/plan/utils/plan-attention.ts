import type { PlanSession } from '@corral/contracts'

export function planAttention(session: Pick<PlanSession, 'status'> & { unread?: boolean }): string | null {
  if (session.status === 'needs_approval') return 'Needs approval'
  if (session.status === 'question') return 'Question'
  if (session.status === 'failed') return 'Failed turn'
  return session.unread ? 'Unread reply' : null
}

export const PLAN_STATUS_BADGE = {
  needs_approval: { label: 'Needs approval', color: 'primary' },
  question: { label: 'Question', color: 'info' },
  failed: { label: 'Failed', color: 'error' }
} as const
