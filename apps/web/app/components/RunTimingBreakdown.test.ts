// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { computed } from 'vue'
import { expect, it, vi } from 'vitest'
import type { Run } from '@corral/contracts'

vi.stubGlobal('computed', computed)
const { default: RunTimingBreakdown } = await import('./RunTimingBreakdown.vue')
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

it('shows queue-to-start wait, sorts phases and tools without mutating the API data', () => {
  const wrapper = mount(RunTimingBreakdown, { props: { run } })
  expect(wrapper.text()).toContain('including preparation): 1m 0s')
  const tables = wrapper.findAll('table')
  expect(tables[0]!.findAll('tbody tr').map(row => row.text())).toEqual(['Agent resume· largest9.0 s', 'Push1.0 s'])
  expect(tables[1]!.findAll('tbody tr').map(row => row.text())).toEqual(['exec_command412.0 s6.0 s', 'get_task2400 ms250 ms'])
  expect(wrapper.get('[role="img"]').attributes('aria-label')).toContain('Agent resume: 9.0 s')
  expect(wrapper.findAll('[role="img"] span')[0]!.attributes('style')).toContain('width: 90%')
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
  expect(wrapper.text()).toContain('No recorded tool calls.')
  expect(wrapper.html()).not.toMatch(/NaN|Infinity/)
})
