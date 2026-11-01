// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { PlanSession } from '@corral/contracts'
import { testQueryClient } from '~/queries/mount-with-query'
import PlanSessionSwitcher from './PlanSessionSwitcher.vue'

vi.mock('~/composables/useApi', () => ({ api: { plan: { sessions: vi.fn(async () => []) } } }))

const session = (status: PlanSession['status']) => ({ id: status, projectId: 'p1', title: status, status, unread: false, activeRunId: null }) as PlanSession
const drawer = defineComponent({ setup: (_, { slots }) => () => h('div', [slots.default?.(), slots.content?.()]) })
const badge = defineComponent({ props: ['label', 'color'], setup: p => () => h('b', { 'data-color': p.color }, p.label) })

function mountSwitcher(sessions: PlanSession[]) {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useShell', () => ({ projects: [] }))
  vi.stubGlobal('useRouter', () => ({ push: vi.fn() }))
  vi.stubGlobal('useOpenPlanSessions', () => ({ active: ref(null), sessions: ref(sessions), close: vi.fn() }))
  return mount(PlanSessionSwitcher, {
    global: {
      plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
      components: { UDrawer: drawer, UBadge: badge },
      stubs: { UButton: true, UIcon: true, TimeAgo: true }
    }
  })
}

afterEach(() => vi.unstubAllGlobals())

it('badges a failed session, so a lit history button has a row showing why', () => {
  const badges = mountSwitcher([session('failed'), session('needs_approval'), session('question'), session('none')]).findAll('b')
  expect(badges.map(b => [b.text(), b.attributes('data-color')])).toEqual([
    ['Failed', 'error'], ['Needs approval', 'primary'], ['Question', 'info']
  ])
})
