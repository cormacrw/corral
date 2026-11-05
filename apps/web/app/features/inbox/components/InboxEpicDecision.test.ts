// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import InboxEpicDecision from '~/features/inbox/components/InboxEpicDecision.vue'
import { testQueryClient } from '~/queries/mount-with-query'

enableAutoUnmount(afterEach)

const act = vi.hoisted(() => vi.fn(() => Promise.resolve({ task: null })))
const review = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })))
vi.mock('~/composables/useApi', () => ({ api: { inbox: { act }, epics: { review } } }))
vi.stubGlobal('useToast', () => ({ add: vi.fn() }))

const decision = {
  id: 'd', runId: 'r', raisedAt: '', answer: null, question: 'Which export?', bindingDecision: 'D31',
  alternatives: [
    { label: 'Keep filtering', effect: 'As approved', changesBehaviour: false },
    { label: 'Follow the target', effect: 'Every row', changesBehaviour: true }
  ],
  affectedChanges: ['COR-41: filtered exports']
}
const item = { taskId: 't', decision } as unknown as { taskId: string, decision: typeof decision }
const Stub = defineComponent({ props: { label: String, ariaLabel: String }, emits: ['click'], setup: (p, { emit }) => () => h('button', { 'aria-label': p.ariaLabel, 'onClick': () => emit('click') }, p.label) })
const render = (shown = item) => mount(InboxEpicDecision, { props: { item: shown }, global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { AppButton: Stub, AppAlert: Stub } } })

it('shows the question, alternatives, what each does to approval and the affected changes', () => {
  const text = render().text()
  for (const part of ['Which export?', 'D31', 'Keep filtering', 'Keeps your approval', 'Follow the target', 'Changes approved behaviour', 'COR-41: filtered exports']) expect(text).toContain(part)
})

it('sends the chosen alternative', async () => {
  const wrapper = render()
  await wrapper.get('[aria-label="Choose Follow the target"]').trigger('click')
  await flushPromises()
  expect(act).toHaveBeenCalledWith('t', { action: 'decide', alternative: 1 })
})

it('asks for words when the agent gave no alternatives', () => {
  const wrapper = render({ ...item, decision: { ...decision, alternatives: [], affectedChanges: [] } })
  expect(wrapper.text()).toContain('Choose Answer and write your decision')
  expect(wrapper.find('ul').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('Affected changes')
})

it('sends an epic fix\'s answer to the epic, which has no task', async () => {
  review.mockClear()
  const wrapper = mount(InboxEpicDecision, { props: { item: { taskId: null, epicId: 'e', headSha: 'h', decision } }, global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { AppButton: Stub, AppAlert: Stub } } })
  await wrapper.get('[aria-label="Choose Keep filtering"]').trigger('click')
  await flushPromises()
  expect(review).toHaveBeenCalledWith('e', { action: 'decide', alternative: 0, headSha: 'h' })
})
