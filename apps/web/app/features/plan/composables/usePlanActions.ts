import { errorMessage } from '~/lib/errors'
import { computed, ref, watch } from 'vue'
import { useMutation } from '@tanstack/vue-query'
import type { Plan } from '@corral/contracts'
import { approvePlan as approvePlanMutation, sendPlanMessage } from '~/queries/plan'
import { useDraft, writeDraft } from '~/composables/useDraft'
import { approvePlan } from '~/features/plan/utils/plan-approval'
import type { PlanSessionState } from '~/features/plan/composables/usePlanSession'

// What a Plan conversation can do: reply, answer with one tap and approve.
// Each guards against the thread changing while its request is in flight.
export function usePlanActions(id: () => string, state: PlanSessionState, runnerOffline: () => boolean) {
  const router = useRouter()
  const threads = usePlanThreads()
  const flyout = useTaskFlyout()
  const toast = useToast()
  const device = useDevice()
  const sending = useMutation(sendPlanMessage)
  const approval = useMutation(approvePlanMutation)
  const { session, starting, waitingForStart } = state

  const text = useDraft(() => `plan:${id()}`)
  const taskRef = ref<string | null>(null)
  const busy = ref(false)
  const approving = ref<string | null>(null)
  watch(id, () => {
    taskRef.value = null
    busy.value = false
    approving.value = null
  })

  const cantApprove = computed(() => Boolean(starting.value && (starting.value.state !== 'accepted' || waitingForStart.value)) || busy.value || approving.value !== null || Boolean(session.value?.activeRunId))
  const cantSend = computed(() => cantApprove.value || runnerOffline())

  // Resolves false when not sent, so the composer keeps its images
  async function send(message: string): Promise<boolean> {
    if (!session.value || cantSend.value) return false
    const sendingTo = session.value.id
    busy.value = true
    try {
      await sending.mutateAsync({ id: sendingTo, text: message, taskRef: taskRef.value ?? undefined })
      threads.add(sendingTo)
      writeDraft(`plan:${sendingTo}`, '')
      if (session.value?.id === sendingTo) {
        text.value = ''
        taskRef.value = null
      }
      return true
    } catch (e) {
      toast.add({ title: 'Could not send', description: errorMessage(e), color: 'error' })
      return false
    } finally {
      if (id() === sendingTo) busy.value = false
    }
  }

  // One-tap answers and Grill me send straight away. An answer leaves the
  // draft and attached task alone; Grill me sends the draft.
  async function quick(message: string, keepDraft = true) {
    const sendingTo = id()
    const draft = text.value
    const task = taskRef.value
    if (keepDraft) taskRef.value = null
    const sent = await send(message)
    if (keepDraft && id() === sendingTo) {
      taskRef.value = task
      if (sent) text.value = draft
    }
  }

  async function approve(plan: Plan, to: 'ready' | 'backlog') {
    if (cantApprove.value) return false
    const approvingIn = id()
    approving.value = plan.id
    try {
      return await approvePlan(plan, to, {
        approve: (planId, to) => approval.mutateAsync({ planId, to }),
        toast,
        mobile: device.isMobile.value,
        closeSheet: flyout.close,
        push: path => router.push(path)
      })
    } catch (e) {
      toast.add({ title: 'Could not approve', description: errorMessage(e), color: 'error' })
      return false
    } finally {
      if (id() === approvingIn) approving.value = null
    }
  }

  return { text, taskRef, busy, approving, cantApprove, cantSend, send, quick, approve }
}
