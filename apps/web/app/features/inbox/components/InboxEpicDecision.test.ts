// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import InboxEpicDecision from '~/features/inbox/components/InboxEpicDecision.vue'
import { testQueryClient } from '~/queries/mount-with-query'

enableAutoUnmount(afterEach)

const review = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })))
vi.mock('~/queries/api', () => ({ api: { epics: { review } } }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const decision = {
  id: 'd', runId: 'r', raisedAt: '', answer: null, question: 'Which export?', bindingDecision: 'D31',
  alternatives: [
    { label: 'Keep filtering', effect: 'As approved', changesBehaviour: false },
    { label: 'Follow the target', effect: 'Every row', changesBehaviour: true }
  ],
  affectedChanges: ['COR-41: filtered exports']
}
const item = { epicId: 'e', headSha: 'h', decision }
const Stub = defineComponent({ props: { label: String, ariaLabel: String }, emits: ['click'], setup: (p, { emit }) => () => h('button', { 'aria-label': p.ariaLabel, 'onClick': () => emit('click') }, p.label) })
const render = (shown = item) => mount(InboxEpicDecision, { props: { item: shown }, global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { AppButton: Stub, AppAlert: Stub } } })

it('shows the question, alternatives, which one changes approved behaviour and the affected changes', () => {
  const wrapper = render()
  for (const part of ['Which export?', 'D31', 'COR-41: filtered exports']) expect(wrapper.text()).toContain(part)
  const [keeps, changes] = wrapper.findAll('li')
  expect(keeps!.text()).toContain('Keep filtering')
  expect(changes!.text()).toContain('Follow the target')
  // What each does to the human's approval differs
  expect(keeps!.text().replace('Keep filtering', '').replace('As approved', '')).not.toBe(changes!.text().replace('Follow the target', '').replace('Every row', ''))
})

it('sends the chosen alternative to the task, on the head the human saw', async () => {
  const wrapper = render()
  await wrapper.get('[aria-label="Choose Follow the target"]').trigger('click')
  await flushPromises()
  expect(review).toHaveBeenCalledWith('e', { action: 'decide', alternative: 1, headSha: 'h' })
})

it('asks for words when the agent gave no alternatives', () => {
  const wrapper = render({ ...item, decision: { ...decision, alternatives: [], affectedChanges: [] } })
  expect(wrapper.find('[aria-label^="Choose "]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('Affected changes')
})
