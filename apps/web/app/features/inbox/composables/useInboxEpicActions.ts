import { errorMessage } from '~/lib/errors'
import type { EpicReviewActionInput, InboxActionInput } from '@corral/contracts'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { reactive } from 'vue'
import { useDraft } from '~/composables/useDraft'
import type { InboxEpicReview } from '~/features/inbox/composables/useInboxEpicReview'
import { actionOpensComposer, type InboxComposerContext } from '~/features/inbox/composables/useInboxPanel'
import type { EpicInboxItem } from '~/features/inbox/composables/useInboxView'
import { ApiError } from '~/queries/client'
import { reviewEpic } from '~/queries/epics'
import { holdsInbox } from '~/queries/inbox'
import { keys } from '~/queries/keys'
import { plural } from '~/utils/labels'

type Action = InboxActionInput['action']

const MOVED = 'This parent changed while you had it open. Check the refreshed review, then try again.'
const REFUSED: Record<string, string> = {
  epic_review_changed: MOVED,
  epic_pr_changed: 'The parent PR changed on GitHub or was closed. Check the refreshed review, then try again.',
  human_checks_unconfirmed: 'The human checks changed. Tick them on the Tasks tab, then approve.',
  epic_decision_changed: 'This decision has already been answered, or it changed. Check the refreshed item.'
}

// What the human can do with an epic in the Inbox: its owed checks, its actions
// and its composer. `gone`: the item left the Inbox while open, so nothing can be
// sent. `showTasks` opens the tab where checks are ticked.
export function useInboxEpicActions(
  props: { item: EpicInboxItem, gone?: boolean },
  { viewedHead }: Pick<InboxEpicReview, 'viewedHead'>,
  { showTasks, resolved }: { showTasks: () => void, resolved: () => void }
) {
  const client = useQueryClient()

  // Local to the item, like task human checks: the server wants them on approval
  const confirmedCriteria = ref<string[]>([])
  const confirmedTasks = ref<string[]>([])
  // A tick vouches for what was on screen, so a new head or changed checks need
  // fresh ones. The item's tasks say what's owed, whether or not the review loaded.
  const owedTasks = computed(() => props.item.type === 'epic_review' ? props.item.tasks : [])
  const obligations = computed(() => owedTasks.value.reduce((n, t) => n + t.humanChecks.length + (t.humanReview ? 1 : 0), 0))
  const confirmed = computed(() => owedTasks.value.reduce((n, t) => n + t.humanChecks.filter(id => confirmedCriteria.value.includes(id)).length + (t.humanReview && confirmedTasks.value.includes(t.task.id) ? 1 : 0), 0))
  const vouchedFor = computed(() => JSON.stringify([props.item.id, viewedHead.value, owedTasks.value.map(t => [
    t.task.id, t.humanReview, t.humanChecks, t.task.acceptanceCriteria.filter(c => t.humanChecks.includes(c.id)).map(c => c.text)
  ])]))
  watch(vouchedFor, () => {
    confirmedCriteria.value = []
    confirmedTasks.value = []
  })

  const reviewing = useMutation({ ...reviewEpic, ...holdsInbox })
  const action = ref<Action | null>(null)
  const refused = ref<string | null>(null)
  // A draft, so what was typed outlives the panel
  const draftKey = computed(() => `inbox:${props.item.id}`)
  const text = useDraft(draftKey)

  // Resolves false when not sent, so the composer keeps what was typed
  async function send(input: EpicReviewActionInput): Promise<boolean> {
    refused.value = null
    try {
      await reviewing.mutateAsync({ id: props.item.epicId, input })
      text.value = ''
      resolved()
      return true
    } catch (e) {
      const stale = e instanceof ApiError && e.status === 409
      const constraint = stale ? (e.body as { constraint?: string } | null)?.constraint : undefined
      refused.value = (constraint && REFUSED[constraint]) ?? (errorMessage(e))
      if (constraint === 'human_checks_unconfirmed') showTasks()
      if (stale) await Promise.all([client.invalidateQueries({ queryKey: keys.inbox() }), client.invalidateQueries({ queryKey: keys.epics.detail(props.item.epicId) })])
      return false
    }
  }

  function approve() {
    const left = obligations.value - confirmed.value
    if (left > 0) {
      showTasks()
      refused.value = `${plural(left, 'human check')} left. Tick ${left === 1 ? 'it' : 'them'} here, then approve.`
      return Promise.resolve(false)
    }
    return send({ action: 'approve', headSha: viewedHead.value!, confirmedCriteria: confirmedCriteria.value, confirmedTasks: confirmedTasks.value })
  }
  watch(confirmed, () => {
    if (confirmed.value === obligations.value) refused.value = null
  })

  const actions = computed(() => {
    if (props.item.type === 'epic_review') {
      return [
        { value: 'approve', label: 'Approve parent', icon: 'i-hugeicons-tick-02' },
        { value: 'request_changes', label: 'Request changes', icon: 'i-hugeicons-comment-01' }
      ]
    }
    if (props.item.type !== 'epic_conflict') return []
    return props.item.decision
      ? [{ value: 'clarify', label: 'Answer in your own words', icon: 'i-hugeicons-arrow-turn-backward' }]
      : [{ value: 'retry', label: 'Retry', icon: 'i-hugeicons-redo-02' }]
  })

  async function act(value: Action): Promise<boolean> {
    refused.value = null
    action.value = value
    if (actionOpensComposer(value)) return false
    const sent = value === 'approve' ? await approve() : await send({ action: 'rebase', headSha: viewedHead.value! })
    action.value = null
    return sent
  }
  // Only an action the human chose sends anything
  function submit(message: string) {
    if (action.value === 'clarify') return send({ action: 'decide', headSha: viewedHead.value!, text: message })
    if (action.value === 'request_changes') return send({ action: 'request_changes', headSha: viewedHead.value!, text: message })
    return Promise.resolve(false)
  }

  const ctx: InboxComposerContext = reactive({
    item: computed(() => props.item), taskLoading: false, taskLoadFailed: false, actions, action,
    resolveTo: 'in_progress' as const, text, draftKey,
    busy: computed(() => reviewing.isPending.value || !!props.gone),
    actionError: computed(() => props.gone ? MOVED : refused.value),
    placeholder: computed(() => action.value === 'clarify' ? 'Your answer' : 'What should change? It becomes a fix task in the parent'),
    submitLabel: computed(() => action.value === 'clarify' ? 'Send answer' : 'Request changes'),
    needsText: true,
    composerChosen: computed(() => action.value !== null && actionOpensComposer(action.value)),
    submit, act,
    setAction: (value: Action | null) => {
      action.value = value
      refused.value = null
    },
    // Closes the composer, and on a phone a draft alone would keep it open
    cancelAction: () => {
      action.value = null
      refused.value = null
      text.value = ''
    },
    setText: (value: string) => {
      text.value = value
    },
    setResolveTo: () => {}
  })

  return { ctx, confirmedCriteria, confirmedTasks, obligations, confirmed }
}
