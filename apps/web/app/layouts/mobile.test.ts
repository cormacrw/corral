// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'

// Nuxt auto-imports the layout uses, standing in for a phone on Home
const shellData = { projects: [], planSessions: [], runner: { online: true }, inboxCount: 0, agents: [] }
vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('watch', watch)
vi.stubGlobal('useShell', () => shellData)
vi.stubGlobal('useAllProjectLists', vi.fn())
vi.stubGlobal('usePendingPlan', () => ({ entries: ref({}) }))
const route = reactive({ path: '/home', fullPath: '/home' })
vi.stubGlobal('useRoute', () => route)
vi.stubGlobal('useRouter', () => ({ replace: vi.fn(), options: { history: { go: vi.fn() } } }))
const mobileHeader = ref<{ title: string, eyebrow: string } | null>(null)
vi.stubGlobal('useMobileHeader', () => mobileHeader)

const { default: MobilePageHeader } = await import('~/features/shell/components/MobilePageHeader.vue')
const { default: MobileLayout } = await import('./mobile.vue')

const AppPanel = defineComponent({ setup: (_, { slots }) => () => h('div', { 'data-testid': 'panel' }, slots.default?.()) })
const Plain = defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) })
const Link = defineComponent({ props: ['to', 'custom'], setup: (props, { slots }) => () => props.custom !== undefined ? slots.default?.({ href: props.to }) : h('a', { href: props.to }, slots.default?.()) })
const global = { components: { AppPanel, AppButton: Link, Icon: Plain, NuxtLink: Link, ShellBanners: Plain, MobilePageHeader } }

enableAutoUnmount(afterEach)
afterEach(() => {
  mobileHeader.value = null
  route.path = route.fullPath = '/home'
})

describe('mobile layout', () => {
  it.each(['/settings', '/settings/runner'])('selects the Settings tab on %s', (path) => {
    route.path = route.fullPath = path
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(AppPanel, () => h(MobilePageHeader)) } })
    expect(wrapper.get('nav [aria-current="page"]').text()).toBe('Settings')
    expect(wrapper.find('[data-testid="mobile-page-header"] [aria-label="Back to Home"]').exists()).toBe(false)
    if (path !== '/settings') expect(wrapper.get('[data-testid="mobile-page-header"] [aria-label="Back to Settings"]').attributes('href')).toBe('/settings')
    wrapper.unmount()
  })

  it('returns from an agent to Home without selecting a tab and keeps Agent settings', () => {
    route.path = route.fullPath = '/agents/atlas'
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(AppPanel, () => h(MobilePageHeader)) } })
    expect(wrapper.get('[data-testid="mobile-page-header"] [aria-label="Back to Home"]').attributes('href')).toBe('/home')
    expect(wrapper.get('[data-testid="mobile-page-header"] [aria-label="Agent settings"]').attributes('href')).toBe('/settings/agents')
    expect(wrapper.find('nav [aria-current="page"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps Project settings on the project overview', () => {
    route.path = route.fullPath = '/projects/corral'
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(AppPanel, () => h(MobilePageHeader)) } })
    expect(wrapper.get('[data-testid="mobile-page-header"] [aria-label="Project settings"]').attributes('href')).toBe('/projects/corral/settings')
    wrapper.unmount()
  })

  it.each([
    ['/projects/corral/board', '/projects/corral', 'Back to the project', 'Board'],
    ['/projects/corral/backlog', '/projects/corral', 'Back to the project', 'Backlog'],
    ['/projects/corral/pull-requests', '/projects/corral', 'Back to the project', 'Pull requests'],
    ['/projects/corral/settings', '/projects/corral', 'Back to the project', 'Settings'],
    ['/projects/corral', '/projects', 'Back to Projects', 'Overview'],
    ['/plan/session-1', '/plan', 'Back to Plan', 'Plan'],
    ['/inbox/item-1', '/inbox', 'Back to Inbox', 'Inbox'],
    ['/settings/profile', '/settings', 'Back to Settings', 'Profile'],
    ['/settings/agents', '/settings', 'Back to Settings', 'Agents'],
    ['/settings/performance', '/settings', 'Back to Settings', 'Performance'],
    ['/settings/appearance', '/settings', 'Back to Settings', 'Appearance']
  ])('preserves back navigation on %s', (path, target, label, title) => {
    route.path = route.fullPath = path
    const wrapper = mount(MobilePageHeader, { global })
    expect(wrapper.get(`[aria-label="${label}"]`).attributes('href')).toBe(target)
    expect(wrapper.get('h1').text()).toBe(title)
    wrapper.unmount()
  })

  it.each(['Home', 'Plan', 'Inbox', 'Projects', 'Settings'])('selects the %s tab on its root and adds no header of its own', (title) => {
    route.path = route.fullPath = `/${title.toLowerCase()}`
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(AppPanel, () => h('p', 'Content')) } })
    expect(wrapper.find('[data-testid="mobile-page-header"]').exists()).toBe(false)
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.get('nav [aria-current="page"]').text()).toBe(title)
    wrapper.unmount()
  })

  it('uses the Inbox item context above its task ref', () => {
    route.path = route.fullPath = '/inbox/item-1'
    mobileHeader.value = { title: 'COR-5', eyebrow: 'Inbox · 1 of 3' }
    const wrapper = mount(MobilePageHeader, { global, props: { compact: true } })
    expect(wrapper.get('h1').text()).toBe('COR-5')
    expect(wrapper.get('p').text()).toBe('Inbox · 1 of 3')
    expect(wrapper.get('[aria-label="Back to Inbox"]').attributes('href')).toBe('/inbox')
    wrapper.unmount()
  })

  it('renders working actions in the compact row', async () => {
    route.path = route.fullPath = '/plan/session-1'
    const click = vi.fn()
    const wrapper = mount(MobilePageHeader, {
      global, props: { compact: true },
      slots: { actions: () => h('button', { onClick: click }, 'Action') }
    })
    await wrapper.get('[data-testid="mobile-page-actions"] button').trigger('click')
    expect(click).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it.each(['/plan/session-1', '/inbox/item-1', '/tasks/COR-1', '/agents/atlas/run-1'])('leaves full-height screens without a shell header or tab bar on %s', (path) => {
    route.path = route.fullPath = path
    const wrapper = mount(MobileLayout, { global })
    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.find('nav').exists()).toBe(false)
    wrapper.unmount()
  })
})
