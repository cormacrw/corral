// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import ShellBanners from './ShellBanners.vue'

vi.mock('~/composables/useApi', () => ({ api: { liftUpdateHold: vi.fn() } }))

afterEach(() => vi.unstubAllGlobals())

it('offers a human way to lift an update hold and reports failures', async () => {
  const toast = { add: vi.fn() }
  vi.stubGlobal('computed', vue.computed)
  vi.stubGlobal('useRoute', () => ({ params: {} }))
  vi.stubGlobal('useToast', () => toast)
  vi.stubGlobal('useLive', () => ({ state: vue.ref({ status: { updating: true, stopped: false }, projects: [] }) }))
  const alert = vue.defineComponent({
    props: ['title', 'actions'],
    setup: props => () => vue.h('div', [props.title, ...(props.actions ?? []).map((action: { label: string, onClick: () => void }) => vue.h('button', { onClick: action.onClick }, action.label))])
  })
  const wrapper = mount(ShellBanners, { global: { components: { UAlert: alert } } })
  expect(wrapper.text()).toContain('Corral is waiting to update')
  expect(api.liftUpdateHold).not.toHaveBeenCalled()
  vi.mocked(api.liftUpdateHold).mockRejectedValueOnce(new Error('Connection lost'))
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(api.liftUpdateHold).toHaveBeenCalledOnce()
  expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not lift update hold', description: 'Connection lost' }))
  wrapper.unmount()
})
