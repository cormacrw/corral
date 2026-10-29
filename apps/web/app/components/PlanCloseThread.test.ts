// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref, resolveComponent } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { PlanSession } from '@corral/contracts'
import PlanCloseThread from './PlanCloseThread.vue'

const close = vi.hoisted(() => vi.fn())
vi.mock('~/composables/useApi', () => ({ api: { plan: { close } } }))
const push = vi.fn()
const remove = vi.fn()
const add = vi.fn()
const Button = defineComponent({ props: ['label'], emits: ['click'], setup: (props, { emit }) => () => h('button', { onClick: () => emit('click') }, props.label) })
const Dialog = defineComponent({ props: ['open'], setup: (props, { slots }) => () => props.open ? h('section', slots.body?.()) : null })
const session = { id: 's1', title: 'Thread', closed: false } as PlanSession
function setup(current = 's1') {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('resolveComponent', resolveComponent)
  vi.stubGlobal('useDevice', () => ({ isMobile: ref(false) }))
  vi.stubGlobal('useRoute', () => ({ params: { sessionId: current } }))
  vi.stubGlobal('useRouter', () => ({ push }))
  vi.stubGlobal('usePlanThreads', () => ({ remove }))
  vi.stubGlobal('useToast', () => ({ add }))
  return mount(PlanCloseThread, { props: { session }, global: { components: { UButton: Button, UModal: Dialog } } })
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('requires confirmation and returns to a new session after closing the current one', async () => {
  close.mockResolvedValue({})
  const wrapper = setup()
  await wrapper.get('button').trigger('click')
  expect(close).not.toHaveBeenCalled()
  await wrapper.get('section button:last-child').trigger('click')
  await flushPromises()
  expect(close).toHaveBeenCalledWith('s1')
  expect(remove).toHaveBeenCalledWith('s1')
  expect(push).toHaveBeenCalledWith('/plan')
})
it('does not navigate when closing another thread and lets the human cancel', async () => {
  const wrapper = setup('other')
  await wrapper.get('button').trigger('click')
  await wrapper.get('section button').trigger('click')
  expect(close).not.toHaveBeenCalled()
  await wrapper.get('button').trigger('click')
  await wrapper.get('section button:last-child').trigger('click')
  await flushPromises()
  expect(close).toHaveBeenCalledWith('s1')
  expect(push).not.toHaveBeenCalled()
})
it('keeps the session and confirmation when closing fails', async () => {
  close.mockRejectedValue(new Error('Offline'))
  const wrapper = setup()
  await wrapper.get('button').trigger('click')
  await wrapper.get('section button:last-child').trigger('click')
  await flushPromises()
  expect(wrapper.find('section').exists()).toBe(true)
  expect(remove).not.toHaveBeenCalled()
  expect(push).not.toHaveBeenCalled()
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ description: 'Offline', color: 'error' }))
})
