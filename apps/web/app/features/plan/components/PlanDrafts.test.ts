// @vitest-environment happy-dom
import type { DraftSession } from '@corral/contracts'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import PlanDrafts from '~/features/plan/components/PlanDrafts.vue'

enableAutoUnmount(afterEach)

// Nuxt UI needs the Nuxt app, so its badge and icon are plain elements here.
// NuxtLink resolves its target to an href and navigates in the app on click,
// which push stands in for.
const AppBadge = defineComponent({ props: { label: String }, setup: props => () => h('span', { 'data-badge': '' }, props.label) })
const Icon = defineComponent({ props: { name: String }, setup: props => () => h('i', { 'data-icon': props.name }) })
type To = string | { path: string, query?: Record<string, string> }
const href = (to: To) => typeof to === 'string' ? to : `${to.path}${to.query ? `?${new URLSearchParams(to.query)}` : ''}`
const push = vi.fn()
const NuxtLink = defineComponent({
  props: { to: { type: [String, Object], required: true } },
  setup: (props, { slots }) => () => h('a', {
    href: href(props.to as To),
    onClick: (e: Event) => {
      e.preventDefault()
      push(href(props.to as To))
    }
  }, slots.default?.())
})
const global = { components: { AppBadge, Icon, NuxtLink } }

const sessions: DraftSession[] = [
  {
    sessionId: 's-1', title: 'Design tasks', updatedAt: '2026-11-01T00:00:00.000Z', planStatus: 'proposed',
    drafts: [
      { taskId: 't-13', ref: 'COR-13', title: 'Design review screen', type: 'design', priority: 'high' },
      { taskId: 't-14', ref: 'COR-14', title: 'Approve a design version', type: 'task', priority: 'urgent' }
    ]
  },
  {
    sessionId: 's-3', title: 'Board polish', updatedAt: '2026-11-01T00:00:00.000Z', planStatus: 'superseded',
    drafts: [{ taskId: 't-16', ref: 'COR-16', title: 'Cards jump when a run starts', type: 'bug', priority: 'medium' }]
  }
]

describe('PlanDrafts', () => {
  beforeEach(() => push.mockClear())

  it('groups drafts under their session, with Needs approval only on a waiting plan', () => {
    const wrapper = mount(PlanDrafts, { props: { sessions }, global })
    const groups = wrapper.findAll('[data-testid="plan-drafts-session"]')
    expect(groups).toHaveLength(2)
    expect(groups[0]!.get('[data-testid="plan-drafts-header"]').text()).toContain('Design tasks')
    expect(groups[0]!.find('[data-badge]').exists()).toBe(true)
    const drafts = (group: number) => groups[group]!.findAll('[data-testid="plan-drafts-draft"]').map(d => d.text())
    expect(drafts(0)).toHaveLength(2)
    expect(drafts(0)[0]).toContain('Design review screen')
    expect(drafts(0)[1]).toContain('Approve a design version')
    expect(groups[1]!.find('[data-badge]').exists()).toBe(false)
    expect(drafts(1)).toHaveLength(1)
    expect(drafts(1)[0]).toContain('Cards jump when a run starts')
  })

  it('renders nothing when the project has no drafts', () => {
    const wrapper = mount(PlanDrafts, { props: { sessions: [] }, global })
    expect(wrapper.find('[data-testid="plan-drafts"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('links the session header to the session, and each draft to the session with it in focus', () => {
    const wrapper = mount(PlanDrafts, { props: { sessions }, global })
    expect(wrapper.findAll('[data-testid="plan-drafts-header"]').map(a => a.attributes('href'))).toEqual(['/plan/s-1', '/plan/s-3'])
    expect(wrapper.findAll('[data-testid="plan-drafts-draft"]').map(a => a.attributes('href'))).toEqual([
      '/plan/s-1?task=COR-13',
      '/plan/s-1?task=COR-14',
      '/plan/s-3?task=COR-16'
    ])
  })

  it('navigates in the app on click, without a reload', async () => {
    const wrapper = mount(PlanDrafts, { props: { sessions }, global })
    await wrapper.findAll('[data-testid="plan-drafts-draft"]')[2]!.trigger('click')
    await wrapper.findAll('[data-testid="plan-drafts-header"]')[0]!.trigger('click')
    expect(push.mock.calls).toEqual([['/plan/s-3?task=COR-16'], ['/plan/s-1']])
  })
})
