// @vitest-environment happy-dom
import type { TaskInboxItem } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import InboxEpicDecision from './InboxEpicDecision.vue'
import { testQueryClient } from '~/queries/mount-with-query'

const act = vi.hoisted(() => vi.fn(() => Promise.resolve({ task: null })))
vi.mock('~/composables/useApi', () => ({ api: { inbox: { act } } }))
vi.stubGlobal('useToast', () => ({ add: vi.fn() }))

const decision = {
  id: 'd', runId: 'r', raisedAt: '', answer: null, question: 'Which export?', bindingDecision: 'D31',
  alternatives: [
    { label: 'Keep filtering', effect: 'As approved', changesBehaviour: false },
    { label: 'Follow the target', effect: 'Every row', changesBehaviour: true }
  ],
  affectedChanges: ['COR-41: filtered exports']
}
const item = { taskId: 't', decision } as unknown as TaskInboxItem & { decision: typeof decision }
const Stub = defineComponent({ props: { label: String, ariaLabel: String }, emits: ['click'], setup: (p, { emit }) => () => h('button', { 'aria-label': p.ariaLabel, 'onClick': () => emit('click') }, p.label) })
const render = () => mount(InboxEpicDecision, { props: { item }, global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { UButton: Stub, UAlert: Stub } } })

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
