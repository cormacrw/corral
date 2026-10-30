// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { inboxActions } from '~/utils/inbox-actions'
import InboxDesignReviewLink from './InboxDesignReviewLink.vue'

const UButton = defineComponent({
  props: ['to', 'label'], setup: props => () => h('a', { href: props.to }, props.label)
})

it('links Inbox design reviews to the version approval panel without merge wording', () => {
  const wrapper = mount(InboxDesignReviewLink, {
    props: { task: { ref: 'TA-1', type: 'design', status: 'human_review' } },
    global: { components: { UButton } }
  })
  expect(wrapper.get('a').attributes('href')).toBe('/tasks/TA-1')
  expect(wrapper.text()).toBe('Review design')
})

describe('other inbox items', () => {
  it('does not offer design review for normal tasks, approved designs or unloaded tasks', () => {
    for (const task of [null, { ref: 'TA-1', type: 'task', status: 'human_review' }, { ref: 'TA-1', type: 'design', status: 'approved' }] as const) {
      const wrapper = mount(InboxDesignReviewLink, { props: { task }, global: { components: { UButton } } })
      expect(wrapper.find('a').exists()).toBe(false)
    }
  })
})

it('offers version approval for designs, and nothing generic while task type is loading', () => {
  expect(inboxActions('human_review', { type: 'design' }).map(a => a.label)).toEqual(['Approve design', 'Request changes'])
  expect(inboxActions('human_review', null)).toEqual([])
  expect(inboxActions('human_review', { type: 'task' }).map(a => a.value)).toEqual(['approve', 'request_changes'])
  expect(inboxActions('human_review', { type: 'spike' })[0]?.label).toBe('Accept findings')
  expect(inboxActions('human_review', null, 'loading')[0]?.label).toBe('Loading task…')
  expect(inboxActions('human_review', null, 'failed')[0]?.label).toBe('Task not loaded')
})
