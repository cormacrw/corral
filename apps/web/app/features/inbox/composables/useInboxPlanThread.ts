import type { PlanThreadItem } from '@corral/contracts'
import { usePlanThread } from '~/features/plan/composables/usePlanThread'
import { usePlanThreadScroll } from '~/features/plan/composables/usePlanThreadScroll'

// What a Plan thread's screen needs in the Inbox, on either layout
export function useInboxPlanThread(item: () => PlanThreadItem) {
  const thread = usePlanThread(item)
  const scroll = usePlanThreadScroll(() => {
    const { sessionId, at, question, plan, failure } = item()
    return {
      threadId: sessionId,
      messageId: question ? `${at}:${question.text}` : plan?.id ?? failure ?? undefined,
      questionId: question ? 'inbox-question' : undefined,
      revision: thread.working.value
    }
  })
  const composer = ref<{ focus: () => void } | null>(null)
  return { ...thread, ...scroll, composer }
}
