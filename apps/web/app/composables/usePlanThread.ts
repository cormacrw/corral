import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { PlanThreadItem } from '@corral/contracts'
import { computed, ref, watch } from 'vue'
import { useDraft } from '~/composables/useDraft'
import { holdsInbox } from '~/queries/inbox'
import { approvePlan, markPlanRead, planSessionQuery, sendPlanMessage } from '~/queries/plan'
import { plural } from '~/utils/labels'

// A Plan thread in the Inbox, on either layout (design/inbox.md#plan-threads):
// the session behind the item, and whether Juno's turn leaves it open to act on.
export function usePlanThread(item: () => PlanThreadItem) {
  const shell = useShell()
  const threads = usePlanThreads()
  const client = useQueryClient()
  const sending = useMutation(sendPlanMessage)
  const approval = useMutation({ ...approvePlan, ...holdsInbox })
  // The plan itself, for View plan and approving; the item only has its summary
  const detail = useQuery(computed(() => planSessionQuery(item().sessionId)))
  const plans = computed(() => detail.data.value?.plans ?? [])
  const plan = computed(() => plans.value.find(p => p.id === (item().plan?.id ?? item().planId)) ?? null)
  const previous = computed(() => plan.value ? plans.value.find(p => p.version === plan.value!.version - 1) ?? null : null)
  const counts = computed(() => {
    const p = item().plan
    return p ? `Plan v${p.version} · ${plural(p.epicCount, 'epic')} · ${plural(p.taskCount, 'task')}` : ''
  })
  watch([() => item().sessionId, () => detail.data.value?.unread], ([id, unread]) => {
    if (unread) markPlanRead(client, id)
  }, { immediate: true })

  const text = useDraft(() => `inbox:${item().id}`)
  const busy = ref(false)
  const offline = computed(() => shell.loaded && !shell.runner?.online)
  // Answering starts a PM turn. The thread leaves Needs you while it runs, and
  // the item the Inbox keeps open is then a snapshot, so the session decides.
  const activeRunId = computed(() => detail.data.value?.activeRunId === undefined ? item().activeRunId : detail.data.value.activeRunId)
  const sent = ref(false)
  let sentAt = 0
  watch(() => [item().question?.text, item().plan?.id, item().reply], () => {
    sent.value = false
  })
  // A turn can fail without a new message, and no run left means nothing to wait for
  watch([activeRunId, detail.dataUpdatedAt], ([run, updated]) => {
    if (sent.value && !run && updated >= sentAt) sent.value = false
  })
  const working = computed(() => sent.value || Boolean(activeRunId.value))
  const cantSend = computed(() => busy.value || working.value || offline.value)

  // Throws, so each layout reports a failure its own way
  async function send(message: string) {
    busy.value = true
    try {
      await sending.mutateAsync({ id: item().sessionId, text: message })
      threads.add(item().sessionId)
      sentAt = Date.now()
      sent.value = true
      text.value = ''
      void detail.refetch()
    } finally {
      busy.value = false
    }
  }

  return { approval, detail, plan, previous, counts, text, busy, offline, working, cantSend, send }
}
