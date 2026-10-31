// @vitest-environment happy-dom
import type { EpicReviewItem } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref, watch } from 'vue'
import EvidenceList from './EvidenceList.vue'
import InboxEpicReview from './InboxEpicReview.vue'
import MarkdownText from './MarkdownText.vue'
import TaskCommitLinks from './TaskCommitLinks.vue'
import { testQueryClient } from '~/queries/mount-with-query'

const review = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })))
vi.mock('~/composables/useApi', () => ({ api: { epics: { review } } }))
// Auto-imported in the app
vi.stubGlobal('ref', ref)
vi.stubGlobal('computed', computed)
vi.stubGlobal('watch', watch)
vi.stubGlobal('useDevice', () => ({ isMobile: ref(false) }))

const commit = (sha: string) => ({ sha, url: `https://github.com/o/r/commit/${sha}` })
const task = (id: string, fields: object) => ({
  id, ref: id.toUpperCase(), title: id, pr: null, latestReview: null, acceptanceCriteria: [],
  submission: { sequence: 1, targetBranch: 'epic', submitted: commit('aaaaaaaaaaaa'), approved: commit('bbbbbbbbbbbb'), integrated: commit('cccccccccccc'), integratedAt: 'now' }, ...fields
})
const item = {
  id: 'e', type: 'epic_review', epicId: 'e', subject: 'Feature', body: 'Fine', headSha: 'head', prUrl: 'https://github.com/o/r/pull/1',
  project: { name: 'P' }, sender: { name: 'Rita' },
  tasks: [
    { task: task('t1', {}), evidence: [], humanReview: true, humanChecks: [] },
    { task: task('t2', { acceptanceCriteria: [{ id: 'c', position: 0, text: 'On a real iPhone', checkedByHuman: true, met: null }] }), evidence: [], humanReview: false, humanChecks: ['c'] },
    { task: task('t3', { pr: { number: 7, url: 'https://github.com/o/r/pull/7' }, submission: null, acceptanceCriteria: [{ id: 'd', position: 0, text: 'Already reviewed', checkedByHuman: true, met: null }] }), evidence: [], humanReview: false, humanChecks: [] }
  ]
} as unknown as EpicReviewItem

const Stub = defineComponent({ props: { label: String, title: String }, emits: ['click'], setup: (p, { slots, emit }) => () => h('button', { onClick: () => emit('click') }, [p.label ?? p.title, slots.default?.()]) })
const render = () => mount(InboxEpicReview, {
  props: { item },
  global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { EvidenceList, MarkdownText, TaskCommitLinks, InboxEpicHeader: Stub, NuxtLink: Stub, UAlert: Stub, UButton: Stub, UIcon: Stub, UModal: Stub, UTextarea: Stub } }
})

describe('InboxEpicReview', () => {
  beforeEach(() => review.mockClear())

  it('links commits, or the PR of a legacy task, with no PR link on PR-free tasks', () => {
    const links = render().findAll('a').map(a => a.attributes('href'))
    expect(links).toEqual(['https://github.com/o/r/commit/cccccccccccc', 'https://github.com/o/r/commit/bbbbbbbbbbbb', 'https://github.com/o/r/commit/cccccccccccc', 'https://github.com/o/r/commit/bbbbbbbbbbbb', 'https://github.com/o/r/pull/7'])
  })

  it('approves only once every owed check is confirmed, and sends them', async () => {
    const wrapper = render()
    const approve = wrapper.findAll('button').find(b => b.text() === 'Approve')!
    expect(wrapper.text()).toContain('0 of 2 human checks confirmed')
    await approve.trigger('click')
    expect(review).not.toHaveBeenCalled()
    const boxes = wrapper.findAll('input[type="checkbox"]')
    // The legacy task's check was settled on the task
    expect(boxes).toHaveLength(2)
    for (const box of boxes) await box.setValue(true)
    expect(wrapper.text()).toContain('2 of 2 human checks confirmed')
    await approve.trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('e', { action: 'approve', headSha: 'head', confirmedCriteria: ['c'], confirmedTasks: ['t1'] })
  })

  async function ticked() {
    const wrapper = render()
    for (const box of wrapper.findAll('input[type="checkbox"]')) await box.setValue(true)
    expect(wrapper.text()).toContain('2 of 2 human checks confirmed')
    return wrapper
  }

  it('needs fresh ticks when the same epic comes back on a new head', async () => {
    const wrapper = await ticked()
    await wrapper.setProps({ item: { ...item, headSha: 'new-head' } })
    expect(wrapper.text()).toContain('0 of 2 human checks confirmed')
    const approve = wrapper.findAll('button').find(b => b.text() === 'Approve')!
    await approve.trigger('click')
    expect(review).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Confirm every human check first')

    for (const box of wrapper.findAll('input[type="checkbox"]')) await box.setValue(true)
    await approve.trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('e', { action: 'approve', headSha: 'new-head', confirmedCriteria: ['c'], confirmedTasks: ['t1'] })
  })

  it('needs fresh ticks when an owed check changes on the same head', async () => {
    const wrapper = await ticked()
    const [one, two, three] = item.tasks
    const reworded = { ...two!, task: { ...two!.task, acceptanceCriteria: [{ ...two!.task.acceptanceCriteria[0]!, text: 'On a real Android' }] } }
    await wrapper.setProps({ item: { ...item, tasks: [one!, reworded, three!] } })
    expect(wrapper.text()).toContain('0 of 2 human checks confirmed')
  })

  it('keeps ticks through a refresh that changes nothing owed', async () => {
    const wrapper = await ticked()
    await wrapper.setProps({ item: { ...item, body: 'Still fine', tasks: item.tasks.map(t => ({ ...t })) } })
    expect(wrapper.text()).toContain('2 of 2 human checks confirmed')
  })
})
