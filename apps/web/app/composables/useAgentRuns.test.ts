// @vitest-environment happy-dom
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { mountWithQuery } from '~/queries/mount-with-query'
import { agents, runs } from '~/prototype/fixtures'
import { api } from './useApi'
import { useAgentRuns } from './useAgentRuns'

vi.mock('~/queries/shell', () => ({
  shell: () => ({ agents: { data: vue.ref(agents) }, projects: { data: vue.ref([]) } })
}))

vi.mock('./useApi', () => ({ api: { runs: { list: vi.fn(), transcript: vi.fn() } } }))

afterEach(() => vi.unstubAllGlobals())

it('keeps the runs list and ignores an old transcript after switching runs', async () => {
  const agent = agents.find(a => a.role === 'developer' && runs.filter(r => r.agentId === a.id).length > 1)!
  const list = runs.filter(r => r.agentId === agent.id)
  expect(list.length).toBeGreaterThan(1)
  const route = vue.reactive({ params: { name: agent.name, runId: list[0]!.id } })
  for (const [key, value] of Object.entries(vue)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.mocked(api.runs.list).mockResolvedValue(list)
  let finishOld!: (value: import('@corral/contracts').RunEvent[]) => void
  vi.mocked(api.runs.transcript).mockImplementationOnce(() => new Promise((resolve) => {
    finishOld = resolve
  }))
    .mockResolvedValueOnce([{ type: 'message', text: 'new run' }])
  let view!: ReturnType<typeof useAgentRuns>
  const { wrapper } = mountWithQuery(vue.defineComponent({
    setup() {
      view = useAgentRuns({ autoSelect: () => true })
      return () => null
    }
  }))
  try {
    await flushPromises()
    const originalList = view.runs.value
    route.params.runId = list[1]!.id
    await flushPromises()
    expect(view.runs.value).toBe(originalList)
    expect(api.runs.list).toHaveBeenCalledTimes(1)
    expect(view.events.value).toEqual([{ type: 'message', text: 'new run' }])
    finishOld([{ type: 'message', text: 'old run' }])
    await flushPromises()
    expect(view.events.value).toEqual([{ type: 'message', text: 'new run' }])
    expect(view.selected.value?.id).toBe(list[1]!.id)
  } finally {
    wrapper.unmount()
  }
})
