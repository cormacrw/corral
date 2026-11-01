// @vitest-environment happy-dom
import type { PlanMessage } from '@corral/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import PlanConfirmAction from './PlanConfirmAction.vue'

vi.mock('~/composables/useApi', () => ({ api: { plan: { resolveAction: vi.fn() } } }))
const message: PlanMessage = {
  id: 'action-1', sessionId: 'session-1', role: 'pm', kind: 'confirmation', text: 'Delete TA-1: Welcome page', recommendation: null, options: null, planId: null, runId: 'run-1', createdAt: '2026-10-30T10:00:00Z',
  pendingAction: { tool: 'delete_task', input: { taskRef: 'TA-1' }, summary: 'Delete TA-1: Welcome page', status: 'pending', targetId: 'task-1', result: null, error: null }
}
const button = vue.defineComponent({
  props: { label: String, disabled: Boolean },
  setup: props => () => vue.h('button', { disabled: props.disabled }, props.label)
})
const wrappers: ReturnType<typeof mount>[] = []
function open(status = message.pendingAction!.status, error: string | null = null, onResolved = vi.fn()) {
  const wrapper = mount(PlanConfirmAction, { props: { onResolved, message: { ...message, pendingAction: { ...message.pendingAction!, status, error } } }, global: { components: { UButton: button } } })
  wrappers.push(wrapper)
  return wrapper
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ref', vue.ref)
  vi.stubGlobal('computed', vue.computed)
  vi.mocked(api.plan.resolveAction).mockResolvedValue(message)
})
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount())
  vi.unstubAllGlobals()
})

describe('PM confirm card', () => {
  it.each(['confirm', 'cancel'] as const)('sends %s only on a click, scoped to its session and action', async (decision) => {
    // Like the parent conversation, observe the event through its listener.
    // wrapper.emitted() depends on devtools hooks disabled in production.
    const onResolved = vi.fn()
    let finish!: (result: PlanMessage) => void
    vi.mocked(api.plan.resolveAction).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const wrapper = open('pending', null, onResolved)
    expect(wrapper.text()).toContain('Nothing changes until you confirm.')
    expect(api.plan.resolveAction).not.toHaveBeenCalled()
    const buttons = wrapper.findAll('button')
    expect(buttons.map(b => b.text())).toEqual(['Confirm', 'Cancel'])
    await buttons[decision === 'confirm' ? 0 : 1]!.trigger('click')
    await flushPromises()
    expect(api.plan.resolveAction).toHaveBeenCalledExactlyOnceWith('session-1', 'action-1', decision)
    expect(onResolved).not.toHaveBeenCalled()
    expect(buttons.every(b => b.element.disabled)).toBe(true)
    finish(message)
    await flushPromises()
    expect(onResolved).toHaveBeenCalledExactlyOnceWith()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it.each(['confirmed', 'cancelled', 'failed', 'executing'] as const)('keeps %s cards disabled and shows durable errors', (status) => {
    const wrapper = open(status, status === 'failed' ? 'Task TA-1 no longer exists' : null)
    expect(wrapper.findAll('button').every(b => b.element.disabled)).toBe(true)
    if (status === 'failed') expect(wrapper.get('[role="alert"]').text()).toBe('Task TA-1 no longer exists')
  })
  it('shows a network error while keeping a pending card available for a safe retry', async () => {
    vi.mocked(api.plan.resolveAction).mockRejectedValueOnce(new Error('Connection lost'))
    const onResolved = vi.fn()
    const wrapper = open('pending', null, onResolved)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Connection lost')
    expect(wrapper.get('button').element.disabled).toBe(false)
    expect(onResolved).not.toHaveBeenCalled()
  })
})
