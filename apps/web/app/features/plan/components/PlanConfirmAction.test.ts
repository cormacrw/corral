// @vitest-environment happy-dom
import type { PlanMessage } from '@corral/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { api } from '~/queries/api'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import PlanConfirmAction from '~/features/plan/components/PlanConfirmAction.vue'

vi.mock('~/queries/api', () => ({ api: { plan: { resolveAction: vi.fn() } } }))
const message: PlanMessage = {
  id: 'action-1', sessionId: 'session-1', role: 'pm', kind: 'confirmation', text: 'Delete TA-1: Welcome page', recommendation: null, options: null, planId: null, runId: 'run-1', createdAt: '2026-10-30T10:00:00Z',
  pendingAction: { tool: 'delete_task', input: { taskRef: 'TA-1' }, summary: 'Delete TA-1: Welcome page', status: 'pending', targetId: 'task-1', result: null, error: null }
}
const button = vue.defineComponent({
  props: { label: String, disabled: Boolean },
  setup: props => () => vue.h('button', { disabled: props.disabled }, props.label)
})
const wrappers: ReturnType<typeof mount>[] = []
let client = testQueryClient()
// The conversation refetches its session once the answer is in
const refreshed = () => client.getQueryState(keys.plan.session('session-1'))?.isInvalidated ?? false
function open(status = message.pendingAction!.status, error: string | null = null) {
  client = testQueryClient()
  client.setQueryData(keys.plan.session('session-1'), { id: 'session-1' })
  const wrapper = mount(PlanConfirmAction, { props: { message: { ...message, pendingAction: { ...message.pendingAction!, status, error } } }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { AppButton: button } } })
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
    let finish!: (result: PlanMessage) => void
    vi.mocked(api.plan.resolveAction).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const wrapper = open('pending')
    expect(api.plan.resolveAction).not.toHaveBeenCalled()
    const buttons = wrapper.findAll('button')
    await buttons.find(b => b.text().toLowerCase() === decision)!.trigger('click')
    await flushPromises()
    expect(api.plan.resolveAction).toHaveBeenCalledExactlyOnceWith('session-1', 'action-1', decision)
    expect(refreshed()).toBe(false)
    expect(buttons.every(b => b.element.disabled)).toBe(true)
    finish(message)
    await flushPromises()
    expect(refreshed()).toBe(true)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it.each(['confirmed', 'cancelled', 'failed', 'executing'] as const)('keeps %s cards disabled and shows durable errors', (status) => {
    const wrapper = open(status, status === 'failed' ? 'Task TA-1 no longer exists' : null)
    expect(wrapper.findAll('button').every(b => b.element.disabled)).toBe(true)
    if (status === 'failed') expect(wrapper.get('[role="alert"]').text()).toBe('Task TA-1 no longer exists')
  })
  it('shows a network error while keeping a pending card available for a safe retry', async () => {
    vi.mocked(api.plan.resolveAction).mockRejectedValueOnce(new Error('Connection lost'))
    const wrapper = open('pending')
    const confirm = wrapper.findAll('button').find(b => b.text() === 'Confirm')!
    await confirm.trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Connection lost')
    expect(confirm.element.disabled).toBe(false)
    expect(refreshed()).toBe(false)
  })
})
