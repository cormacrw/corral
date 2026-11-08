// @vitest-environment happy-dom
import type { Plan } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref, watch } from 'vue'
import { api } from '~/queries/api'
import { testQueryClient } from '~/queries/mount-with-query'
import { usePlanThread } from '~/features/plan/composables/usePlanThread'

vi.mock('~/queries/api', () => ({ api: { plan: { approve: vi.fn(), session: vi.fn(async () => ({ id: 's1', messages: [], plans: [], unread: false, activeRunId: null })), read: vi.fn() } } }))

const item = (key: string, change: Plan['tasks'][number]['change'] = 'added'): Plan['tasks'][number] =>
  ({ key, change, revises: false, taskId: null, epicId: null, ref: null, title: key, description: '', implementationPlan: '', status: 'draft', priority: 'medium', humanReview: false, dependsOn: [] })
const plan = (tasks = [item('a'), item('b'), item('c', 'removed')]): Plan =>
  ({ id: 'p1', sessionId: 's1', projectId: 'pr', epicId: null, version: 1, title: 'Plan', summary: '', status: 'proposed', approvedAt: null, epics: [], tasks, createdAt: '' })

const calls: string[] = []
const toast = { add: vi.fn() }
const flyout = { close: vi.fn(async () => void calls.push('close')) }
beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  for (const [name, value] of Object.entries({ ref, computed, watch })) vi.stubGlobal(name, value)
  vi.stubGlobal('useToast', () => toast)
  vi.stubGlobal('useTaskFlyout', () => flyout)
  vi.stubGlobal('usePlanThreads', () => ({ add: vi.fn() }))
  vi.stubGlobal('useShell', () => ({ loaded: true, runner: { online: true }, agents: [] }))
  vi.mocked(api.plan.approve).mockImplementation(async (_id, to) => ({ ...plan(), status: 'approved' as const, tasks: plan().tasks.map(t => ({ ...t, status: to })) }))
})
afterEach(() => vi.unstubAllGlobals())

// A screen that moves on once approved, like a phone, or stays, like desktop Plan
function thread(movesOn: boolean) {
  let state!: ReturnType<typeof usePlanThread>
  const push = vi.fn(async (path: string) => void calls.push(`push ${path}`))
  mount(defineComponent({ setup() {
    state = usePlanThread(() => 's1', { moveOn: () => movesOn ? () => push('/plan') : null })
    return () => h('div')
  } }), { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } })
  return { state, push }
}

describe('approving a plan', () => {
  it.each(['ready', 'backlog'] as const)('approving to %s on a screen that moves on closes the sheet, moves on and confirms', async (to) => {
    const { state } = thread(true)
    expect(await state.approve(plan(), to)).toBe(true)
    expect(api.plan.approve).toHaveBeenCalledWith('p1', to)
    expect(calls).toEqual(['close', 'push /plan'])
    // Counts the tasks it made, not the removed one
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ color: 'success', description: expect.stringContaining('2') }))
  })

  it('stays on the session with the sheet open when approval fails', async () => {
    vi.mocked(api.plan.approve).mockRejectedValue(new Error('Plan is superseded'))
    const { state, push } = thread(true)
    expect(await state.approve(plan(), 'ready')).toBe(false)
    await flushPromises()
    expect(flyout.close).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ description: 'Plan is superseded', color: 'error' }))
  })

  it('stays on the session where the screen doesn\'t move on', async () => {
    const { state, push } = thread(false)
    expect(await state.approve(plan(), 'ready')).toBe(true)
    expect(api.plan.approve).toHaveBeenCalledWith('p1', 'ready')
    expect(flyout.close).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(toast.add).not.toHaveBeenCalled()
  })
})
