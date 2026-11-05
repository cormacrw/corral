// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { AGENTS_MAY_BE_WORKING, useInboxView } from '~/features/inbox/composables/useInboxView'
import { testQueryClient } from '~/queries/mount-with-query'
import { inbox } from '~/prototype/fixtures'
import InboxEmpty from '~/features/inbox/components/InboxEmpty.vue'

enableAutoUnmount(afterEach)

vi.mock('~/composables/useApi', () => ({ api: { plan: { sessions: vi.fn() } } }))
vi.mock('~/features/inbox/composables/useInboxView', async importOriginal => ({ ...await importOriginal<object>(), useInboxView: vi.fn() }))

const replace = vi.fn()
const button = vue.defineComponent({ props: ['label', 'to'], emits: ['click'], setup: (props, { emit }) => () => vue.h('a', { href: props.to, onClick: () => emit('click') }, props.label) })

async function show(selectedId: string | null, count = 0) {
  const tab = vue.ref('needsYou')
  vi.mocked(useInboxView).mockReturnValue({ inbox: vue.ref(inbox()), count: vue.ref(count), selected: vue.ref(null), selectedId: vue.ref(selectedId), tab } as never)
  const wrapper = mount(InboxEmpty, { global: {
    plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
    components: { AppButton: button },
    stubs: { Icon: true }
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

it('explains an empty queue without saying the work is finished', async () => {
  const { wrapper } = await show(null)
  expect(wrapper.text()).toContain(AGENTS_MAY_BE_WORKING)
  expect(wrapper.findAll('a')).toHaveLength(0)
})

it('sends a link to a read Plan reply to its conversation, with no decision to make', async () => {
  const { wrapper } = await show('session-1')
  expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual(['/plan/session-1'])
})

it('sends a link to a resolved task to the task', async () => {
  const task = inbox().activity.find(i => i.type === 'activity')!
  const { wrapper } = await show(task.taskId)
  expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual([`/tasks/${task.taskRef}`])
})

it('says an unknown link has nothing to decide, with nowhere to send it', async () => {
  const { wrapper } = await show('gone')
  expect(wrapper.text()).toContain('isn\'t waiting on you any more')
  expect(wrapper.findAll('a')).toHaveLength(0)
})
