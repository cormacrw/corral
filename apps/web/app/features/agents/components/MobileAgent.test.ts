// @vitest-environment happy-dom
import type { Run } from '@corral/contracts'
import type { AgentRuns } from '~/features/agents/composables/useAgentRuns'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref } from 'vue'
import MobileAgent from '~/features/agents/components/MobileAgent.vue'

const NuxtLink = defineComponent({
  props: ['to'],
  setup: (props, { slots }) => () => h('a', {
    href: typeof props.to === 'string' ? props.to : `${props.to.path}?${new URLSearchParams(props.to.query)}`
  }, slots.default?.())
})
afterEach(() => vi.unstubAllGlobals())

function links(runs: Run[]) {
  vi.stubGlobal('computed', computed)
  const view = {
    name: ref('Juno'), agent: ref({ name: 'Juno', role: runs[0]!.role, activeRuns: 0 }), status: ref(null), limited: ref(false),
    runs: ref(runs), pending: ref(false), current: ref(runs.find(r => r.state === 'running') ?? null),
    error: ref(null), now: ref(Date.now()), today: ref([]), tiles: ref([]), facts: ref(''),
    load: vi.fn(), resume: vi.fn(), project: () => null
  } as unknown as AgentRuns
  return mount(MobileAgent, {
    props: { view }, global: { components: { NuxtLink }, stubs: {
      MobilePageHeader: true, AgentAvatar: true, AppBadge: true, AppButton: true, AppAlert: true, UiSkeleton: true
    } }
  }).findAll('a').map(a => a.attributes('href'))
}
const run = (role: Run['role'], id = `r-${role}`) => ({
  id, role, agentId: 'juno', agentName: 'Juno', state: 'completed', outcome: null, projectId: 'p1', planSessionId: null,
  taskId: null, taskRef: null, taskTitle: null, epicId: null, epicTitle: null, summary: null,
  queuedAt: '2026-10-29T10:00:00Z', startedAt: '2026-10-29T10:00:00Z', endedAt: '2026-10-29T10:05:00Z'
}) as unknown as Run
const pm = run('pm')

describe('mobile agent navigation', () => {
  it('opens current and previous PM turns in their exact sessions and projects', () => {
    const current: Run = { ...pm, id: 'live', state: 'running', endedAt: null, outcome: null, planSessionId: 'live-session', projectId: 'project-a' }
    const previous: Run = { ...pm, id: 'past', planSessionId: 'past-session', projectId: 'project-b' }
    expect(links([current, previous])).toEqual([
      '/plan/live-session?project=project-a', '/plan/past-session?project=project-b'
    ])
  })

  it('keeps transcripts for unlinked PM turns and other roles even with a session ID', () => {
    expect(links([{ ...pm, planSessionId: null }])).toEqual([`/agents/juno/${pm.id}`])
    for (const role of ['developer', 'designer', 'reviewer'] as const) {
      const other = run(role)
      expect(links([{ ...other, planSessionId: 'session' }])).toEqual([`/agents/juno/${other.id}`])
    }
  })
})
