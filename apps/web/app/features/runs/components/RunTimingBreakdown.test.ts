// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { computed } from 'vue'
import { expect, it, vi } from 'vitest'
import type { Run } from '@corral/contracts'

vi.stubGlobal('computed', computed)
const { formatMs } = await import('~/utils/labels')
const { default: RunTimingBreakdown } = await import('~/features/runs/components/RunTimingBreakdown.vue')
const run = {
  queuedAt: '2026-10-30T10:00:00Z', startedAt: '2026-10-30T10:01:00Z',
  timings: {
    totalMs: 10_000,
    phases: [{ phase: 'push', durationMs: 1000 }, { phase: 'agent_resume', durationMs: 9000 }],
    tools: [
      { tool: 'get_task', count: 2, totalMs: 400, maxMs: 250 },
      { tool: 'exec_command', count: 4, totalMs: 12_000, maxMs: 6000 }
    ]
  }
} as Run

it('shows queue-to-start wait, sorts phases and tools slowest first without mutating the API data', () => {
  const wrapper = mount(RunTimingBreakdown, { props: { run } })
  expect(wrapper.text()).toContain(formatMs(60_000))
  const [phases, tools] = wrapper.findAll('table')
  const firstCells = (table: typeof phases) => table!.findAll('tbody tr').map(row => row.find('th, td').text())
  expect(firstCells(phases)[0]).toContain('Agent resume')
  expect(firstCells(phases)[1]).toContain('Push')
  expect(firstCells(tools)).toEqual(['exec_command', 'get_task'])
  expect(run.timings!.phases[0]!.phase).toBe('push')
  expect(run.timings!.tools[0]!.tool).toBe('get_task')
})

it('renders nothing for older runs and reacts when timing data arrives', async () => {
  const wrapper = mount(RunTimingBreakdown, { props: { run: { ...run, timings: null } } })
  expect(wrapper.find('section').exists()).toBe(false)
  await wrapper.setProps({ run })
  expect(wrapper.find('section').exists()).toBe(true)
})

it('handles empty timings and an unavailable start time', () => {
  const wrapper = mount(RunTimingBreakdown, {
    props: { run: { ...run, startedAt: null, timings: { totalMs: 0, phases: [], tools: [] } } }
  })
  expect(wrapper.text()).toContain('Unavailable')
  expect(wrapper.findAll('table')).toHaveLength(1)
  expect(wrapper.html()).not.toMatch(/NaN|Infinity/)
})
