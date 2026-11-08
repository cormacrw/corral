import type { PlanThreadItem } from '@corral/contracts'
import { useInboxView } from '~/features/inbox/composables/useInboxView'
import { usePlanThread } from '~/features/plan/composables/usePlanThread'
import { usePlanThreadScroll } from '~/features/plan/composables/usePlanThreadScroll'
import { previousPlan } from '~/features/plan/utils/plan-versions'
import { plural } from '~/utils/labels'

// A Plan thread in the Inbox, on either layout (design/inbox.md#plan-threads):
// only what needs the human, the question or the plan. Approving resolves the
// item and moves on to the next one, as deleting does.
export function useInboxPlanThread(item: () => PlanThreadItem) {
  const { moveToNext, deleteThread } = useInboxView()
  const thread = usePlanThread(() => item().sessionId, {
    draftKey: id => `inbox:${id}`,
    snapshotRunId: () => item().activeRunId,
    holdsInbox: true,
    moveOn: () => moveToNext
  })
  // The plan itself, for View plan and approving; the item only has its summary
  const plans = computed(() => thread.session.value?.plans ?? [])
  const plan = computed(() => plans.value.find(p => p.id === (item().plan?.id ?? item().planId)) ?? null)
  const previous = computed(() => previousPlan(plans.value, plan.value))
  const counts = computed(() => {
    const p = item().plan
    return p ? `Plan v${p.version} · ${plural(p.epicCount, 'epic')} · ${plural(p.taskCount, 'task')}` : ''
  })

  // A question is answered in its card: an option, or Other… written there and
  // sent with Submit
  const writing = ref(false)
  const answer = ref('')
  watch(() => item().id, () => {
    writing.value = false
    answer.value = ''
  })
  async function submitAnswer() {
    const message = answer.value.trim()
    if (!message || !await thread.quick(message)) return
    answer.value = ''
    writing.value = false
  }

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
  return { ...thread, ...scroll, plan, previous, counts, writing, answer, submitAnswer, composer, remove: () => deleteThread(item()) }
}
