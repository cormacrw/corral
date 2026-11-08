// @vitest-environment happy-dom
import type { PlanThreadItem } from '@corral/contracts'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
import * as vue from 'vue'
import { planThread } from '~/features/inbox/test-items'
import InboxItemRow from '~/features/inbox/components/InboxItemRow.vue'

enableAutoUnmount(afterEach)

const thread = (changes: Partial<Pick<PlanThreadItem, 'sender' | 'subject'>> = {}) => planThread('s-1', changes)

const avatar = vue.defineComponent({ props: ['name'], setup: p => () => vue.h('i', { 'data-avatar': p.name }) })
const thumbnail = vue.defineComponent({ setup: () => () => vue.h('i') })
const badge = vue.defineComponent({ props: ['label'], setup: p => () => vue.h('b', p.label) })
const icon = vue.defineComponent({ setup: () => () => vue.h('i', { 'data-spinner': '' }) })

function mountRow(item: PlanThreadItem) {
  return mount(InboxItemRow, {
    props: { item },
    global: { components: { AgentAvatar: avatar, ProjectThumbnail: thumbnail, AppBadge: badge, Icon: icon } }
  })
}

it('shows the sender where other rows do, with the project as a tag', () => {
  const item = thread({ sender: { name: 'Renamed PM', role: 'pm' }, subject: 'Push notifications' })
  const row = mountRow(item)
  expect(row.get('[data-avatar]').attributes('data-avatar')).toBe('Renamed PM')
  expect(row.text()).toContain('Renamed PM')
  expect(row.text()).toContain('Push notifications')
  expect(row.text()).toContain(item.project!.name)
  expect(row.text()).toContain('Question')
})

it('marks unread and shows the working spinner', () => {
  const idle = mountRow(thread())
  expect(idle.find('[aria-label="Unread"]').exists()).toBe(false)
  expect(idle.find('[data-spinner]').exists()).toBe(false)
  const active = mountRow({ ...thread(), status: 'failed', question: null, plan: null, planId: null, failure: 'The PM exited with code 1', unread: true, activeRunId: 'r-1' })
  expect(active.find('[aria-label="Unread"]').exists()).toBe(true)
  expect(active.find('[data-spinner]').exists()).toBe(true)
  expect(active.text()).toContain('Failed')
})
