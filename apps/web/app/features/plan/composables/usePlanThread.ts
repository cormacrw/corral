import { computed, ref, watch } from 'vue'
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { Plan } from '@corral/contracts'
import { approvedPlanSummary, errorText, type PlanApprovalTarget } from '@corral/core'
import { useDraft, writeDraft } from '~/composables/useDraft'
import { holdsInbox } from '~/queries/inbox'
import { approvePlan, sendPlanMessage, usePlanStarts, useThreadSession } from '~/queries/plan'
import { runTranscriptQuery } from '~/queries/runs'
import { withoutMessages } from '~/features/runs/utils/tool-steps'
import { latestPlan, previousPlan } from '~/features/plan/utils/plan-versions'
import { usePlanRunner } from '~/features/plan/composables/usePlanRunner'

interface PlanThreadOptions {
  // Where the thread's draft is kept: Plan and the Inbox keep theirs apart
  draftKey?: (id: string) => string
  // The PM's turn as the screen knew it before the session loaded (an Inbox item)
  snapshotRunId?: () => string | null
  // Approving resolves the selected Inbox item (useHeldInbox)
  holdsInbox?: boolean
  // Where the screen goes once a plan is approved. A screen that moves on
  // confirms with a toast and closes the plan sheet or flyout first; without
  // one it stays on the session, where the flyout shows the approved plan.
  moveOn?: () => (() => unknown) | null
}

// One Plan thread, wherever it shows (design/plan.md, design/inbox.md): the
// saved session or the start still in flight, its plans, the PM's turn as it
// happens, and what the human can do: reply, answer with one tap, approve.
// Reading it is useThreadSession's. Each action guards against the thread
// changing while its request is in flight.
export function usePlanThread(id: () => string, options: PlanThreadOptions = {}) {
  const draftKey = options.draftKey ?? ((session: string) => `plan:${session}`)
  const pending = usePlanStarts()
  const threads = usePlanThreads()
  const flyout = useTaskFlyout()
  const toast = useToast()
  const { pm, offline } = usePlanRunner()

  const starting = computed(() => pending.entries.value[id()])
  const accepted = computed(() => !starting.value || starting.value.state === 'accepted')
  const detail = useThreadSession(id, () => accepted.value)
  const session = computed(() => starting.value && !accepted.value ? starting.value.session : detail.data.value ?? starting.value?.session ?? null)
  const waitingForStart = computed(() => Boolean(starting.value && starting.value.state !== 'failed' && !session.value?.activeRunId && !session.value?.messages.some(m => m.role === 'pm')))
  const error = computed(() => detail.error.value?.message ?? null)
  const latest = computed(() => latestPlan(session.value?.plans ?? []))
  const previous = computed(() => previousPlan(session.value?.plans ?? [], latest.value))

  // Answering starts a PM turn. What the screen was shown can be a snapshot
  // from before it, so the session decides once it's loaded.
  const activeRunId = computed(() => session.value?.activeRunId === undefined ? options.snapshotRunId?.() ?? null : session.value.activeRunId)
  const transcript = useQuery(computed(() => ({ ...runTranscriptQuery(activeRunId.value ?? ''), enabled: Boolean(activeRunId.value) })))
  // What the turn has posted to the log already (a question, a plan) isn't repeated in its transcript
  const repliesOf = (runId: string) => session.value?.messages.filter(m => m.role === 'pm' && m.runId === runId).map(m => m.text) ?? []
  const liveEvents = computed(() => activeRunId.value ? withoutMessages(transcript.data.value ?? [], repliesOf(activeRunId.value)) : [])

  const sending = useMutation(sendPlanMessage)
  const approval = useMutation(options.holdsInbox ? { ...approvePlan, ...holdsInbox } : approvePlan)
  const text = useDraft(() => draftKey(id()))
  const taskRef = ref<string | null>(null)
  const busy = ref(false)
  const approving = ref<{ planId: string, to: PlanApprovalTarget } | null>(null)
  // Sent, and its turn not seen yet
  const sent = ref(false)
  let sentAt = 0
  watch(id, () => {
    taskRef.value = null
    busy.value = false
    approving.value = null
    sent.value = false
  })
  // The PM answered, or the turn ended with no run left and nothing new to say
  watch(() => [session.value?.messages.findLast(m => m.role === 'pm')?.id, latest.value?.id], () => {
    sent.value = false
  })
  watch([activeRunId, detail.dataUpdatedAt], ([run, updated]) => {
    if (sent.value && !run && updated >= sentAt) sent.value = false
  })
  const working = computed(() => sent.value || Boolean(activeRunId.value))
  const cantApprove = computed(() => Boolean(starting.value && (!accepted.value || waitingForStart.value)) || busy.value || approving.value !== null || working.value)
  const cantSend = computed(() => cantApprove.value || offline.value)

  // Resolves false when not sent, so the composer keeps its images
  async function send(message: string): Promise<boolean> {
    if (cantSend.value) return false
    const sendingTo = id()
    busy.value = true
    try {
      await sending.mutateAsync({ id: sendingTo, text: message, taskRef: taskRef.value ?? undefined })
      threads.add(sendingTo)
      writeDraft(draftKey(sendingTo), '')
      if (id() === sendingTo) {
        text.value = ''
        taskRef.value = null
        sentAt = Date.now()
        sent.value = true
      }
      return true
    } catch (e) {
      toast.add({ title: 'Could not send', description: errorText(e), color: 'error' })
      return false
    } finally {
      if (id() === sendingTo) busy.value = false
    }
  }

  // One-tap answers send straight away. An answer leaves the draft and
  // attached task alone; Grill me sends the draft.
  async function quick(message: string, keepDraft = true): Promise<boolean> {
    const sendingTo = id()
    const draft = text.value
    const task = taskRef.value
    if (keepDraft) taskRef.value = null
    const done = await send(message)
    if (keepDraft && id() === sendingTo) {
      taskRef.value = task
      if (done) text.value = draft
    }
    return done
  }

  // A failed approval stays put, with the sheet open
  async function approve(plan: Pick<Plan, 'id'>, to: PlanApprovalTarget): Promise<boolean> {
    if (cantApprove.value) return false
    const approvingIn = id()
    approving.value = { planId: plan.id, to }
    let approved: Plan
    try {
      approved = await approval.mutateAsync({ planId: plan.id, to })
    } catch (e) {
      toast.add({ title: 'Could not approve', description: errorText(e), color: 'error' })
      return false
    } finally {
      if (id() === approvingIn) approving.value = null
    }
    const moveOn = options.moveOn?.()
    if (moveOn) {
      toast.add({ title: 'Plan approved', description: approvedPlanSummary(approved.tasks), color: 'success' })
      await flyout.close()
      await moveOn()
    }
    return true
  }

  return {
    pending, starting, detail, session, accepted, waitingForStart, error, latest, previous, activeRunId, liveEvents,
    pm, offline, text, taskRef, busy, approving, working, cantApprove, cantSend, send, quick, approve
  }
}
