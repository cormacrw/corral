import { computed, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { markPlanRead, planSessionQuery } from '~/queries/plan'
import { runTranscriptQuery } from '~/queries/runs'
import { withoutMessages } from '~/features/runs/utils/tool-steps'
import { latestPlan, previousPlan } from '~/features/plan/utils/plan-versions'

// One Plan conversation's state: the saved session or the start still in
// flight, its plans and the PM's turn as it happens. `onRead` runs when an
// unread session is marked read.
export function usePlanSession(id: () => string, onRead: () => void) {
  const pending = usePendingPlan()
  const client = useQueryClient()
  const starting = computed(() => pending.entries.value[id()])
  const detail = useQuery(computed(() => ({
    ...planSessionQuery(id()),
    enabled: !starting.value || starting.value.state === 'accepted'
  })))
  const session = computed(() => starting.value && starting.value.state !== 'accepted' ? starting.value.session : detail.data.value ?? starting.value?.session ?? null)
  watch(() => session.value?.unread, (unread) => {
    if (unread) {
      markPlanRead(client, id())
      onRead()
    }
  }, { immediate: true })
  const accepted = computed(() => !starting.value || starting.value.state === 'accepted')
  const waitingForStart = computed(() => Boolean(starting.value && starting.value.state !== 'failed' && !session.value?.activeRunId && !session.value?.messages.some(m => m.role === 'pm')))
  const error = computed(() => detail.error.value?.message ?? null)

  const latest = computed(() => latestPlan(session.value?.plans ?? []))
  const previous = computed(() => previousPlan(session.value?.plans ?? [], latest.value))

  // The PM's turn as it happens: the saved part, then live run.events
  const activeRunId = computed(() => session.value?.activeRunId ?? null)
  const transcript = useQuery(computed(() => ({ ...runTranscriptQuery(activeRunId.value ?? ''), enabled: Boolean(activeRunId.value) })))
  // What the turn has posted to the log already (a question, a plan) isn't repeated in its transcript
  const repliesOf = (runId: string) => session.value?.messages.filter(m => m.role === 'pm' && m.runId === runId).map(m => m.text) ?? []
  const liveEvents = computed(() => activeRunId.value ? withoutMessages(transcript.data.value ?? [], repliesOf(activeRunId.value)) : [])

  return { pending, starting, detail, session, accepted, waitingForStart, error, latest, previous, activeRunId, liveEvents }
}

export type PlanSessionState = ReturnType<typeof usePlanSession>
