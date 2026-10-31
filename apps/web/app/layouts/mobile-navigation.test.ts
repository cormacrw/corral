// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, watch } from 'vue'

const replace = vi.fn()
const go = vi.fn()
vi.stubGlobal('useAllProjectLists', vi.fn())
vi.stubGlobal('computed', computed)
vi.stubGlobal('watch', watch)
vi.stubGlobal('useShell', () => ({ projects: [], planSessions: [{ unread: true }], inboxCount: 3 }))
vi.stubGlobal('useRoute', () => ({ path: '/home' }))
vi.stubGlobal('useRouter', () => ({ replace, options: { history: { go } } }))

const { default: Mobile } = await import('./mobile.vue')
const { recordAppHistoryPosition, resetAppHistory, stepsToAppStart } = await import('~/utils/app-history')
const Slot = defineComponent({ name: 'PanelStub', setup: (_, { slots }) => () => slots.default?.() })
const Link = defineComponent({
  name: 'LinkStub',
  props: ['to'],
  setup: (props, { slots }) => () => slots.default?.({ href: props.to })
})
function shell() {
  return mount(Mobile, { global: { components: { NuxtLink: Link, UDashboardGroup: Slot }, stubs: { ShellBanners: true, UIcon: true } } })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({ position: 0 }, '')
  resetAppHistory()
  recordAppHistoryPosition(0)
})

const tap = (path: string) => ({ path, force: false })
const forced = (path: string) => ({ path, force: true })

describe('mobile tab navigation', () => {
  it('replaces a root without pushing, retaining active state and indicators', async () => {
    const wrapper = shell()
    expect(wrapper.get('[href="/home"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-testid="inbox-count"]').text()).toBe('3')
    expect(wrapper.find('[aria-label="Unread"]').exists()).toBe(true)
    await wrapper.get('[href="/inbox"]').trigger('click', { button: 0 })
    expect(go).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith(tap('/inbox'))
    wrapper.unmount()
  })

  it('waits for traversal from a detail/deep link and uses the latest tab tap', async () => {
    window.history.replaceState({ position: 4 }, '')
    const wrapper = shell()
    await wrapper.get('[href="/inbox"]').trigger('click', { button: 0 })
    await wrapper.get('[href="/settings"]').trigger('click', { button: 0 })
    expect(go).toHaveBeenCalledExactlyOnceWith(-4, false)
    expect(replace).not.toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(replace).toHaveBeenCalledExactlyOnceWith(forced('/settings'))
    wrapper.unmount()
  })

  it('honours a new tap while replacement is still settling', async () => {
    let finish!: () => void
    replace.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const wrapper = shell()
    await wrapper.get('[href="/inbox"]').trigger('click', { button: 0 })
    await wrapper.get('[href="/settings"]').trigger('click', { button: 0 })
    finish()
    await flushPromises()
    expect(replace.mock.calls.map(args => args[0])).toEqual([tap('/inbox'), tap('/settings')])
    expect(go).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('goes back only to Corral\'s first entry when the browser tab had earlier pages', async () => {
    // A tab opened from another site: Corral's first entry is position 2
    resetAppHistory()
    recordAppHistoryPosition(2)
    window.history.replaceState({ position: 5 }, '')
    const wrapper = shell()
    await wrapper.get('[href="/inbox"]').trigger('click', { button: 0 })
    expect(go).toHaveBeenCalledExactlyOnceWith(-3, false)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(replace).toHaveBeenCalledExactlyOnceWith(forced('/inbox'))
    wrapper.unmount()
  })

  it('stays put on Corral\'s first entry instead of leaving the app', async () => {
    resetAppHistory()
    recordAppHistoryPosition(2)
    window.history.replaceState({ position: 2 }, '')
    const wrapper = shell()
    await wrapper.get('[href="/inbox"]').trigger('click', { button: 0 })
    expect(go).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledExactlyOnceWith(tap('/inbox'))
    wrapper.unmount()
  })

  it('lowers the start when Back lands on an earlier Corral entry', () => {
    resetAppHistory()
    recordAppHistoryPosition(3)
    recordAppHistoryPosition(1)
    recordAppHistoryPosition(4)
    expect(stepsToAppStart(4)).toBe(3)
  })

  it('forces the replace after traversal so a tab root pushed from a page keeps its URL', async () => {
    // Home, then an in-page link pushed /inbox at position 1; the router's
    // current route stays /inbox while the traversal is unobserved.
    window.history.replaceState({ position: 1 }, '')
    const wrapper = shell()
    await wrapper.get('[href="/inbox"]').trigger('click', { button: 0 })
    expect(go).toHaveBeenCalledExactlyOnceWith(-1, false)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(replace).toHaveBeenCalledExactlyOnceWith(forced('/inbox'))
    wrapper.unmount()
  })

  it('keeps modified clicks as ordinary links', async () => {
    const wrapper = shell()
    await wrapper.get('[href="/inbox"]').trigger('click', { button: 0, ctrlKey: true })
    expect(go).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
