// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, resolveComponent } from 'vue'
import { projects, task } from '~/prototype/fixtures'
import BoardCard from './BoardCard.vue'

const card = task(projects[0]!, 7, { title: 'A card', status: 'in_progress', pr: { number: 41, url: 'https://github.com/o/r/pull/41' } })
const NuxtLink = defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { 'href': p.to, 'data-link': '' }, slots.default?.()) })
const plain = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })

beforeEach(() => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('resolveComponent', resolveComponent)
  vi.stubGlobal('useTaskPrefetch', () => () => ({}))
})

function render(props: Record<string, unknown> = {}) {
  return mount(BoardCard, {
    props: { task: card, note: null, epic: 'An epic', agent: null, slug: 'corral', ...props },
    global: {
      components: { NuxtLink, BorderGlow: plain },
      stubs: { UIcon: true, UBadge: true, TaskTypeBadge: true, StatusBadge: true, DesignChangedBadge: true, AgentAvatar: true }
    }
  })
}

describe('BoardCard', () => {
  it('keeps the PR link out of the card button, where browsers ignore it', () => {
    const wrapper = render()
    expect(wrapper.get('a').attributes('href')).toBe(card.pr!.url)
    expect(wrapper.get('button').find('a').exists()).toBe(false)
  })

  it('opens from the button on the web', async () => {
    const wrapper = render()
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('is one link to the task on a phone, with the PR number as text', () => {
    const wrapper = render({ mobile: true })
    expect(wrapper.find('button').exists()).toBe(false)
    const links = wrapper.findAll('a')
    expect(links.map(a => a.attributes('href'))).toEqual([`/tasks/${card.ref}`])
    expect(links[0]!.text()).toContain('#41')
  })
})
