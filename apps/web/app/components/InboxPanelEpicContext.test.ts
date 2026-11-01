// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { testQueryClient } from '~/queries/mount-with-query'
import InboxPanelEpicContext from './InboxPanelEpicContext.vue'

vi.mock('~/composables/useApi', () => ({ api: { epics: { get: vi.fn() } } }))
afterEach(() => vi.unstubAllGlobals())

it('shows epic context and a working epic link for both grouped modes, with PR wording only for builds', async () => {
  for (const reviewMode of ['epic', 'each_task', 'direct'] as const) {
    for (const type of ['task', 'spike', 'design'] as const) {
      const openEpic = vi.fn()
      vi.stubGlobal('computed', computed)
      vi.stubGlobal('useTaskFlyout', () => ({ openEpic }))
      vi.mocked(api.epics.get).mockResolvedValue({ id: 'epic-1', title: 'Saved searches', reviewMode } as Awaited<ReturnType<typeof api.epics.get>>)
      const wrapper = mount(InboxPanelEpicContext, {
        props: { task: { epicId: 'epic-1', type } as Task, prNumber: '64', canAct: true },
        global: {
          plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
          components: { ULink: defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }) }
        }
      })
      await flushPromises()
      if (reviewMode === 'direct') {
        expect(wrapper.text()).toBe('')
      } else {
        expect(wrapper.text()).toContain('Part of Saved searches. You\'ll review it all together at the epic PR.')
        await wrapper.get('a').trigger('click')
        expect(openEpic).toHaveBeenCalledWith('epic-1')
        expect(wrapper.text().includes('Approve and merge PR #64 into the epic branch, or request changes.')).toBe(type === 'task')
        await wrapper.setProps({ canAct: false })
        expect(wrapper.text()).not.toContain('Approve and merge')
      }
      wrapper.unmount()
    }
  }
})

it('does not fetch an epic or add context for a standalone task', async () => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useTaskFlyout', () => ({ openEpic: vi.fn() }))
  vi.mocked(api.epics.get).mockClear()
  const wrapper = mount(InboxPanelEpicContext, {
    props: { task: { epicId: null, type: 'task' } as Task, prNumber: '64', canAct: true },
    global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] }
  })
  await flushPromises()
  expect(wrapper.text()).toBe('')
  expect(api.epics.get).not.toHaveBeenCalled()
  wrapper.unmount()
})
