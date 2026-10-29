// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mount } from '@vue/test-utils'
import { compile } from 'tailwindcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref, watch } from 'vue'

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
vi.stubGlobal('useRoute', () => ({ path: '/home', fullPath: '/home' }))
vi.stubGlobal('useMobileHeader', () => ref(null))

const { default: MobileLayout } = await import('./mobile.vue')

// UDashboardGroup and UDashboardPanel render their roots with Nuxt UI's
// classes; Home puts its content in the panel's default slot, not #body
const UDashboardGroup = defineComponent({ setup: (_, { slots }) => () => h('div', { class: 'fixed inset-0 flex overflow-hidden' }, slots.default?.()) })
const UDashboardPanel = defineComponent({ setup: (_, { slots }) => () => h('div', { 'class': 'relative flex flex-col min-w-0 min-h-svh shrink-0 flex-1', 'data-testid': 'panel' }, slots.default?.()) })
const Plain = defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) })
const global = { components: { UDashboardGroup, UDashboardPanel, UButton: Plain, UIcon: Plain, NuxtLink: Plain, ShellBanners: Plain, MobileSearch: Plain } }

const Home = defineComponent({
  setup: () => () => h(UDashboardPanel, () => h('div', { class: 'flex flex-col gap-4 p-4' }, Array.from({ length: 30 }, (_, i) => h('p', { class: 'h-20' }, `Item ${i}`))))
})

afterEach(() => {
  document.head.innerHTML = ''
})

describe('mobile layout', () => {
  it('makes a page whose content is in the panel\'s default slot the vertical scroll container', async () => {
    const wrapper = mount(MobileLayout, { global, slots: { default: () => h(Home) }, attachTo: document.body })
    const style = document.createElement('style')
    style.textContent = await tailwind(wrapper.html())
    document.head.append(style)

    const panel = wrapper.get('[data-testid="panel"]').element
    expect(getComputedStyle(panel).overflowY).toBe('auto')
    // It fits between the header and the tab bar rather than growing to its content
    expect(getComputedStyle(panel).minHeight).toBe('0px')
    expect(getComputedStyle(panel.parentElement!).flexGrow).toBe('1')
    // The header and the tab bar sit outside it, so they stay fixed
    expect(panel.closest('header')).toBeNull()
    expect(wrapper.get('nav[aria-label="Main"]').element.contains(panel)).toBe(false)
    wrapper.unmount()
  })
})
