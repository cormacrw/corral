// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import InboxDesignReviewLink from '~/features/inbox/components/InboxDesignReviewLink.vue'

enableAutoUnmount(afterEach)

const AppButton = defineComponent({
  props: ['to', 'label'], setup: props => () => h('a', { href: props.to }, props.label)
})

it('links Inbox design reviews to the version approval panel without merge wording', () => {
  const wrapper = mount(InboxDesignReviewLink, {
    props: { task: { ref: 'TA-1', type: 'design', status: 'human_review' } },
    global: { components: { AppButton } }
  })
  expect(wrapper.get('a').attributes('href')).toBe('/tasks/TA-1')
  expect(wrapper.text()).toBe('Review design')
})

describe('other inbox items', () => {
  it('does not offer design review for normal tasks, approved designs or unloaded tasks', () => {
    for (const task of [null, { ref: 'TA-1', type: 'task', status: 'human_review' }, { ref: 'TA-1', type: 'design', status: 'approved' }] as const) {
      const wrapper = mount(InboxDesignReviewLink, { props: { task }, global: { components: { AppButton } } })
      expect(wrapper.find('a').exists()).toBe(false)
    }
  })
})
