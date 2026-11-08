// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { computed } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Task } from '@corral/contracts'
import { api } from '~/queries/api'
import { testQueryClient } from '~/queries/mount-with-query'
import InboxPanelEpicContext from '~/features/inbox/components/InboxPanelEpicContext.vue'

vi.mock('~/queries/api', () => ({ api: { epics: { get: vi.fn() } } }))

const wrappers: VueWrapper[] = []
const openEpic = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useTaskFlyout', () => ({ openEpic }))
})
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount())
  vi.unstubAllGlobals()
})

async function show(task: Partial<Task>, reviewMode = 'epic') {
  vi.mocked(api.epics.get).mockResolvedValue({ id: 'epic-1', title: 'Saved searches', reviewMode } as Awaited<ReturnType<typeof api.epics.get>>)
  const wrapper = mount(InboxPanelEpicContext, {
    props: { task: task as Task, prNumber: '64', canAct: true },
    global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], stubs: { Icon: true } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

it.each(['epic', 'each_task'])('names a parent reviewed as %s, with a link that opens it', async (reviewMode) => {
  const wrapper = await show({ epicId: 'epic-1', type: 'task' }, reviewMode)
  expect(wrapper.text()).toContain('Saved searches')
  await wrapper.get('button').trigger('click')
  expect(openEpic).toHaveBeenCalledWith('epic-1')
})

it.each([
  ['task', true],
  ['spike', false],
  ['design', false]
] as const)('mentions merging the PR into the parent for a %s: %s, and never once it can\'t act', async (type, mentioned) => {
  const wrapper = await show({ epicId: 'epic-1', type })
  expect(wrapper.text().includes('PR #64')).toBe(mentioned)
  await wrapper.setProps({ canAct: false })
  expect(wrapper.text()).not.toContain('PR #64')
})

it('adds nothing for a parent whose tasks merge directly', async () => {
  const wrapper = await show({ epicId: 'epic-1', type: 'task' }, 'direct')
  expect(wrapper.text()).toBe('')
})

it('does not fetch a parent or add context for a standalone task', async () => {
  const wrapper = await show({ epicId: null, type: 'task' })
  expect(wrapper.text()).toBe('')
  expect(api.epics.get).not.toHaveBeenCalled()
})
