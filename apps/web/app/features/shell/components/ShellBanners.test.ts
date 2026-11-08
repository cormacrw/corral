// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/queries/api'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import ShellBanners from '~/features/shell/components/ShellBanners.vue'

vi.mock('~/queries/api', () => ({ api: { liftUpdateHold: vi.fn() } }))
vi.mock('~/queries/stream', () => ({ useLive: () => ({ connection: { value: 'open' } }) }))

afterEach(() => vi.unstubAllGlobals())

it('offers a human way to lift an update hold and reports failures', async () => {
  const toast = { add: vi.fn() }
  vi.stubGlobal('computed', vue.computed)
  vi.stubGlobal('useRoute', () => ({ params: {} }))
  vi.stubGlobal('useToast', () => toast)
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false, gcTime: Infinity } })
  client.setQueryData(keys.status(), { updating: true, stopped: false })
  client.setQueryData(keys.runner(), { online: true, runners: [] })
  client.setQueryData(keys.projects.list(), [])
  const alert = vue.defineComponent({
    props: ['title', 'actions'],
    setup: props => () => vue.h('div', [props.title, ...(props.actions ?? []).map((action: { label: string, onClick: () => void }) => vue.h('button', { onClick: action.onClick }, action.label))])
  })
  const wrapper = mount(ShellBanners, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { AppAlert: alert } } })
  expect(api.liftUpdateHold).not.toHaveBeenCalled()
  vi.mocked(api.liftUpdateHold).mockRejectedValueOnce(new Error('Connection lost'))
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(api.liftUpdateHold).toHaveBeenCalledOnce()
  expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ description: 'Connection lost' }))
  wrapper.unmount()
  client.clear()
})
