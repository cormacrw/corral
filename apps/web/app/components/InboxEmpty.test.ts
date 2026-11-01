// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { useInboxView } from '~/composables/useInboxView'
import { testQueryClient } from '~/queries/mount-with-query'
import { inbox } from '~/prototype/fixtures'
import InboxEmpty from './InboxEmpty.vue'

vi.mock('~/composables/useApi', () => ({ api: { plan: { sessions: vi.fn() } } }))
vi.mock('~/composables/useInboxView', async importOriginal => ({ ...await importOriginal<object>(), useInboxView: vi.fn() }))

const replace = vi.fn()
const button = vue.defineComponent({ props: ['label', 'to'], emits: ['click'], setup: (props, { emit }) => () => vue.h('a', { href: props.to, onClick: () => emit('click') }, props.label) })

async function show(selectedId: string | null, count = 0) {
  const tab = vue.ref('needsYou')
  vi.mocked(useInboxView).mockReturnValue({ inbox: vue.ref(inbox()), count: vue.ref(count), selected: vue.ref(null), selectedId: vue.ref(selectedId), tab } as never)
  const wrapper = mount(InboxEmpty, { global: {
    plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
    components: { UButton: button },
    stubs: { UIcon: true }
  } })
  await flushPromises()
  return { wrapper, tab }
}

beforeEach(() => {
  vi.stubGlobal('computed', vue.computed)
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.mocked(api.plan.sessions).mockResolvedValue([{ id: 'session-1' }] as never)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('explains an empty queue without saying the work is finished, and points to Activity', async () => {
  const { wrapper, tab } = await show(null)
  expect(wrapper.text()).toContain('Agents may still be working')
  expect(wrapper.text()).not.toContain('All clear')
  await wrapper.get('a').trigger('click')
  expect(tab.value).toBe('activity')
})

it('sends a link to a read Plan reply to its conversation, with no decision to make', async () => {
  const { wrapper } = await show('session-1')
  expect(wrapper.text()).toContain('isn\'t waiting on you any more')
  expect(wrapper.get('a[href="/plan/session-1"]').text()).toBe('Open in Plan')
})

it('sends a link to a resolved task to the task', async () => {
  const task = inbox().activity.find(i => i.type === 'activity')!
  const { wrapper } = await show(task.taskId)
  expect(wrapper.get(`a[href="/tasks/${task.taskRef}"]`).text()).toBe('Open task')
})

it('leaves an unknown link on Activity, off its dead route', async () => {
  const { wrapper, tab } = await show('gone')
  const links = wrapper.findAll('a')
  expect(links.map(a => a.text())).toEqual(['Open Activity'])
  await links[0]!.trigger('click')
  expect(tab.value).toBe('activity')
  expect(replace).toHaveBeenCalledWith('/inbox')
})
