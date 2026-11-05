// @vitest-environment happy-dom
import type { PlanSession } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import PlanOpenThreads from '~/features/plan/components/PlanOpenThreads.vue'

// Nuxt UI needs the Nuxt app, so its card, badge and icon are plain elements
const AppBadge = defineComponent({ props: { label: String, color: String }, setup: props => () => h('span', { 'data-badge': props.color }, props.label) })
const AppCard = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
const Icon = defineComponent({ props: { name: String }, setup: props => () => h('i', { 'data-icon': props.name }) })
const NuxtLink = defineComponent({ props: { to: { type: String, required: true } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) })
const global = { components: { AppBadge, AppCard, Icon, NuxtLink } }

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const session = (id: string, patch: Partial<PlanSession>): PlanSession => ({
  id, projectId: 'p-1', title: id, runtime: 'claude-code', preview: '', unread: false, closed: false,
  status: 'none', activeRunId: null, createdAt: at(100), updatedAt: at(10), ...patch
})
const sessions = [
  session('Older', { updatedAt: at(30), status: 'question' }),
  session('Closed', { updatedAt: at(1), closed: true }),
  session('Newest', { updatedAt: at(2), status: 'needs_approval', unread: true }),
  session('Failing', { updatedAt: at(20), status: 'failed' }),
  session('Quiet', { updatedAt: at(25) })
]

describe('PlanOpenThreads', () => {
  it('lists open threads, most recently updated first, with an unread dot and no status badge', () => {
    const wrapper = mount(PlanOpenThreads, { props: { sessions }, global })
    const rows = wrapper.findAll('[data-testid="plan-open-thread"]')
    expect(wrapper.get('h2').text()).toBe('Open threads')
    expect(rows.map(r => r.get('.truncate').text())).toEqual(['Newest', 'Failing', 'Quiet', 'Older'])
    expect(wrapper.find('[data-badge]').exists()).toBe(false)
    expect(rows.map(r => r.find('[data-testid="plan-session-unread"]').exists())).toEqual([true, false, false, false])
  })

  it('links each row to its session', () => {
    const wrapper = mount(PlanOpenThreads, { props: { sessions }, global })
    expect(wrapper.findAll('[data-testid="plan-open-thread"]').map(a => a.attributes('href'))).toEqual(['/plan/Newest', '/plan/Failing', '/plan/Quiet', '/plan/Older'])
  })

  it('drops a thread once it closes, and hides when none are open', async () => {
    const wrapper = mount(PlanOpenThreads, { props: { sessions }, global })
    await wrapper.setProps({ sessions: sessions.map(s => s.id === 'Newest' ? { ...s, closed: true } : s) })
    expect(wrapper.findAll('[data-testid="plan-open-thread"]')).toHaveLength(3)
    await wrapper.setProps({ sessions: [sessions[1]!] })
    expect(wrapper.find('[data-testid="plan-open-threads"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('uses full-width rows at least 48px tall on phones', () => {
    const wrapper = mount(PlanOpenThreads, { props: { sessions, mobile: true }, global })
    for (const row of wrapper.findAll('[data-testid="plan-open-thread"]')) {
      expect(row.classes()).toEqual(expect.arrayContaining(['w-full', 'min-h-12']))
    }
  })
})
