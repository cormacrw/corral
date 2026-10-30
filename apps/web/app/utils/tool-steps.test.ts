import type { RunEvent } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { transcriptEntries } from './tool-steps.ts'

const call = (id: string, command: string): RunEvent => ({ type: 'tool_call', id, tool: 'Bash', input: { command } })
const result = (id: string): RunEvent => ({ type: 'tool_result', id, output: 'ok', isError: false })
const shape = (events: RunEvent[]) => transcriptEntries(events).map(e => (e.type === 'steps' ? `steps(${e.steps.length})` : e.type))

describe('transcriptEntries', () => {
  it('groups consecutive tool calls', () => {
    const events: RunEvent[] = [
      { type: 'system', text: 'Session started' },
      call('a', 'ls'), result('a'),
      call('b', 'pwd'), result('b'),
      { type: 'message', text: 'Done' },
      call('c', 'git status'), result('c')
    ]
    expect(shape(events)).toEqual(['system', 'steps(2)', 'message', 'steps(1)'])
  })

  it('doesn\'t split a group on the empty thinking the CLI emits before each turn', () => {
    const events: RunEvent[] = [
      { type: 'thinking', text: '' }, call('a', 'ls'), result('a'),
      { type: 'thinking', text: '' }, call('b', 'pwd'), result('b')
    ]
    const entries = transcriptEntries(events)
    expect(shape(events)).toEqual(['thinking', 'steps(2)'])
    expect(entries[0]).toMatchObject({ type: 'thinking', text: '' })
  })

  it('shows consecutive empty thinking blocks as one', () => {
    const events: RunEvent[] = [
      { type: 'message', text: 'Hi' },
      { type: 'thinking', text: '' },
      { type: 'thinking', text: '  ' },
      { type: 'message', text: 'Again' }
    ]
    expect(shape(events)).toEqual(['message', 'thinking', 'message'])
  })

  it('shows thinking with text as its own step, splitting the group', () => {
    const events: RunEvent[] = [
      call('a', 'ls'), result('a'),
      { type: 'thinking', text: 'The tests failed, so check the config.' },
      call('b', 'pwd'), result('b')
    ]
    const entries = transcriptEntries(events)
    expect(shape(events)).toEqual(['steps(1)', 'thinking', 'steps(1)'])
    expect(entries[1]).toMatchObject({ type: 'thinking', text: 'The tests failed, so check the config.' })
  })

  it('labels the PM\'s team status check', () => {
    const steps = (agent?: string) => transcriptEntries([{ type: 'tool_call', id: 'a', tool: 'mcp__corral__get_agent_activity', input: agent ? { agent } : {} }])
    expect(steps()[0]).toMatchObject({ steps: [{ verb: 'Checked what the team is doing', target: '' }] })
    expect(steps('Jack')[0]).toMatchObject({ steps: [{ verb: 'Checked what the team is doing', target: 'Jack' }] })
  })
})
