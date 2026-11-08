// @vitest-environment happy-dom
import type { Task } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { PRIORITY } from '~/utils/labels'
import TaskCard from '~/features/board/components/TaskCard.vue'
import TaskCardAssignee from '~/features/board/components/TaskCardAssignee.vue'
import TaskCardMeta from '~/features/board/components/TaskCardMeta.vue'

const navigate = vi.fn()
vi.stubGlobal('computed', computed)
vi.stubGlobal('navigateTo', navigate)
beforeEach(() => navigate.mockClear())

const dana = { id: 'dana', name: 'Dana' }
const rita = { id: 'rita', name: 'Rita' }
const task = (overrides: Partial<Task> = {}) => ({
  id: 't-99', ref: 'COR-99', title: 'Fix the login', type: 'task', status: 'ready', priority: 'medium', pr: null,
  lease: null, developer: null, reviewer: null, updatedAt: '2026-10-01T00:00:00Z', dependsOn: [], waitingOnEpics: [], ...overrides
}) as Task
const lease = (agentId: string): Task['lease'] => ({ agentId, runId: 'r-1', role: 'developer', expiresAt: '' })

const render = (props: { task: Task, epic?: string | null, to?: string, pressed?: boolean, onOpen?: () => void }) => mount(TaskCard, {
  props: { tasks: [], ...props },
  global: {
    components: {
      TaskCardAssignee,
      TaskCardMeta,
      TaskCardBlockers: { template: '<span />' },
      BorderGlow: { template: '<div><slot /></div>' },
      AppTooltip: { props: ['text'], template: '<span :data-tooltip="text"><slot /></span>' },
      AgentAvatar: { template: '<i />' },
      Icon: { template: '<i />' },
      NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }
    }
  }
})

describe('TaskCard', () => {
  it('shows the title, epic and priority and no line for a missing epic', () => {
    const withEpic = render({ task: task({ status: 'ready', priority: 'urgent' }), epic: 'Login' })
    expect(withEpic.get('[data-card-title]').text()).toBe('Fix the login')
    expect(withEpic.text()).toContain('Login')
    expect(withEpic.text()).toContain(PRIORITY.urgent.label)
    expect(render({ task: task({ status: 'ready', priority: 'low' }), epic: null }).text()).not.toContain('Login')
  })

  it('shows the ref and PR number, and leaves the status detail to the flyout', () => {
    const card = render({ task: task({ status: 'blocked', statusReason: 'Review-round limit reached', reviewRounds: 5, pr: { number: 66, url: 'https://example.test/pull/66' }, paused: true }) })
    const meta = card.get('[data-testid=card-meta]').text()
    expect(meta).toContain('COR-99')
    expect(meta).toContain('#66')
    expect(card.text()).not.toContain('Review-round limit reached')
    expect(card.find('a').exists()).toBe(false)
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
  // The assignee's accessible name: the agent's name, marked when it is working
  const assignee = (card: ReturnType<typeof render>) => card.findAll('[role="img"]').map(e => e.attributes('aria-label')).find(label => /Dana|Rita|Unassigned/.test(label ?? ''))

  it('shows Unassigned rather than the other role', () => {
    const card = render({ task: task({ status: 'agent_review', developer: dana, reviewer: null }) })
    expect(card.find('[data-testid=card-unassigned]').exists()).toBe(true)
    expect(assignee(card)).not.toContain('Dana')
  })

  it('shows the reviewer during agent review', () => {
    const card = render({ task: task({ status: 'agent_review', developer: dana, reviewer: rita }) })
    expect(assignee(card)).toContain('Rita')
    expect(card.find('[data-testid=card-unassigned]').exists()).toBe(false)
  })

  it('marks the agent working only when the displayed agent holds the lease', () => {
    const label = (status: 'in_progress' | 'agent_review', agentId: string) => assignee(render({ task: task({ status, developer: dana, reviewer: rita, lease: lease(agentId) }) }))
    expect(label('in_progress', 'rita')).toBe('Dana')
    expect(label('agent_review', 'dana')).toBe('Rita')
    expect(label('in_progress', 'dana')).toContain('Dana')
    expect(label('in_progress', 'dana')).not.toBe('Dana')
  })
})
