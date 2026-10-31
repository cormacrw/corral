// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { agents, runs } from '~/prototype/fixtures'
import { api } from './useApi'
import { useAgentRuns } from './useAgentRuns'

vi.mock('./useApi', () => ({ api: { runs: { list: vi.fn(), transcript: vi.fn() } } }))

afterEach(() => vi.unstubAllGlobals())

it('keeps the runs list and ignores an old transcript after switching runs', async () => {
  const agent = agents.find(a => a.role === 'developer' && runs.filter(r => r.agentId === a.id).length > 1)!
  const list = runs.filter(r => r.agentId === agent.id)
  expect(list.length).toBeGreaterThan(1)
  const route = vue.reactive({ params: { name: agent.name, runId: list[0]!.id } })
  const watchRun = vi.fn()
  for (const [key, value] of Object.entries(vue)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useLive', () => ({
    state: vue.ref({ agents, projects: [] }), watchRun, subscribe: () => () => {}
  }))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.mocked(api.runs.list).mockResolvedValue(list)
  let finishOld!: (value: never[]) => void
  vi.mocked(api.runs.transcript).mockImplementationOnce(() => new Promise((resolve) => {
    finishOld = resolve
  }))
    .mockResolvedValueOnce([])
  let view!: ReturnType<typeof useAgentRuns>
  const wrapper = mount(vue.defineComponent({
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
    expect(watchRun).toHaveBeenCalledExactlyOnceWith(list[1]!.id, [])
    finishOld([])
    await flushPromises()
    expect(watchRun).toHaveBeenCalledTimes(1)
    expect(view.selected.value?.id).toBe(list[1]!.id)
  } finally {
    wrapper.unmount()
  }
})
