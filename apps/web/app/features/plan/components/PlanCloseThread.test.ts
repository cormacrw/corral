// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { testQueryClient } from '~/queries/mount-with-query'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, ref, resolveComponent } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { PlanSession } from '@corral/contracts'
import PlanCloseThread from '~/features/plan/components/PlanCloseThread.vue'

enableAutoUnmount(afterEach)

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
  vi.stubGlobal('useShell', () => ({ agents: [{ role: 'pm', name: 'Juno' }] }))
  vi.stubGlobal('computed', computed)
  const wrapper = mount(PlanCloseThread, { props: { session }, global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { AppButton: Button, AppModal: Dialog } } })
  const click = (label: string, inDialog = false) => (inDialog ? wrapper.get('section') : wrapper).findAll('button').find(b => b.text() === label)!.trigger('click')
  return {
    wrapper,
    // The menu's Close thread, which asks first
    open: () => click('Close thread'),
    confirm: () => click('Close thread', true),
    cancel: () => click('Cancel', true)
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('requires confirmation and returns to a new session after closing the current one', async () => {
  close.mockResolvedValue({})
  const view = setup()
  await view.open()
  expect(close).not.toHaveBeenCalled()
  await view.confirm()
  await flushPromises()
  expect(close).toHaveBeenCalledWith('s1')
  expect(remove).toHaveBeenCalledWith('s1')
  expect(push).toHaveBeenCalledWith('/plan')
})
it('does not navigate when closing another thread and lets the human cancel', async () => {
  const view = setup('other')
  await view.open()
  await view.cancel()
  expect(close).not.toHaveBeenCalled()
  await view.open()
  await view.confirm()
  await flushPromises()
  expect(close).toHaveBeenCalledWith('s1')
  expect(push).not.toHaveBeenCalled()
})
it('keeps the session and confirmation when closing fails', async () => {
  close.mockRejectedValue(new Error('Offline'))
  const view = setup()
  await view.open()
  await view.confirm()
  await flushPromises()
  expect(view.wrapper.find('section').exists()).toBe(true)
  expect(remove).not.toHaveBeenCalled()
  expect(push).not.toHaveBeenCalled()
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ description: 'Offline', color: 'error' }))
})
