// @vitest-environment happy-dom
import type { Task } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { projects, task as fixture } from '../prototype/fixtures'
import TaskCard from './TaskCard.vue'
import TaskCardAssignee from './TaskCardAssignee.vue'

const navigate = vi.fn()
vi.stubGlobal('computed', computed)
vi.stubGlobal('navigateTo', navigate)
beforeEach(() => navigate.mockClear())

const dana = { id: 'dana', name: 'Dana' }
const rita = { id: 'rita', name: 'Rita' }
const task = (overrides: Partial<Task> = {}) => fixture(projects[0]!, 99, { title: 'Fix the login', status: 'ready', ...overrides })
const lease = (agentId: string): Task['lease'] => ({ agentId, runId: 'r-1', role: 'developer', expiresAt: '' })

const render = (props: { task: Task, epic?: string | null, to?: string, pressed?: boolean, onOpen?: () => void }) => mount(TaskCard, {
  props,
  global: {
    components: {
      TaskCardAssignee,
      BorderGlow: { template: '<div><slot /></div>' },
      UTooltip: { props: ['text'], template: '<span :data-tooltip="text"><slot /></span>' },
      AgentAvatar: { props: ['name', 'working'], template: '<i :data-avatar="name" :data-working="working" />' },
      UIcon: { template: '<i />' },
      NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }
    }
  }
})

describe('TaskCard', () => {
  it('shows the title, epic and priority and no line for a missing epic', () => {
    expect(render({ task: task({ priority: 'urgent' }), epic: 'Login' }).text()).toBe('Fix the loginLoginUrgent')
    expect(render({ task: task({ priority: 'low' }), epic: null }).text()).toBe('Fix the loginLow')
  })

  it('leaves the status detail to the flyout', () => {
    const text = render({ task: task({ status: 'blocked', statusReason: 'Review-round limit reached', reviewRounds: 5, prNumber: 66, prUrl: 'https://example.test/pull/66', paused: true }) })
    expect(text.text()).toBe('Fix the loginMedium')
    expect(text.find('a').exists()).toBe(false)
  })

  it('opens from anywhere on the card, once, and marks a pressed title', async () => {
    const open = vi.fn()
    const card = render({ task: task(), pressed: true, onOpen: open })
    await card.get('[data-testid=task-card]').trigger('click')
    await card.get('button').trigger('click')
    expect(open).toHaveBeenCalledTimes(2)
    expect(card.get('button').attributes('aria-pressed')).toBe('true')
  })

  it('follows the link on a phone, from the title or the rest of the card', async () => {
    const open = vi.fn()
    const card = render({ task: task(), to: '/tasks/COR-99', onOpen: open })
    expect(card.find('button').exists()).toBe(false)
    expect(card.get('a').attributes('href')).toBe('/tasks/COR-99')
    await card.get('a').trigger('click')
    expect(navigate).not.toHaveBeenCalled()
    await card.get('[data-testid=task-card]').trigger('click')
    expect(navigate).toHaveBeenCalledWith('/tasks/COR-99')
    expect(open).not.toHaveBeenCalled()
  })
})

describe('TaskCardAssignee', () => {
  it('shows a dashed circle, labelled Unassigned, rather than the other role', () => {
    const card = render({ task: task({ status: 'agent_review', developer: dana, reviewer: null }) })
    expect(card.find('[data-testid=card-unassigned]').exists()).toBe(true)
    expect(card.find('[data-tooltip=Unassigned]').exists()).toBe(true)
  })

  it('names the agent on hover only', () => {
    const card = render({ task: task({ status: 'agent_review', developer: dana, reviewer: rita }) })
    expect(card.find('[data-avatar=Rita]').exists()).toBe(true)
    expect(card.find('[data-tooltip=Rita]').exists()).toBe(true)
    expect(card.text()).not.toContain('Rita')
  })

  it('shows the dot only when the displayed agent holds the lease', () => {
    const working = (status: 'in_progress' | 'agent_review', agentId: string) => render({ task: task({ status, developer: dana, reviewer: rita, lease: lease(agentId) }) }).get('[data-avatar]').attributes('data-working')
    expect(working('in_progress', 'dana')).toBe('true')
    expect(working('in_progress', 'rita')).toBe('false')
    expect(working('agent_review', 'dana')).toBe('false')
  })
})
