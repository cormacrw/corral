// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, onMounted, reactive, ref, useTemplateRef, watch } from 'vue'
import type { Board } from '~/features/board/composables/useBoard'
import { useBoardColumnTabs } from '~/features/board/composables/useBoardColumnTabs'
import type { BoardView } from '~/features/board/utils/board'
import { NO_FILTERS } from '~/features/board/utils/board'
import BoardMobile from '~/features/board/components/BoardMobile.vue'

afterEach(() => vi.unstubAllGlobals())

function board(initial: BoardView, key: string) {
  const route = reactive({ query: { column: key, view: initial } })
  const replace = vi.fn(({ query }) => {
    route.query = query
  })
  for (const [name, value] of Object.entries({ computed, nextTick, onMounted, ref, useTemplateRef, watch,
    useBoardColumnTabs,
    useRoute: () => route, useRouter: () => ({ replace }),
    useTaskFlyout: () => ({ openEpic: vi.fn() })
  })) vi.stubGlobal(name, value)
  const view = ref(initial)
  const column = (key: string, label: string, statuses: string[], hint: string, color: string) => ({ key, label, statuses, hint, color, tasks: [], cards: [], entries: [], count: 0 })
  const wrapper = mount(BoardMobile, {
    props: {
      board: {
        view, search: ref(''), filters: ref({ ...NO_FILTERS }), epicOptions: ref([]), taskAgents: ref([]), single: ref(null),
        columns: ref([column('ready', 'Ready', ['ready'], 'Scheduled next', 'bg-info'), column('complete', 'Complete', ['merged', 'approved'], 'Last 3 days', 'bg-success')]),
        total: ref(0), all: ref([]), loading: ref(false), error: ref(null), epicLabel: () => '', refetch: vi.fn()
      } as unknown as Board
    },
    global: { stubs: {
      MobilePageHeader: true, AppButton: true, AppInput: true, AppTabs: true,
      BoardFilters: true, BoardEpicCard: true, AppLoadError: true, UiSkeleton: true
    } }
  })
  return { wrapper, route, replace, view }
}

describe('mobile Board stages', () => {
  it('keeps the column across both views', async () => {
    const { wrapper, view } = board('all', 'merged')
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Complete, 0')
    view.value = 'top'
    await nextTick()
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Complete, 0')
  })

  it('opens Complete for saved approved column links', () => {
    const { wrapper } = board('all', 'approved')
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Complete, 0')
  })

  it('falls back for unknown stage keys and keeps epic tab selection in the query', async () => {
    const { wrapper, route } = board('top', 'unknown')
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('Ready 0')
    await wrapper.get('#board-tab-complete').trigger('click')
    expect(route.query).toEqual({ view: 'top', column: 'complete' })
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Complete, 0')
  })

  it('swipes through epic stages without treating a vertical scroll as a swipe', async () => {
    const { wrapper, route } = board('top', 'ready')
    const panel = wrapper.get('[role="tabpanel"]')
    await panel.trigger('touchstart', { touches: [{ clientX: 300, clientY: 100 }] })
    await panel.trigger('touchend', { changedTouches: [{ clientX: 200, clientY: 105 }] })
    expect(route.query.column).toBe('complete')
    await panel.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] })
    await panel.trigger('touchend', { changedTouches: [{ clientX: 200, clientY: 300 }] })
    expect(route.query.column).toBe('complete')
    await panel.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] })
    await panel.trigger('touchend', { changedTouches: [{ clientX: 200, clientY: 105 }] })
    expect(route.query.column).toBe('ready')
  })
})
