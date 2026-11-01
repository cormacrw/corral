// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, onMounted, reactive, ref, useTemplateRef, watch } from 'vue'
import { NO_FILTERS } from '~/utils/board'
import BoardMobile from './BoardMobile.vue'

afterEach(() => vi.unstubAllGlobals())

function board(view: 'tasks' | 'epics', key: string) {
  const route = reactive({ query: { column: key, view } })
  const replace = vi.fn(({ query }) => {
    route.query = query
  })
  for (const [name, value] of Object.entries({ computed, nextTick, onMounted, ref, useTemplateRef, watch,
    useShell: () => ({ agents: [] }),
    useRoute: () => route, useRouter: () => ({ replace }),
    useTaskFlyout: () => ({ openEpic: vi.fn() })
  })) vi.stubGlobal(name, value)
  const wrapper = mount(BoardMobile, {
    props: {
      view, search: '', filters: { ...NO_FILTERS }, epics: [], agents: [],
      columns: [
        { key: 'ready', label: 'Ready', statuses: ['ready'], hint: 'Scheduled next', color: 'bg-info', tasks: [] },
        { key: 'complete', label: 'Complete', statuses: ['merged', 'approved'], hint: 'Last 3 days', color: 'bg-success', tasks: [] }
      ],
      epicColumns: [
        { key: 'ready', label: 'Ready', hint: 'Scheduled next', dot: 'bg-info', cards: [] },
        { key: 'done', label: 'Done', hint: 'Last 3 days', dot: 'bg-success', cards: [] }
      ],
      total: 0, epicTotal: 0, all: [], reviewRoundCap: 5, loading: false, error: null
    },
    global: { stubs: {
      MobilePageHeader: true, UButton: true, UInput: true, UTabs: true,
      BoardFilters: true, BoardEpicCard: true, UAlert: true, USkeleton: true
    } }
  })
  return { wrapper, route, replace }
}

describe('mobile Board stages', () => {
  it('falls back from keys belonging to the other view in both directions', async () => {
    const { wrapper } = board('tasks', 'merged')
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Complete, 0')
    await wrapper.setProps({ view: 'epics' })
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Ready, 0')
    await wrapper.get('#board-tab-done').trigger('click')
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Done, 0')
    await wrapper.setProps({ view: 'tasks' })
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Ready, 0')
  })

  it('opens Complete for saved approved column links', () => {
    const { wrapper } = board('tasks', 'approved')
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Complete, 0')
  })

  it('falls back for unknown stage keys and keeps epic tab selection in the query', async () => {
    const { wrapper, route } = board('epics', 'unknown')
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('Ready 0')
    await wrapper.get('#board-tab-done').trigger('click')
    expect(route.query).toEqual({ view: 'epics', column: 'done' })
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Done, 0')
  })

  it('swipes through epic stages without treating a vertical scroll as a swipe', async () => {
    const { wrapper, route } = board('epics', 'ready')
    const panel = wrapper.get('[role="tabpanel"]')
    await panel.trigger('touchstart', { touches: [{ clientX: 300, clientY: 100 }] })
    await panel.trigger('touchend', { changedTouches: [{ clientX: 200, clientY: 105 }] })
    expect(route.query.column).toBe('done')
    await panel.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] })
    await panel.trigger('touchend', { changedTouches: [{ clientX: 200, clientY: 300 }] })
    expect(route.query.column).toBe('done')
    await panel.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] })
    await panel.trigger('touchend', { changedTouches: [{ clientX: 200, clientY: 105 }] })
    expect(route.query.column).toBe('ready')
  })
})
