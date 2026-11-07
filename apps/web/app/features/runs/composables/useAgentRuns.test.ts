// @vitest-environment happy-dom
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { mountWithQuery } from '~/queries/mount-with-query'
import type { Agent, Run } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { useAgentRuns } from '~/features/runs/composables/useAgentRuns'

const agents = [{ id: 'a1', name: 'Atlas', role: 'developer', runtime: 'claude-code', concurrency: 1, paused: false, pausedUntil: null, activeRuns: 0 }] as Agent[]
const run = (id: string) => ({ id, agentId: 'a1', role: 'developer', state: 'completed', outcome: null, projectId: 'p1', taskId: null, taskRef: null,
  queuedAt: '2026-10-29T10:00:00Z', startedAt: '2026-10-29T10:00:00Z', endedAt: '2026-10-29T10:05:00Z', inputTokens: 0, cacheWriteTokens: null, outputTokens: 0 }) as unknown as Run
const list = [run('r-2'), run('r-1')]

vi.mock('~/queries/shell', () => ({
  shell: () => ({ agents: { data: vue.ref(agents) }, projects: { data: vue.ref([]) } })
}))

vi.mock('~/composables/useApi', () => ({ api: { runs: { list: vi.fn(), transcript: vi.fn() } } }))

afterEach(() => vi.unstubAllGlobals())

it('keeps the runs list and ignores an old transcript after switching runs', async () => {
  const route = vue.reactive({ params: { name: 'Atlas', runId: list[0]!.id } })
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
      view = useAgentRuns()
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
