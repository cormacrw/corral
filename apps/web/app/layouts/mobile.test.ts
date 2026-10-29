// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mount } from '@vue/test-utils'
import { compile } from 'tailwindcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'

// The mobile shell's styling comes from Tailwind classes, so the test builds
// the CSS for the classes the shell and page render and checks the computed
// style. happy-dom ignores cascade layers and doesn't match Tailwind's
// :is(.x > *) variant selectors, so the utilities are built unlayered and
// those selectors flattened to plain child selectors.
const require = createRequire(import.meta.url)
async function tailwind(html: string): Promise<string> {
  const compiler = await compile('@import "tailwindcss/theme.css"; @tailwind utilities;', {
    base: '/',
    loadStylesheet: async (id: string) => {
      const path = require.resolve(id)
      return { path, base: '/', content: readFileSync(path, 'utf8') }
    }
  })
  const candidates = [...html.matchAll(/class="([^"]*)"/g)].flatMap(match => match[1]!.split(/\s+/)).filter(Boolean)
  return compiler.build(candidates).replace(/:is\(([^()]+ > \*)\)/g, '$1')
}

// Nuxt auto-imports the layout uses, standing in for a phone on Home
const live = { state: ref({ projects: [], tasks: {}, planSessions: [], runner: { online: true }, connection: 'open', inboxCount: 0, agents: [] }), loadTasks: vi.fn() }
vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('watch', watch)
vi.stubGlobal('useLive', () => live)
const route = reactive({ path: '/home', fullPath: '/home' })
vi.stubGlobal('useRoute', () => route)
const mobileHeader = ref<{ title: string, eyebrow: string } | null>(null)
vi.stubGlobal('useMobileHeader', () => mobileHeader)

const { default: MobilePageHeader } = await import('../components/MobilePageHeader.vue')
const { default: MobileLayout } = await import('./mobile.vue')

// UDashboardGroup and UDashboardPanel render their roots with Nuxt UI's
// classes; Home puts its content in the panel's default slot, not #body
const UDashboardGroup = defineComponent({ setup: (_, { slots }) => () => h('div', { class: 'fixed inset-0 flex overflow-hidden' }, slots.default?.()) })
const UDashboardPanel = defineComponent({ setup: (_, { slots }) => () => h('div', { 'class': 'relative flex flex-col min-w-0 min-h-svh shrink-0 flex-1', 'data-testid': 'panel' }, slots.default?.()) })
const Plain = defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) })
const Link = defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) })
const global = { components: { UDashboardGroup, UDashboardPanel, UButton: Link, UIcon: Plain, NuxtLink: Link, ShellBanners: Plain, MobilePageHeader } }

const Home = defineComponent({
  setup: () => () => h(UDashboardPanel, () => [h(MobilePageHeader), h('div', { class: 'flex flex-col gap-4 p-4' }, Array.from({ length: 30 }, (_, i) => h('p', { class: 'h-20' }, `Item ${i}`)))])
})

afterEach(() => {
  mobileHeader.value = null
  document.head.innerHTML = ''
  route.path = route.fullPath = '/home'
})

describe('mobile layout', () => {
  it.each(['/settings', '/settings/runner'])('selects the Settings tab on %s', (path) => {
    route.path = route.fullPath = path
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(UDashboardPanel, () => h(MobilePageHeader)) } })
    const tabs = wrapper.findAll('nav a')
    expect(tabs.map(tab => tab.text())).toEqual(['Home', 'Plan', 'Inbox', 'Projects', 'Settings'])
    expect(tabs.map(tab => tab.attributes('href'))).toEqual(['/home', '/plan', '/inbox', '/projects', '/settings'])
    expect(wrapper.get('nav [aria-current="page"]').text()).toBe('Settings')
    expect(wrapper.find('[data-testid="mobile-page-header"] [aria-label="Back to Home"]').exists()).toBe(false)
    if (path !== '/settings') expect(wrapper.get('[data-testid="mobile-page-header"] [aria-label="Back to Settings"]').attributes('href')).toBe('/settings')
    wrapper.unmount()
  })

  it.each(['/home', '/plan', '/inbox', '/projects', '/settings', '/settings/runner', '/agents/atlas', '/projects/corral', '/projects/corral/board', '/projects/corral/backlog'])('has no global search or settings action on %s', (path) => {
    route.path = route.fullPath = path
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(UDashboardPanel, () => h(MobilePageHeader)) } })
    expect(wrapper.find('[data-testid="mobile-page-header"] [aria-label="Search"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-page-header"] [aria-label="Settings"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="open-search"]').exists()).toBe(false)
    // Actions now belong to the row slot; the shell has no target.
    expect(wrapper.find('#mobile-header-actions').exists()).toBe(false)
    expect(wrapper.find('[data-testid="runner-status"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('returns from an agent to Home without selecting a tab and keeps Agent settings', () => {
    route.path = route.fullPath = '/agents/atlas'
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(UDashboardPanel, () => h(MobilePageHeader)) } })
    expect(wrapper.get('[data-testid="mobile-page-header"] [aria-label="Back to Home"]').attributes('href')).toBe('/home')
    expect(wrapper.get('[data-testid="mobile-page-header"] [aria-label="Agent settings"]').attributes('href')).toBe('/settings/agents')
    expect(wrapper.find('nav [aria-current="page"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps Project settings on the project overview', () => {
    route.path = route.fullPath = '/projects/corral'
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(UDashboardPanel, () => h(MobilePageHeader)) } })
    expect(wrapper.get('[data-testid="mobile-page-header"] [aria-label="Project settings"]').attributes('href')).toBe('/projects/corral/settings')
    wrapper.unmount()
  })

  it('makes a page whose content is in the panel\'s default slot the vertical scroll container', async () => {
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(Home) }, attachTo: document.body })
    const style = document.createElement('style')
    style.textContent = await tailwind(wrapper.html())
    document.head.append(style)

    const panel = wrapper.get('[data-testid="panel"]').element
    expect(getComputedStyle(panel).overflowY).toBe('auto')
    // It fits above the tab bar rather than growing to its content
    expect(getComputedStyle(panel).minHeight).toBe('0px')
    expect(getComputedStyle(panel.parentElement!).flexGrow).toBe('1')
    // The title is inside the scrolling panel; only the tab bar sits outside it.
    expect(panel.contains(wrapper.get('[data-testid="mobile-page-header"]').element)).toBe(true)
    expect(wrapper.find('header').exists()).toBe(false)
    expect(panel.closest('header')).toBeNull()
    expect(wrapper.get('nav[aria-label="Main"]').element.contains(panel)).toBe(false)
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
    ['/settings/appearance', '/settings', 'Back to Settings', 'Appearance']
  ])('preserves back navigation on %s', (path, target, label, title) => {
    route.path = route.fullPath = path
    const wrapper = mount(MobilePageHeader, { global })
    expect(wrapper.get(`[aria-label="${label}"]`).attributes('href')).toBe(target)
    expect(wrapper.get('h1').text()).toBe(title)
    wrapper.unmount()
  })

  it.each(['Home', 'Plan', 'Inbox', 'Projects', 'Settings'])('shows just the large %s title on a top-level tab', (title) => {
    route.path = `/${title.toLowerCase()}`
    const wrapper = mount(MobilePageHeader, { global })
    expect(wrapper.get('h1').text()).toBe(title)
    expect(wrapper.get('h1').classes()).toContain('text-2xl')
    expect(wrapper.find('p').exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
    wrapper.unmount()
  })

  it('uses the Inbox item context above its task ref', () => {
    route.path = '/inbox/item-1'
    mobileHeader.value = { title: 'COR-5', eyebrow: 'Inbox · 1 of 3' }
    const wrapper = mount(MobilePageHeader, { global, props: { compact: true } })
    expect(wrapper.get('h1').text()).toBe('COR-5')
    expect(wrapper.get('p').text()).toBe('Inbox · 1 of 3')
    expect(wrapper.get('[aria-label="Back to Inbox"]').attributes('href')).toBe('/inbox')
    wrapper.unmount()
  })

  it('renders working actions directly in the safe-area padded compact row', async () => {
    route.path = '/plan/session-1'
    const click = vi.fn()
    const wrapper = mount(MobilePageHeader, {
      global, props: { compact: true },
      slots: { actions: () => h('button', { onClick: click }, 'Action') }
    })
    expect(wrapper.classes()).toContain('pt-[env(safe-area-inset-top)]')
    expect(wrapper.classes()).toContain('shrink-0')
    expect(wrapper.classes()).toContain('border-b')
    await wrapper.get('[data-testid="mobile-page-actions"] button').trigger('click')
    expect(click).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it.each(['/plan/session-1', '/inbox/item-1', '/tasks/COR-1', '/agents/atlas/run-1'])('leaves full-height screens without a shell header or tab bar on %s', (path) => {
    route.path = path
    const wrapper = mount(MobileLayout, { global })
    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.find('nav').exists()).toBe(false)
    wrapper.unmount()
  })
})
