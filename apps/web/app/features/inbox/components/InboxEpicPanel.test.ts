// @vitest-environment happy-dom
import type { EpicActivityItem, EpicConflictItem, EpicReview, EpicReviewItem } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppLoadError from '~/components/app/AppLoadError.vue'
import { ApiError } from '~/composables/useApi'
import EvidenceList from '~/features/evidence/components/EvidenceList.vue'
import InboxEpicOverview from '~/features/inbox/components/InboxEpicOverview.vue'
import InboxEpicPanel from '~/features/inbox/components/InboxEpicPanel.vue'
import InboxEpicRounds from '~/features/inbox/components/InboxEpicRounds.vue'
import InboxEpicTasks from '~/features/inbox/components/InboxEpicTasks.vue'
import InboxPanelThumbBar from '~/features/inbox/components/InboxPanelThumbBar.vue'
import { testQueryClient } from '~/queries/mount-with-query'

const { getReview, review } = vi.hoisted(() => ({ getReview: vi.fn(), review: vi.fn(() => Promise.resolve({ ok: true })) }))
vi.mock('~/composables/useApi', async (original) => {
  const actual = await original<typeof import('~/composables/useApi')>()
  return { ...actual, api: { epics: { getReview, review } } }
})
// Auto-imported in the app
vi.stubGlobal('ref', ref)
vi.stubGlobal('computed', computed)
vi.stubGlobal('watch', watch)
vi.stubGlobal('nextTick', nextTick)
vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
vi.stubGlobal('useDevice', () => ({ isMobile: ref(false) }))

const task = (id: string, fields: object) => ({
  id, ref: id.toUpperCase(), title: `Task ${id}`, kind: 'normal', status: 'merged', pr: null, latestReview: null, acceptanceCriteria: [], submission: null, ...fields
})
const row = (id: string, fields: object) => ({
  id, ref: id.toUpperCase(), title: `Task ${id}`, kind: 'normal', merged: true, prNumber: null, prUrl: null, integratedCommit: null, reviewedBy: 'reviewer',
  criteria: [], criteriaMet: 0, criteriaTotal: 0, evidence: [], humanReview: false, humanChecks: [], ...fields
})
const base = {
  id: 'e', epicId: 'e', subject: 'Feature', body: 'Fits together', preview: 'Fits', project: { id: 'p', name: 'Project', slug: 'p', thumbnailColor: null, thumbnailUrl: null },
  sender: { name: 'Rita', role: 'reviewer' }, at: '2026-11-02T00:00:00.000Z', prUrl: 'https://github.com/o/r/pull/9', taskId: null, taskRef: null, resolution: null
}
const waiting = { ...base, type: 'epic_review', headSha: 'head', findings: [], reviewRounds: [], since: null, newArtifacts: [], tasks: [{ task: task('t1', {}), evidence: [], humanReview: false, humanChecks: [] }] } as unknown as EpicReviewItem
const owing = {
  ...waiting,
  tasks: [
    { task: task('t1', {}), evidence: [], humanReview: true, humanChecks: [] },
    { task: task('t2', { acceptanceCriteria: [{ id: 'c', position: 0, text: 'On a real iPhone', checkedByHuman: true, met: null }] }), evidence: [], humanReview: false, humanChecks: ['c'] }
  ]
} as unknown as EpicReviewItem

const pr = { number: 9, url: 'https://github.com/o/r/pull/9', title: 'Feature', body: 'What it does', baseBranch: 'main', headBranch: 'epic', files: [{ path: 'whole.ts', status: 'modified', additions: 1, deletions: 0, patch: '' }], totalFiles: 1, truncated: false }
const round = { round: 1, verdict: 'approved', reviewer: { id: 'a', name: 'Rita' }, headSha: 'head', summary: 'Good to go', at: base.at, findings: [{ level: 'non_blocking', text: 'Could share a title', taskRefs: ['T1'] }, { level: 'blocking', text: 'Fixed since', taskRefs: [] }] }
const details: EpicReview = {
  epicId: 'e', title: 'Feature', goal: 'Goal', reviewMode: 'epic', state: 'human_review', targetBranch: 'main', headSha: 'head', pr, gateChecks: [{ name: 'lint', conclusion: 'success', url: null }],
  targetMovedBy: 0, rounds: [round], tasks: [row('t1', { prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' }), row('t2', { kind: 'fix', integratedCommit: { sha: 'abcdef1234', url: 'https://github.com/o/r/commit/abcdef1234' }, reviewedBy: 'human' })],
  seenByHuman: 1, lastFeedback: null, conflictTaskRef: null, conflictPending: false, mergeCommitSha: null
} as unknown as EpicReview
const later = { ...details, lastFeedback: { text: 'Rename it', at: base.at, headSha: 'old', fixTasks: [{ id: 'f', ref: 'T9', title: 'Fix integration: rename' }], files: [{ path: 'since.ts', status: 'modified', additions: 1, deletions: 1, patch: '' }], totalFiles: 1, truncated: false, diffUrl: 'https://github.com/o/r/compare/old...head' } } as unknown as EpicReview

const Passthrough = defineComponent({
  inheritAttrs: false,
  props: { label: String, title: String, description: String },
  emits: ['click'],
  setup: (p, { slots, emit, attrs }) => () => h('button', { ...attrs, onClick: () => emit('click') }, [p.label, p.title, p.description, slots.default?.()])
})
const Tabs = defineComponent({
  props: { items: Array as () => { label: string, value: string }[], modelValue: String },
  emits: ['update:modelValue'],
  setup: (p, { emit }) => () => h('nav', p.items!.map(i => h('button', { 'data-tab': i.value, 'aria-current': i.value === p.modelValue, 'onClick': () => emit('update:modelValue', i.value) }, i.label)))
})
const Plain = defineComponent({ props: { text: String, to: String }, setup: (p, { slots }) => () => h('span', [p.text, slots.default?.()]) })
// The composer: what's typed, sent with submit, and Cancel
const Tray = defineComponent({
  props: { ctx: { type: Object, required: true } },
  setup: p => () => h('form', { onSubmit: () => p.ctx.submit(p.ctx.text) }, [
    p.ctx.actionError,
    h('textarea', { value: p.ctx.text, onInput: (e: Event) => p.ctx.setText((e.target as HTMLTextAreaElement).value) }),
    h('button', { type: 'button', onClick: () => p.ctx.cancelAction() }, 'Cancel')
  ])
})
const moment = (event: string, fields: object = {}) => ({ ...base, type: 'epic_activity', event, sender: { name: 'Corral', role: 'system' }, ...fields }) as unknown as EpicActivityItem
const mounted = new Set<{ unmount: () => void }>()
const render = (item: EpicReviewItem | EpicConflictItem | EpicActivityItem, mobile = false) => track(mount(InboxEpicPanel, {
  props: { item, mobile },
  global: {
    plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
    components: { AppLoadError, EvidenceList, InboxEpicOverview, InboxEpicRounds, InboxEpicTasks, InboxPanelThumbBar },
    stubs: { AppButton: Passthrough, AppAlert: Passthrough, AppTabs: Tabs, AppBadge: Passthrough, Icon: true, UiSkeleton: { template: '<i data-skeleton />' }, AppTextarea: true, AppSelectMenu: true, NuxtLink: Plain, TaskLink: { props: ['taskRef'], template: '<a data-task>{{ taskRef }}</a>' }, TaskRefText: Plain, MarkdownText: Plain, ProjectThumbnail: true, EvidenceViewer: true, InboxEpicDecision: true, InboxPanelDiff: { props: ['pr', 'githubUrl'], template: '<div data-diff :data-url="githubUrl">{{ pr.files.map(f => f.path).join() }}</div>' }, InboxPanelTray: Tray }
  }
}))
function track<T extends { unmount: () => void }>(wrapper: T) {
  mounted.add(wrapper)
  return wrapper
}
function unmount(wrapper: { unmount: () => void }) {
  mounted.delete(wrapper)
  wrapper.unmount()
}
const button = (wrapper: ReturnType<typeof render>, text: string) => wrapper.findAll('button').find(b => b.text().includes(text))!
const open = (wrapper: ReturnType<typeof render>, tab: string) => wrapper.get(`[data-tab="${tab}"]`).trigger('click')

describe('InboxEpicPanel', () => {
  beforeEach(() => {
    sessionStorage.clear()
    review.mockReset()
    review.mockResolvedValue({ ok: true })
    getReview.mockReset()
    getReview.mockResolvedValue(details)
  })
  afterEach(() => {
    for (const wrapper of [...mounted]) unmount(wrapper)
  })

  it('shows the top block at once, with skeletons in the tab body until the review arrives', async () => {
    let arrive: (value: EpicReview) => void = () => {}
    getReview.mockReturnValue(new Promise((resolve) => {
      arrive = resolve
    }))
    const wrapper = render(waiting)
    expect(wrapper.get('h1').text()).toBe('Feature')
    expect(button(wrapper, 'Approve parent')).toBeTruthy()
    expect(wrapper.find('[data-testid="inbox-epic-loading"]').exists()).toBe(true)
    arrive(details)
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-epic-loading"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="inbox-epic-verdict"]').text()).toContain('Rita')
  })

  it('names the target, how far it moved, and what approving does', async () => {
    getReview.mockResolvedValue({ ...details, targetMovedBy: 6 })
    const moved = render(waiting)
    await flushPromises()
    expect(moved.get('[data-testid="inbox-epic-approving"]').text()).toContain('6 commits')
    getReview.mockResolvedValue(details)
    const still = render(waiting)
    await flushPromises()
    expect(still.get('[data-testid="inbox-epic-approving"]').text()).not.toContain('commits')
  })

  it('says a pending conflict is resolved after approval', async () => {
    getReview.mockResolvedValue({ ...details, conflictPending: true, targetMovedBy: 2 })
    const wrapper = render(waiting)
    await flushPromises()
    expect(wrapper.get('[data-testid="inbox-epic-approving"]').text()).toContain('conflict')
  })

  it('approves on one click when nothing is owed, without asking about a non-blocking note', async () => {
    const wrapper = render(waiting)
    await flushPromises()
    expect(wrapper.get('[data-testid="inbox-epic-notes"]').text()).toContain('Could share a title')
    expect(wrapper.get('[data-testid="inbox-epic-notes"]').text()).not.toContain('Fixed since')
    await button(wrapper, 'Approve parent').trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('e', { action: 'approve', headSha: 'head', confirmedCriteria: [], confirmedTasks: [] })
    expect(wrapper.emitted('resolved')).toHaveLength(1)
  })

  it('opens Tasks and says what is left, and sends only once every check is ticked', async () => {
    getReview.mockResolvedValue({ ...details, tasks: [row('t1', { humanReview: true }), row('t2', { humanChecks: ['c'], criteria: [{ id: 'c', position: 0, text: 'On a real iPhone', checkedByHuman: true, met: null }] })] })
    const wrapper = render(owing)
    await flushPromises()
    await button(wrapper, 'Approve parent').trigger('click')
    await flushPromises()
    expect(review).not.toHaveBeenCalled()
    expect(wrapper.get('[data-tab="tasks"]').attributes('aria-current')).toBe('true')
    expect(wrapper.text()).toContain('2 human checks left')
    expect(wrapper.get('[data-testid="inbox-epic-checks-left"]').text()).toBe('0 of 2 human checks confirmed')
    for (const box of wrapper.findAll('input[type="checkbox"]')) await box.setValue(true)
    await flushPromises()
    expect(wrapper.text()).not.toContain('checks left')
    await button(wrapper, 'Approve parent').trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('e', { action: 'approve', headSha: 'head', confirmedCriteria: ['c'], confirmedTasks: ['t1'] })
  })

  it('needs the human\'s words to request changes, and moves on', async () => {
    const wrapper = render(waiting)
    await flushPromises()
    await button(wrapper, 'Request changes').trigger('click')
    await flushPromises()
    expect(review).not.toHaveBeenCalled()
    await wrapper.get('textarea').setValue('Rename it')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('e', { action: 'request_changes', headSha: 'head', text: 'Rename it' })
    expect(wrapper.emitted('resolved')).toHaveLength(1)
  })

  it('approves the head on screen, so a head that moved underneath is refused and says why', async () => {
    review.mockRejectedValueOnce(new ApiError(409, { code: 'conflict', constraint: 'epic_review_changed' } as never, 'epic_review_changed'))
    const wrapper = render(waiting)
    await flushPromises()
    // Approval was kept across a rebase: the item has the new head, the review hasn't caught up
    await wrapper.setProps({ item: { ...waiting, headSha: 'rebased' } })
    await button(wrapper, 'Approve parent').trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('e', expect.objectContaining({ action: 'approve', headSha: 'head' }))
    expect(wrapper.text()).toContain('This parent changed while you had it open')
    expect(wrapper.emitted('resolved')).toBeUndefined()
  })

  it('stays on an item that left the Inbox, with the draft, and sends nothing', async () => {
    const wrapper = render(waiting)
    await flushPromises()
    await button(wrapper, 'Request changes').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('Rename it')
    await wrapper.setProps({ gone: true })
    expect(wrapper.text()).toContain('This parent changed while you had it open')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Rename it')
    expect(button(wrapper, 'Approve parent').attributes('disabled')).toBeDefined()
    // Remounting reads the same draft
    unmount(wrapper)
    const again = render(waiting)
    await flushPromises()
    await button(again, 'Request changes').trigger('click')
    await flushPromises()
    expect((again.get('textarea').element as HTMLTextAreaElement).value).toBe('Rename it')
  })

  it.each([
    ['epic_pr_changed', 'The parent PR changed on GitHub'],
    ['human_checks_unconfirmed', 'The human checks changed'],
    ['epic_decision_changed', 'already been answered']
  ])('says what a %s refusal means', async (constraint, message) => {
    review.mockRejectedValueOnce(new ApiError(409, { code: 'conflict', constraint } as never, constraint))
    const wrapper = render(waiting)
    await flushPromises()
    await button(wrapper, 'Approve parent').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain(message)
    expect(wrapper.text()).not.toContain('changed while you had it open')
  })

  it('never claims an approval an older round made on another head', async () => {
    getReview.mockResolvedValue({ ...details, headSha: 'new', rounds: [{ ...round, headSha: 'old' }] })
    const stopped = { ...waiting, headSha: 'new', sender: { name: 'Corral', role: 'system' } } as unknown as EpicReviewItem
    const wrapper = render(stopped)
    await flushPromises()
    expect(wrapper.get('[data-testid="inbox-epic-reviewer"]').text()).toBe('No reviewer approval on this head')
  })

  it('keeps a reviewer\'s approval carried across a rebase', async () => {
    getReview.mockResolvedValue({ ...details, headSha: 'rebased', rounds: [{ ...round, headSha: 'old' }] })
    const wrapper = render({ ...waiting, headSha: 'rebased' } as EpicReviewItem)
    await flushPromises()
    expect(wrapper.get('[data-testid="inbox-epic-reviewer"]').text()).toBe('Rita approved the parent')
  })

  it('shows Review from the item when the review can\'t load, and its body with no rounds', async () => {
    getReview.mockRejectedValue(new Error('runner offline'))
    const withRounds = render({ ...waiting, reviewRounds: [round], findings: round.findings } as unknown as EpicReviewItem)
    await flushPromises()
    expect(withRounds.get('[data-testid="inbox-epic-error"]').text()).toContain('runner offline')
    await open(withRounds, 'review')
    expect(withRounds.get('[data-testid="inbox-epic-rounds"]').text()).toContain('Good to go')
    const none = render(waiting)
    await flushPromises()
    await open(none, 'review')
    expect(none.text()).toContain('Fits together')
  })

  it('has no Review tab on a moment with no review', async () => {
    getReview.mockResolvedValue({ ...details, rounds: [] })
    const wrapper = render(moment('opened'))
    await flushPromises()
    expect(wrapper.find('[data-tab="review"]').exists()).toBe(false)
  })

  it('says when the changes since can\'t be worked out', async () => {
    getReview.mockResolvedValue({ ...later, lastFeedback: { ...later.lastFeedback!, files: [], totalFiles: 0, truncated: true } })
    const wrapper = render(waiting)
    await flushPromises()
    expect(wrapper.get('[data-testid="inbox-see-changes"]').text()).toBe('See only these changes')
    await wrapper.get('[data-testid="inbox-see-changes"]').trigger('click')
    expect(wrapper.find('[data-testid="inbox-since-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-diff]').exists()).toBe(false)
  })

  it('leaves Since your last review off read-only moments', async () => {
    getReview.mockResolvedValue(later)
    const wrapper = render(moment('opened'))
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-epic-since"]').exists()).toBe(false)
  })

  it('names the next step and the squash commit only on their own events', async () => {
    getReview.mockResolvedValue({ ...details, state: 'ready_to_merge', mergeCommitSha: '5d4c3b2a1f0e' })
    const wrapper = render(moment('opened'))
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-epic-next"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="inbox-epic-squash"]').exists()).toBe(false)
  })

  it('counts an approved design as done, on an item with no review yet', async () => {
    getReview.mockReturnValue(new Promise(() => {}))
    const design = { ...waiting, tasks: [{ task: task('d', { type: 'design', status: 'approved' }), evidence: [], humanReview: false, humanChecks: [] }] } as unknown as EpicReviewItem
    const wrapper = render(design)
    await flushPromises()
    expect(wrapper.get('[data-tab="tasks"]').text()).toBe('Tasks 1/1')
  })

  it('closes the composer on Cancel, sending nothing for a decision', async () => {
    const decision = { question: 'Which?', alternatives: [] }
    const wrapper = render({ ...base, type: 'epic_conflict', sender: { name: 'Corral', role: 'system' }, headSha: 'head', targetBranch: 'main', files: [], decision, since: null, newArtifacts: [] } as unknown as EpicConflictItem)
    await flushPromises()
    await button(wrapper, 'Answer in your own words').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('Keep both')
    await button(wrapper, 'Cancel').trigger('click')
    await flushPromises()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(review).not.toHaveBeenCalled()
  })

  it('keeps the feedback, says why and refreshes when the head moved', async () => {
    review.mockRejectedValueOnce(new ApiError(409, { code: 'conflict', constraint: 'epic_review_changed' } as never, 'epic_review_changed'))
    const wrapper = render(waiting)
    await flushPromises()
    await button(wrapper, 'Request changes').trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('Rename it')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    // Said once, in the composer
    expect(wrapper.text().match(/This parent changed while you had it open/g)).toHaveLength(1)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Rename it')
    expect(wrapper.emitted('resolved')).toBeUndefined()
    expect(getReview.mock.calls.length).toBeGreaterThan(1)
  })

  it('shows a row per task with who passed it, its PR or commit, and a fix or conflict label', async () => {
    const wrapper = render(waiting)
    await flushPromises()
    await open(wrapper, 'tasks')
    const [first, second] = wrapper.findAll('[data-testid="inbox-epic-task"]')
    expect(first!.text()).toContain('Reviewer passed it')
    expect(first!.get('a').attributes('href')).toBe('https://github.com/o/r/pull/7')
    expect(second!.text()).toContain('You passed it')
    expect(second!.text()).toContain('abcdef1')
    expect(second!.text()).toContain('Fix task')
    expect(first!.text()).not.toContain('Fix task')
  })

  it('shows neither round-two control on a first review', async () => {
    const wrapper = render(waiting)
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-epic-since"]').exists()).toBe(false)
    await open(wrapper, 'diff')
    expect(wrapper.find('[data-testid="inbox-diff-view"]').exists()).toBe(false)
    expect(wrapper.get('[data-diff]').text()).toBe('whole.ts')
  })

  it('leads a later round with the feedback and opens only the changes since', async () => {
    getReview.mockResolvedValue(later)
    const wrapper = render(waiting)
    await flushPromises()
    const since = wrapper.get('[data-testid="inbox-epic-since"]')
    expect(since.text()).toContain('Rename it')
    expect(since.text()).toContain('T9')
    await wrapper.get('[data-testid="inbox-see-changes"]').trigger('click')
    expect(wrapper.get('[data-tab="diff"]').attributes('aria-current')).toBe('true')
    expect(wrapper.get('[data-diff]').text()).toBe('since.ts')
    expect(wrapper.get('[data-diff]').attributes('data-url')).toBe('https://github.com/o/r/compare/old...head')
    await button(wrapper, 'Whole parent').trigger('click')
    expect(wrapper.get('[data-diff]').text()).toBe('whole.ts')
  })

  it.each([false, true])('has no actions on a read-only moment (mobile=%s)', async (mobile) => {
    const wrapper = render(moment('opened'), mobile)
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-read-only"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="inbox-actions"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="inbox-thumb-bar"]').exists()).toBe(false)
  })

  it('shows the resolution, and what happens next for an approved parent', async () => {
    getReview.mockResolvedValue({ ...details, state: 'ready_to_merge' })
    const wrapper = render(moment('human_approved', { resolution: 'You approved the parent PR' }))
    await flushPromises()
    expect(wrapper.get('[data-testid="inbox-read-only"]').text()).toBe('You approved the parent PR')
    expect(wrapper.get('[data-testid="inbox-epic-next"]').text()).toContain('squash-merges into main')
  })

  it('shows a merged parent\'s squash commit', async () => {
    getReview.mockResolvedValue({ ...details, state: 'merged', mergeCommitSha: '5d4c3b2a1f0e' })
    const wrapper = render(moment('merged'))
    await flushPromises()
    expect(wrapper.get('[data-testid="inbox-epic-squash"] a').attributes('href')).toBe('https://github.com/o/r/commit/5d4c3b2a1f0e')
  })

  it('links a conflict record\'s task with how many merged, only when it has one', async () => {
    getReview.mockResolvedValue({ ...details, conflictTaskRef: 'T3', tasks: [row('t1', {}), row('t2', {}), row('t3', { merged: false })] })
    const legacy = render(moment('conflict'))
    await flushPromises()
    expect(legacy.get('[data-testid="inbox-epic-conflict-task"]').text()).toContain('2 of 3 tasks merged')
    getReview.mockResolvedValue(details)
    const fixRun = render(moment('conflict'))
    await flushPromises()
    expect(fixRun.find('[data-testid="inbox-epic-conflict-task"]').exists()).toBe(false)
  })

  const conflict = (fields: object) => ({ ...base, type: 'epic_conflict', sender: { name: 'Corral', role: 'system' }, headSha: 'head', targetBranch: 'main', files: ['a.ts'], since: null, newArtifacts: [], ...fields }) as unknown as EpicConflictItem

  it('retries a stopped parent, showing the failure', async () => {
    const wrapper = render(conflict({ stopped: { fix: 'ci', error: '3 fixes have failed' }, files: [] }))
    await flushPromises()
    expect(wrapper.text()).toContain('Fix stopped')
    expect(wrapper.text()).toContain('3 fixes have failed')
    await button(wrapper, 'Retry').trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('e', { action: 'rebase', headSha: 'head' })
  })

  it('keeps a stopped parent\'s failure, files and question when the review can\'t load', async () => {
    getReview.mockRejectedValue(new Error('runner offline'))
    const wrapper = render(conflict({ stopped: { fix: 'ci', error: '3 fixes have failed' } }))
    await flushPromises()
    expect(wrapper.text()).toContain('3 fixes have failed')
    expect(wrapper.text()).toContain('a.ts')
    expect(wrapper.text()).toContain('runner offline')
  })
})
