// @vitest-environment happy-dom
import type { Task } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, watch } from 'vue'
import TaskCardBlockers from '~/features/board/components/TaskCardBlockers.vue'

vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('watch', watch)
const openFlyout = vi.fn()
vi.stubGlobal('useTaskFlyout', () => ({ open: openFlyout }))

// Opens when its trigger is clicked, as the real popover does
const Popover = { props: ['open'], emits: ['update:open'], template: '<div :data-open="open"><span @click.capture="$emit(\'update:open\', !open)"><slot /></span><slot name="content" /></div>' }
const task = (number: number, overrides: Partial<Task>) => ({ id: `t-${number}`, ref: `COR-${number}`, title: 'Blocker', type: 'task', dependsOn: [], waitingOnEpics: [], ...overrides }) as Task

describe('TaskCardBlockers', () => {
  it('does not reopen by itself when a task gets a new blocker', async () => {
    const blocker = task(1, { status: 'in_progress' })
    const held = task(2, { status: 'ready', dependsOn: [blocker.ref] })
    const card = mount(TaskCardBlockers, {
      props: { task: held, tasks: [blocker, held] },
      global: {
        components: {
          AppPopover: Popover,
          Icon: { template: '<i />' }
        }
      }
    })

    await card.get('button').trigger('click')
    expect(card.get('[data-open]').attributes('data-open')).toBe('true')

    await card.setProps({ tasks: [task(1, { status: 'merged' }), held] })
    expect(card.find('[data-open]').exists()).toBe(false)

    await card.setProps({ tasks: [blocker, held] })
    await nextTick()
    expect(card.get('[data-open]').attributes('data-open')).toBe('false')
  })

  it('shows a dependency missing from the list as a row with only its ref', async () => {
    const held = task(2, { status: 'ready', dependsOn: ['COR-1'] })
    const card = mount(TaskCardBlockers, {
      props: { task: held, tasks: [held] },
      global: { components: { AppPopover: Popover, Icon: { template: '<i />' } } }
    })

    const row = card.get('li button')
    expect(row.text()).toBe('COR-1')
    await row.trigger('click')
    expect(openFlyout).toHaveBeenCalledWith('COR-1')
  })
})
