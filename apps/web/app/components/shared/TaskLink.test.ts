// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import TaskLink from '~/components/shared/TaskLink.vue'
import { provideFlyoutHost } from '~/composables/useTaskFlyout'

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.unstubAllGlobals()
})

async function render(mobile = false, host = false, sheets = false) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)*', component: { template: '<div />' } }] })
  await router.push('/plan/session')
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useRoute', () => router.currentRoute.value)
  vi.stubGlobal('useRouter', () => router)
  vi.stubGlobal('useDevice', () => ({ isMobile: ref(mobile) }))
  // The screen rendering the flyout or sheets, around the link
  const screen = defineComponent({ setup() {
    provideFlyoutHost({ docked: () => host, sheets })
    return () => h(TaskLink, { taskRef: 'COR-12' })
  } })
  const wrapper = mount(screen, { global: { plugins: [router] } })
  return { wrapper, router }
}

it.each([[false, true, false], [true, false, true]])('keeps the thread with a desktop host or mobile sheets (%s, %s, %s)', async (mobile, host, sheets) => {
  const { wrapper, router } = await render(mobile, host, sheets)
  expect(wrapper.get('a').attributes('href')).toBe('/tasks/COR-12')
  await wrapper.get('a').trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/plan/session?task=COR-12')
  wrapper.unmount()
})

it.each([[false, false], [true, true]])('falls back to the task page without an eligible host (%s, %s)', async (mobile, host) => {
  const { wrapper, router } = await render(mobile, host)
  await wrapper.get('a').trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/tasks/COR-12')
  wrapper.unmount()
})

it.each([{ ctrlKey: true }, { metaKey: true }, { button: 1 }])('leaves modified clicks to the browser (%o)', async (options) => {
  const { wrapper, router } = await render(false, true)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...options })
  wrapper.get('a').element.dispatchEvent(event)
  await flushPromises()
  expect(event.defaultPrevented).toBe(false)
  expect(router.currentRoute.value.fullPath).toBe('/plan/session')
  wrapper.unmount()
})
