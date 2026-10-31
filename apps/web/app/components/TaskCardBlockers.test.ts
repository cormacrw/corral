// @vitest-environment happy-dom
import type { Task } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, watch } from 'vue'
import { projects, task as fixture } from '../prototype/fixtures'
import TaskCardBlockers from './TaskCardBlockers.vue'

vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('watch', watch)
vi.stubGlobal('useTaskFlyout', () => ({ open: vi.fn() }))

const Popover = { props: ['open'], emits: ['update:open'], template: '<div :data-open="open"><slot /></div>' }
const task = (number: number, overrides: Partial<Task> = {}) => fixture(projects[0]!, number, { title: 'Blocker', status: 'ready', ...overrides })

describe('TaskCardBlockers', () => {
  it('does not reopen by itself when a task gets a new blocker', async () => {
    const blocker = task(1, { status: 'in_progress' })
    const held = task(2, { dependsOn: [blocker.ref] })
    const card = mount(TaskCardBlockers, {
      props: { task: held, tasks: [blocker, held] },
      global: {
        components: {
          UPopover: Popover,
          UIcon: { template: '<i />' }
        }
      }
    })

    await card.getComponent(Popover).vm.$emit('update:open', true)
    expect(card.get('[data-open]').attributes('data-open')).toBe('true')

    await card.setProps({ tasks: [{ ...blocker, status: 'merged' }, held] })
    expect(card.find('[data-open]').exists()).toBe(false)

    await card.setProps({ tasks: [blocker, held] })
    await nextTick()
    expect(card.get('[data-open]').attributes('data-open')).toBe('false')
  })
})
