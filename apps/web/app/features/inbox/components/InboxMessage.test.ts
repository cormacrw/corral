// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InboxMessage from '~/features/inbox/components/InboxMessage.vue'
import MarkdownText from '~/components/shared/MarkdownText.vue'
import TaskRefText from '~/features/tasks/components/TaskRefText.vue'

enableAutoUnmount(afterEach)

vi.mock('~/queries/shell', () => ({ shell: () => ({ projects: { data: { value: [{ prefix: 'COR' }] } } }) }))
vi.mock('~/features/tasks/components/TaskLink.vue', () => ({ default: { props: ['taskRef'], template: '<a :href="`/tasks/${taskRef}`"><slot /></a>' } }))

const render = (message: string | undefined = 'Ready for your review.') => mount(InboxMessage, {
  props: { item: { message, body: '## Findings\n\nThe complete investigation.' } },
  global: { components: { MarkdownText, TaskRefText }, stubs: { Icon: true } }
})

describe('InboxMessage', () => {
  it('shows prose first and full findings in closed details', () => {
    const wrapper = render('Ready with **literal** text.')
    expect(wrapper.get('p').text()).toBe('Ready with **literal** text.')
    expect(wrapper.get('p').find('strong').exists()).toBe(false)
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.get('details').text()).toContain('The complete investigation.')
  })

  it('links known refs in the message and leaves the rest of it literal', () => {
    for (const summary of [false, true]) {
      const wrapper = mount(InboxMessage, {
        props: { item: { message: 'Blocked on COR-12, not **XX-3**.', body: '' }, summary },
        global: { components: { MarkdownText, TaskRefText }, stubs: { Icon: true } }
      })
      expect(wrapper.get('p').text()).toBe('Blocked on COR-12, not **XX-3**.')
      expect(wrapper.get('p a[href="/tasks/COR-12"]').text()).toBe('COR-12')
      expect(wrapper.findAll('p a')).toHaveLength(1)
    }
  })

  it('keeps the previous markdown body without disclosures for items without a message', () => {
    const wrapper = render('')
    expect(wrapper.text()).toContain('The complete investigation.')
    expect(wrapper.find('details').exists()).toBe(false)
  })

  it('has no Full message control when there is no body', () => {
    const wrapper = mount(InboxMessage, {
      props: { item: { message: 'Blocked.', body: '' } },
      global: { components: { MarkdownText, TaskRefText }, stubs: { Icon: true } }
    })
    expect(wrapper.get('p').text()).toBe('Blocked.')
    expect(wrapper.find('details').exists()).toBe(false)
  })
})
