// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useTaskFlyout } from '~/composables/useTaskFlyout'
import { testQueryClient } from '~/queries/mount-with-query'
import PlanPage from './index.vue'

vi.mock('~/composables/useApi', () => ({
  api: { setup: { clis: vi.fn(async () => []) } }
}))

// Opens the epic the way the sheet's breadcrumb and Epic row do
const TaskDetail = vue.defineComponent({
  props: ['taskRef', 'mode'],
  setup(props) {
    const flyout = useTaskFlyout()
    return () => vue.h('button', { 'data-task': props.taskRef, 'data-mode': props.mode, 'onClick': () => flyout.openEpic('epic-1') })
  }
})
const EpicDetail = vue.defineComponent({
  props: ['epicId', 'mode'],
  setup: props => () => vue.h('section', { 'data-epic': props.epicId, 'data-mode': props.mode })
})
const UDrawer = vue.defineComponent({
  props: ['open', 'title'],
  emits: ['update:open'],
  setup: (props, { slots, emit }) => () => props.open
    ? vue.h('div', { 'data-drawer': props.title }, [
        vue.h('button', { 'data-close': '', 'onClick': () => emit('update:open', false) }),
        slots.content?.()
      ])
    : null
})
const UDashboardPanel = vue.defineComponent({
  setup: (_props, { slots }) => () => vue.h('div', slots.default?.())
})
const mounted: { unmount: () => void }[] = []

async function render(url: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)*', component: { template: '<div />' } }] })
  await router.push(url)
  for (const name of ['ref', 'computed', 'watch'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useRoute', () => ({
    get query() { return router.currentRoute.value.query },
    get fullPath() { return router.currentRoute.value.fullPath }
  }))
  vi.stubGlobal('useRouter', () => router)
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(true) }))
  vi.stubGlobal('useTaskFlyout', useTaskFlyout)
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useLocalStorage', (_key: string, value: unknown) => vue.ref(value))
  vi.stubGlobal('useLive', () => ({ state: vue.ref({ loaded: true, runner: { online: false }, agents: [], projects: [], tasks: {} }) }))
  vi.stubGlobal('usePendingPlan', () => ({ restored: vue.ref(null) }))
  vi.stubGlobal('usePlanThreads', () => ({ add: vi.fn() }))
  const wrapper = mount(PlanPage, {
    global: {
      plugins: [router, [VueQueryPlugin, { queryClient: testQueryClient() }]],
      components: { TaskDetail, EpicDetail, UDrawer, UDashboardPanel },
      stubs: { AgentAvatar: true, UAlert: true, PromptComposer: true, PlanDrafts: true, TaskFlyout: true }
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
})

it('keeps the sheet open on the epic opened from the attached task', async () => {
  const { wrapper, router } = await render('/plan?task=COR-1')
  expect(wrapper.get('[data-drawer]').attributes('data-drawer')).toBe('Task COR-1')

  await wrapper.get('[data-task="COR-1"]').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/plan?epic=epic-1')
  expect(wrapper.get('[data-drawer]').attributes('data-drawer')).toBe('Epic')
  expect(wrapper.get('[data-epic="epic-1"]').attributes('data-mode')).toBe('flyout')
  expect(wrapper.find('[data-task]').exists()).toBe(false)
})

it('closes an epic with the sheet', async () => {
  const { wrapper, router } = await render('/plan?epic=epic-1')
  await wrapper.get('[data-close]').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/plan')
})
