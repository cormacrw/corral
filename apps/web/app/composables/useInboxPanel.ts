import { useQuery } from '@tanstack/vue-query'
import type { Evidence, InboxActionInput, Review, Task, TaskInboxItem } from '@corral/contracts'
import { taskDesignsQuery } from '~/queries/tasks'
import { markdownToPlainText } from '~/utils/markdown'

// The Inbox message panel, Option D (design/inbox.md). The page owns the data
// and the actions; this turns them into what a reviewer decides on: the ask,
// the verdict and the artifacts.
type Action = InboxActionInput['action']
export type ResolveTo = 'backlog' | 'ready' | 'in_progress'
export type InboxPanelTab = 'overview' | 'criteria' | 'review' | 'message'
export interface InboxPanelContext {
  item: TaskInboxItem
  task: Task | null
  evidence: Evidence[]
  reviews: Review[]
  alreadyResolved: boolean
  taskLoading: boolean
  taskLoadFailed: boolean
  evidenceLoading: boolean
  actions: { value: string, label: string, icon: string }[]
  action: Action | null
  resolveTo: ResolveTo
  text: string
  busy: boolean
  actionError: string | null
  placeholder: string
  submitLabel: string
  needsText: boolean
  tab: InboxPanelTab
  checkedHumanCriteria: string[]
  // An action has taken over the composer
  composerChosen: boolean
  taskOpen: boolean
  submit: (text: string) => Promise<boolean>
  // One click: most actions send at once, resolving true when sent; the others
  // pick the action for the composer
  act: (value: Action) => Promise<boolean>
  setAction: (value: Action | null) => void
  setText: (value: string) => void
  setResolveTo: (value: ResolveTo) => void
  setTab: (value: InboxPanelTab) => void
  setCheckedHumanCriteria: (value: string[]) => void
  retryTask: () => void
  toggleTask: () => void
}

// Text is required for two. Delete isn't undone, so it waits for the composer too.
const OPENS_COMPOSER: Action[] = ['request_changes', 'clarify', 'delete']
export const actionOpensComposer = (value: Action) => OPENS_COMPOSER.includes(value)
// Approval needs the task for its human-criteria check; the rest only wait
// while it's still loading.
export const actionDisabled = (ctx: InboxPanelContext, value: string) => ctx.busy || ctx.taskLoading || (value === 'approve' && ctx.taskLoadFailed)

export function useInboxPanel(ctx: InboxPanelContext) {
  const router = useRouter()
  const item = computed(() => ctx.item)
  const task = computed(() => ctx.task)
  const isReview = computed(() => item.value.type === 'human_review')
  const isDesign = computed(() => task.value?.type === 'design')
  const isSpike = computed(() => task.value?.type === 'spike')
  const canAct = computed(() => item.value.type !== 'activity' && !item.value.resolution && !ctx.alreadyResolved)

  const kind = computed(() => {
    if (item.value.resolution) return { label: 'Resolved', icon: 'i-lucide-circle-check', color: 'text-success' }
    switch (item.value.type) {
      case 'human_review': return {
        label: isDesign.value ? 'Design review' : isSpike.value ? 'Spike review' : task.value ? 'Code review' : 'Human review',
        icon: isDesign.value ? 'i-lucide-palette' : isSpike.value ? 'i-lucide-telescope' : 'i-lucide-git-pull-request',
        color: 'text-primary'
      }
      case 'question': return { label: 'Question', icon: 'i-lucide-circle-help', color: 'text-info' }
      case 'blocked': return { label: 'Blocked', icon: 'i-lucide-circle-pause', color: 'text-warning' }
      case 'failed': return { label: 'Failed', icon: 'i-lucide-circle-x', color: 'text-error' }
      default: return { label: 'Activity', icon: 'i-lucide-activity', color: 'text-muted' }
    }
  })

  // What a read-only item says in place of the actions
  const readOnlyNote = computed(() => item.value.resolution ?? (ctx.alreadyResolved ? 'Already resolved. This task changed status elsewhere.' : 'For your information. Nothing to do.'))

  // Items with no stored message: the first paragraph of the body, plain
  const tldr = computed(() => {
    const body = item.value.body
    const first = body.split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith('#')) ?? body
    const plain = markdownToPlainText(first).replace(/\s+/g, ' ').trim()
    return plain.length > 180 ? `${plain.slice(0, 177).trimEnd()}…` : plain
  })

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

  const primary = computed(() => canAct.value ? ctx.actions[0] ?? null : null)
  const secondary = computed(() => canAct.value ? ctx.actions.slice(1) : [])
  // What each action does, for items with nothing else to show
  const explanations = computed<Record<string, string>>(() => ({
    approve: isDesign.value ? 'Approves this version and starts planning the build.' : isSpike.value ? 'Accepts the findings and finishes the spike.' : 'Merges the PR once the checks pass.',
    request_changes: 'Sends it back to the developer with your note.',
    clarify: 'Your answer goes to the developer, who carries on.',
    send_back: 'Moves the task to the Backlog.',
    delete: 'Removes the task. You can give a reason first.',
    resolve: 'Starts the task again from the status you pick.'
  }))

  return { item, task, isReview, isDesign, canAct, kind, readOnlyNote, tldr, latestReview, history, criteria, met, gates, images, others, hasVerdict, pr, preview, primary, secondary, explanations }
}
export type InboxPanel = ReturnType<typeof useInboxPanel>
