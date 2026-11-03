import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { Evidence, InboxActionInput, InboxItem, PmActivityItem, Review, Task, TaskInboxItem } from '@corral/contracts'
import { keys } from '~/queries/keys'
import { taskDesignsQuery, taskPullRequestQuery } from '~/queries/tasks'
import { inboxTldr } from '~/features/inbox/utils/inbox-summary'

// The Inbox message panel, Option D (design/inbox.md). useInboxItem owns the data
// and the actions; this turns them into what a reviewer decides on: the ask,
// the verdict and the artifacts.
type Action = InboxActionInput['action']
export type ResolveTo = 'backlog' | 'ready' | 'in_progress'
export type InboxPanelTab = 'overview' | 'criteria' | 'review' | 'pr' | 'diff' | 'message'
// What the actions and the composer need, for a task item or an epic
export interface InboxComposerContext {
  item: { type: InboxItem['type'], project: { slug: string } }
  taskLoading: boolean
  taskLoadFailed: boolean
  actions: { value: string, label: string, icon: string }[]
  action: Action | null
  resolveTo: ResolveTo
  text: string
  draftKey: string
  busy: boolean
  actionError: string | null
  placeholder: string
  submitLabel: string
  needsText: boolean
  // An action has taken over the composer
  composerChosen: boolean
  submit: (text: string) => Promise<boolean>
  // One click: most actions send at once, resolving true when sent; the others
  // pick the action for the composer
  act: (value: Action) => Promise<boolean>
  setAction: (value: Action | null) => void
  // Leaves the chosen action, or a reply, for how the item opened
  cancelAction: () => void
  setText: (value: string) => void
  setResolveTo: (value: ResolveTo) => void
}
export interface InboxPanelContext extends InboxComposerContext {
  item: TaskInboxItem | PmActivityItem
  task: Task | null
  evidence: Evidence[]
  reviews: Review[]
  alreadyResolved: boolean
  evidenceLoading: boolean
  tab: InboxPanelTab
  checkedHumanCriteria: string[]
  taskOpen: boolean
  setTab: (value: InboxPanelTab) => void
  setCheckedHumanCriteria: (value: string[]) => void
  retryTask: () => void
  toggleTask: () => void
}
// What an item is, for the line above its subject
export interface InboxItemKind {
  label: string
  icon: string
  color: string
}

// Text is required for two. Delete isn't undone, so it waits for the composer too.
const OPENS_COMPOSER: Action[] = ['request_changes', 'clarify', 'delete']
export const actionOpensComposer = (value: Action) => OPENS_COMPOSER.includes(value)
// Approval needs the task for its human-criteria check; the rest only wait
// while it's still loading.
export const actionDisabled = (ctx: InboxComposerContext, value: string) => ctx.busy || ctx.taskLoading || (value === 'approve' && ctx.taskLoadFailed)

export function useInboxPanel(ctx: InboxPanelContext) {
  const router = useRouter()
  const client = useQueryClient()
  const item = computed(() => ctx.item)
  const task = computed(() => ctx.task)
  const isReview = computed(() => item.value.type === 'human_review')
  const isDesign = computed(() => task.value?.type === 'design')
  const isSpike = computed(() => task.value?.type === 'spike')
  const canAct = computed(() => item.value.type !== 'activity' && !item.value.resolution && !ctx.alreadyResolved)

  const kind = computed<InboxItemKind>(() => {
    if (item.value.resolution) return { label: 'Resolved', icon: 'i-hugeicons-checkmark-circle-02', color: 'text-success' }
    switch (item.value.type) {
      case 'human_review': return {
        label: isDesign.value ? 'Design review' : isSpike.value ? 'Spike review' : task.value ? 'Code review' : 'Human review',
        icon: isDesign.value ? 'i-hugeicons-paint-board' : isSpike.value ? 'i-hugeicons-search-visual' : 'i-hugeicons-git-pull-request',
        color: 'text-brand'
      }
      case 'question': return { label: 'Question', icon: 'i-hugeicons-help-circle', color: 'text-info' }
      case 'blocked': return { label: 'Blocked', icon: 'i-hugeicons-pause-circle', color: 'text-warning' }
      case 'failed': return { label: 'Failed', icon: 'i-hugeicons-cancel-circle', color: 'text-destructive' }
      case 'stopped': return { label: 'Stopped', icon: 'i-hugeicons-stop-circle', color: 'text-warning' }
      default: return { label: 'Activity', icon: 'i-hugeicons-pulse-01', color: 'text-muted-foreground' }
    }
  })

  // What a read-only item says in place of the actions
  const readOnlyNote = computed(() => item.value.resolution ?? (ctx.alreadyResolved ? 'Already resolved. This task changed status elsewhere.' : 'For your information. Nothing to do.'))

  const tldr = computed(() => inboxTldr(item.value.body))

  const latestReview = computed<Review | null>(() => ctx.reviews[0] ?? task.value?.latestReview ?? null)
  const history = computed(() => !isReview.value ? [] : ctx.reviews.length > 0 ? ctx.reviews : latestReview.value ? [latestReview.value] : [])
  const criteria = computed(() => isReview.value ? task.value?.acceptanceCriteria ?? [] : [])
  const met = computed(() => criteria.value.filter(c => c.met).length)
  const gates = computed(() => isReview.value && !isSpike.value ? task.value?.gateChecks ?? [] : [])
  const files = computed(() => ctx.evidence.filter(e => e.kind !== 'note' && e.url))
  const images = computed(() => files.value.filter(e => e.contentType?.startsWith('image/')))
  const others = computed(() => files.value.filter(e => !e.contentType?.startsWith('image/')))
  const hasVerdict = computed(() => isReview.value && (latestReview.value !== null || gates.value.length > 0 || criteria.value.length > 0))

  // Spikes have no PR to look at
  const pr = computed(() => {
    const url = item.value.prUrl
    return url && !isSpike.value ? { url, number: url.match(/\/pull\/(\d+)/)?.[1] ?? null } : null
  })
  // A design's latest version, newest first. Set up once per item: the page
  // remounts with the selection, and the item can go before this panel does.
  const slug = ctx.item.project.slug
  const designs = useQuery(computed(() => {
    const t = task.value
    return { ...taskDesignsQuery({ slug, number: t?.number ?? 0, ref: t?.ref ?? '' }), enabled: t?.type === 'design' }
  }))
  const preview = computed(() => {
    const latest = isDesign.value ? designs.data.value?.[0] : null
    return latest ? { url: router.resolve(`/designs/${latest.id}`).href, label: `Preview v${latest.version}` } : null
  })

  // The PR tabs wait for the task, which says whether it's a design or a spike.
  // Set up once per item, like the designs above.
  const taskRef = ctx.item.taskRef
  const prNumber = computed(() => task.value && !isDesign.value ? Number(pr.value?.number) || null : null)
  const pullRequest = useQuery(computed(() => ({ ...taskPullRequestQuery({ slug, ref: taskRef ?? '' }, prNumber.value ?? 0), enabled: prNumber.value !== null })))
  const hasPullRequest = computed(() => prNumber.value !== null)
  const prDetail = computed(() => pullRequest.data.value ?? null)
  const prLoading = computed(() => hasPullRequest.value && pullRequest.isPending.value)
  // As with the task: a PR already showing stays through a failed refetch
  const prFailed = computed(() => hasPullRequest.value && pullRequest.isError.value && !prDetail.value)
  const prError = computed(() => prFailed.value ? pullRequest.error.value?.message ?? null : null)
  const retryPullRequest = () => {
    // Back to pending, for the loading state and a fresh failure
    if (taskRef && prNumber.value !== null) void client.resetQueries({ queryKey: keys.tasks.pullRequest(taskRef, prNumber.value), exact: true })
  }

  // What each action does, for items with nothing else to show
  const explanations = computed<Record<string, string>>(() => ({
    approve: isDesign.value ? 'Approves this version and starts planning the build.' : isSpike.value ? 'Accepts the findings and finishes the spike.' : 'Merges the PR once the checks pass.',
    request_changes: 'Sends it back to the developer with your note.',
    clarify: 'Your answer goes to the developer, who carries on.',
    send_back: 'Moves the task to the Backlog.',
    delete: 'Removes the task. You can give a reason first.',
    resolve: 'Starts the task again from the status you pick.',
    retry: 'Starts another run from where the task stopped.'
  }))

  return { task, isReview, canAct, kind, readOnlyNote, tldr, latestReview, history, criteria, met, gates, images, others, hasVerdict, pr, hasPullRequest, prDetail, prLoading, prFailed, prError, retryPullRequest, preview, explanations }
}
export type InboxPanel = ReturnType<typeof useInboxPanel>
