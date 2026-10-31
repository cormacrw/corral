// @vitest-environment happy-dom
import type { PlanThreadItem } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import * as vue from 'vue'
import { inbox } from '~/prototype/fixtures'
import PlanThreadRow from './PlanThreadRow.vue'

const thread = (changes: Partial<PlanThreadItem> = {}) => ({
  ...inbox().needsYou.find((i): i is PlanThreadItem => i.type === 'plan_thread')!,
  status: 'question', unread: false, activeRunId: null, ...changes
} satisfies PlanThreadItem)

const avatar = vue.defineComponent({ props: ['name', 'size'], setup: p => () => vue.h('i', { 'data-avatar': p.name, 'data-size': p.size }) })
const thumbnail = vue.defineComponent({ setup: () => () => vue.h('i', { 'data-thumbnail': '' }) })
const badge = vue.defineComponent({ props: ['label'], setup: p => () => vue.h('b', p.label) })
const icon = vue.defineComponent({ setup: () => () => vue.h('i', { 'data-spinner': '' }) })

function mountRow(item: PlanThreadItem, mobile = false) {
  return mount(PlanThreadRow, {
    props: { item, mobile },
    global: { components: { AgentAvatar: avatar, ProjectThumbnail: thumbnail, UBadge: badge, UIcon: icon } }
  })
}

it('shows the sender where other rows do, with the project as a tag', () => {
  const item = thread({ sender: { name: 'Renamed PM', role: 'pm' }, subject: 'Push notifications' })
  const row = mountRow(item)
  expect(row.get('[data-avatar]').attributes('data-avatar')).toBe('Renamed PM')
  expect(row.get('[data-avatar]').attributes('data-size')).toBe('xs')
  expect(row.findAll('[data-thumbnail]')).toHaveLength(1)
  expect(row.text()).toContain('Renamed PM')
  expect(row.text()).toContain('Push notifications')
  expect(row.text()).toContain(item.project!.name)
  expect(row.text()).toContain('Question')
})

it('uses the larger avatar on mobile', () => {
  expect(mountRow(thread(), true).get('[data-avatar]').attributes('data-size')).toBe('md')
})

it('keeps the unread dot and working spinner', () => {
  const idle = mountRow(thread())
  expect(idle.find('[aria-label="Unread reply"]').exists()).toBe(false)
  expect(idle.find('[data-spinner]').exists()).toBe(false)
  const active = mountRow(thread({ status: 'none', unread: true, activeRunId: 'r-1' }))
  expect(active.find('[aria-label="Unread reply"]').exists()).toBe(true)
  expect(active.find('[data-spinner]').exists()).toBe(true)
  expect(active.text()).toContain('Unread reply')
})
