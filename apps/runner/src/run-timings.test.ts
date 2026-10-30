import { describe, expect, it } from 'vitest'
import { RunTimer } from './run-timings.ts'

function clock() {
  const time = { now: 1000 }
  return { time, timer: new RunTimer(() => time.now) }
}

function advance(time: { now: number }, ms: number) {
  time.now += ms
}

describe('RunTimer', () => {
  it('adds the phases up to the total, with a nested phase pausing the outer one', async () => {
    const { time, timer } = clock()
    time.now += 5
    await timer.during('worktree_prepare', async () => advance(time, 100))
    await timer.during('agent_cold_start', async () => {
      time.now += 1000
      await timer.during('push', async () => advance(time, 200))
      time.now += 50
    })
    time.now += 2

    const timings = timer.finish()
    expect(timings.phases).toEqual([
      { phase: 'other', durationMs: 7 },
      { phase: 'worktree_prepare', durationMs: 100 },
      { phase: 'agent_cold_start', durationMs: 1050 },
      { phase: 'push', durationMs: 200 }
    ])
    expect(timings.totalMs).toBe(1357)
  })

  it('leaves the phase when its work throws', async () => {
    const { time, timer } = clock()
    await timer.during('push', () => Promise.reject(new Error('nope'))).catch(() => {})
    time.now += 10
    expect(timer.finish().phases).toEqual([{ phase: 'other', durationMs: 10 }, { phase: 'push', durationMs: 0 }])
  })

  it('keeps the total right when overlapping phases finish out of order', async () => {
    const { time, timer } = clock()
    let finishPush = () => {}
    const push = timer.during('push', () => new Promise<void>((resolve) => {
      finishPush = resolve
    }))
    time.now += 10
    await timer.during('design_save', async () => {
      time.now += 20
      finishPush()
      await push
      time.now += 30
    })
    time.now += 40
    expect(timer.finish()).toMatchObject({ totalMs: 100, phases: [
      { phase: 'other', durationMs: 40 },
      { phase: 'push', durationMs: 10 },
      { phase: 'design_save', durationMs: 50 }
    ] })
  })

  it('summarises tool calls per tool, slowest total first', () => {
    const { time, timer } = clock()
    timer.observe([{ type: 'tool_call', id: 'a', tool: 'Bash', input: {} }, { type: 'tool_call', id: 'b', tool: 'Read', input: {} }])
    time.now += 10
    timer.observe([{ type: 'tool_result', id: 'b', output: '', isError: false }])
    time.now += 30
    timer.observe([{ type: 'tool_result', id: 'a', output: '', isError: true }, { type: 'tool_call', id: 'c', tool: 'Bash', input: {} }])
    time.now += 5
    timer.observe([{ type: 'tool_result', id: 'c', output: '', isError: false }])

    expect(timer.finish().tools).toEqual([
      { tool: 'Bash', count: 2, totalMs: 45, maxMs: 40 },
      { tool: 'Read', count: 1, totalMs: 10, maxMs: 10 }
    ])
  })

  it('times a call with no result up to the end and ignores what it cannot pair', () => {
    const { time, timer } = clock()
    timer.observe([
      { type: 'tool_call', id: '', tool: 'Lost', input: {} },
      { type: 'tool_result', id: 'unknown', output: '', isError: false },
      { type: 'tool_call', id: 'a', tool: 'Bash', input: {} }
    ])
    time.now += 25
    timer.observe([{ type: 'tool_call', id: 'a', tool: 'Bash', input: {} }])
    time.now += 25
    expect(timer.finish().tools).toEqual([{ tool: 'Bash', count: 1, totalMs: 50, maxMs: 50 }])
  })
})
