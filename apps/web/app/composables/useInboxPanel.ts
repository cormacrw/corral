import type { DesignVersion, PullRequestDetail, Evidence, InboxActionInput, Review, Task, TaskInboxItem } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { markdownToPlainText } from '~/utils/markdown'

// COR-190 design options for the Inbox message panel. The page owns the data
// and the actions and hands them to whichever option is showing; this turns
// them into what a reviewer decides on: the ask, the verdict and the artifacts.
export type InboxPanelOption = 'a' | 'b' | 'c' | 'd' | 'e'
export const INBOX_PANEL_OPTIONS: { value: InboxPanelOption, label: string, name: string }[] = [
  { value: 'a', label: 'A', name: 'Verdict card' },
  { value: 'b', label: 'B', name: 'Artifacts first' },
  { value: 'c', label: 'C', name: 'Checklist' },
  { value: 'd', label: 'D', name: 'TL;DR + tabs · chosen (v3)' },
  { value: 'e', label: 'E', name: 'Triage' }
]

type Action = InboxActionInput['action']
export interface InboxPanelContext {
  item: TaskInboxItem
  task: Task | null
  evidence: Evidence[]
  reviews: Review[]
  alreadyResolved: boolean
  actions: { value: string, label: string, icon: string }[]
  action: Action | null
  resolveTo: 'backlog' | 'ready' | 'in_progress'
  text: string
  busy: boolean
  actionError: string | null
  placeholder: string
  submitLabel: string
  needsText: boolean
  // Where the item sits in Needs you, for Triage's "3 of 7"
  position: { index: number, total: number } | null
  submit: (text: string) => Promise<boolean>
  // One click: actions that need no text are sent; the others pick the action for the reply box
  act: (value: Action) => Promise<void>
  setAction: (value: Action | null) => void
  setText: (value: string) => void
  setResolveTo: (value: 'backlog' | 'ready' | 'in_progress') => void
  next: () => void
  openTask: () => void
}

const NEEDS_TEXT: Action[] = ['request_changes', 'clarify']
export const actionNeedsText = (value: Action) => NEEDS_TEXT.includes(value)

export function useInboxPanel(ctx: InboxPanelContext) {
  const router = useRouter()
  const live = useLive()
  const item = computed(() => ctx.item)
  const task = computed(() => ctx.task)
  const isDesign = computed(() => task.value?.type === 'design')
  const canAct = computed(() => item.value.type !== 'activity' && !item.value.resolution && !ctx.alreadyResolved)

  const kind = computed(() => {
    if (item.value.resolution) return { label: 'Resolved', icon: 'i-lucide-circle-check', color: 'text-success' }
    switch (item.value.type) {
      case 'human_review': return isDesign.value
        ? { label: 'Design review', icon: 'i-lucide-palette', color: 'text-primary' }
        : { label: 'Code review', icon: 'i-lucide-git-pull-request', color: 'text-primary' }
      case 'question': return { label: 'Question', icon: 'i-lucide-message-circle-question', color: 'text-info' }
      case 'blocked': return { label: 'Blocked', icon: 'i-lucide-octagon-pause', color: 'text-warning' }
      case 'failed': return { label: 'Failed', icon: 'i-lucide-circle-x', color: 'text-error' }
      default: return { label: 'Activity', icon: 'i-lucide-activity', color: 'text-muted' }
    }
  })

  // What's asked of the human, in one line
  const ask = computed(() => {
    const i = item.value
    if (i.resolution) return i.resolution
    if (ctx.alreadyResolved) return 'Already resolved elsewhere. Nothing to do.'
    switch (i.type) {
      case 'human_review': return isDesign.value ? 'Approve this design version, or request changes' : `Approve and merge ${pr.value ? `PR #${pr.value.number}` : 'the change'}, or request changes`
      case 'question': return `Answer ${i.sender.name}'s question`
      case 'blocked': return `Unblock ${i.sender.name}: answer, or send it back`
      case 'failed': return 'Retry, send back to the Backlog, or delete'
      default: return 'For your information. Nothing to do.'
    }
  })

  // The first paragraph of the body as plain text: a stand-in for a summary
  // field the contracts don't have yet (design.md, open questions)
  const tldr = computed(() => {
    const first = item.value.body.split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith('#')) ?? item.value.body
    const plain = markdownToPlainText(first).replace(/\s+/g, ' ').trim()
    return plain.length > 180 ? `${plain.slice(0, 177).trimEnd()}…` : plain
  })
  const bodyIsLong = computed(() => markdownToPlainText(item.value.body).trim() !== tldr.value)

  const latestReview = computed<Review | null>(() => ctx.reviews[0] ?? task.value?.latestReview ?? null)
  const history = computed(() => ctx.reviews.length > 0 ? ctx.reviews : task.value?.latestReview ? [task.value.latestReview] : [])
  const criteria = computed(() => (task.value?.acceptanceCriteria ?? []).map(c => ({
    ...c,
    note: latestReview.value?.criteria.find(r => r.criterionId === c.id)?.note ?? '',
    evidence: ctx.evidence.filter(e => e.criterionId === c.id)
  })))
  const met = computed(() => criteria.value.filter(c => c.met).length)
  const gates = computed(() => task.value?.gateChecks ?? [])
  const isImage = (e: Evidence) => !!e.contentType?.startsWith('image/') || !!e.contentType?.startsWith('video/')
  const images = computed(() => ctx.evidence.filter(e => e.kind !== 'note' && isImage(e)))
  const files = computed(() => ctx.evidence.filter(e => e.kind !== 'note' && !isImage(e)))
  const hasVerdict = computed(() => item.value.type === 'human_review' && (latestReview.value !== null || gates.value.length > 0 || criteria.value.length > 0))

  const pr = computed(() => {
    const url = item.value.prUrl
    const number = url?.match(/\/pull\/(\d+)/)?.[1]
    return url ? { url, number: number ?? '' } : null
  })
  // A design task's latest version: its preview opens in a new tab (D20)
  const designs = ref<DesignVersion[]>([])
  watch(() => [task.value?.id, isDesign.value], async () => {
    designs.value = []
    const t = task.value
    const slug = live.state.value.projects.find(p => p.id === t?.projectId)?.slug
    if (!t || !isDesign.value || !slug) return
    designs.value = await api.tasks.designs(slug, t.number).catch(() => [])
  }, { immediate: true })
  const design = computed(() => designs.value.at(-1) ?? null)
  // A code review's PR description and diff (proposed endpoint, design.md)
  const prDetail = ref<PullRequestDetail | null>(null)
  const prLoading = ref(false)
  watch(() => [task.value?.id, item.value.prUrl], async () => {
    prDetail.value = null
    const t = task.value
    const slug = live.state.value.projects.find(p => p.id === t?.projectId)?.slug
    if (!t || !item.value.prUrl || isDesign.value || !slug) return
    prLoading.value = true
    prDetail.value = await api.tasks.pullRequest(slug, t.number).catch(() => null)
    if (task.value?.id === t.id) prLoading.value = false
  }, { immediate: true })
  const preview = computed(() => design.value ? { url: router.resolve(`/designs/${design.value.id}`).href, label: `Preview v${design.value.version}` } : null)

  const primary = computed(() => canAct.value ? ctx.actions[0] ?? null : null)
  const secondary = computed(() => canAct.value ? ctx.actions.slice(1) : [])
  const primaryLabel = computed(() => isDesign.value && primary.value?.value === 'approve' ? 'Approve design' : primary.value?.label)

  // The evidence viewer, shared by every thumbnail in the panel
  const viewing = ref<Evidence | null>(null)
  watch(item, () => {
    viewing.value = null
  })
  const view = (e: Evidence | null) => {
    viewing.value = e
  }

  return { item, task, isDesign, canAct, kind, ask, tldr, bodyIsLong, latestReview, history, criteria, met, gates, images, files, hasVerdict, pr, prDetail, prLoading, design, preview, primary, secondary, primaryLabel, viewing, view }
}
export type InboxPanel = ReturnType<typeof useInboxPanel>
