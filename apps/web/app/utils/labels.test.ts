import type { TaskStatus } from '@corral/core'
import { describe, expect, it } from 'vitest'
import { cliLoginCommand, detectedRuntimes, runtimeLabel, runTokens, taskCounts, taskTypeBadge } from './labels.ts'

const tasks = (...statuses: TaskStatus[]) => statuses.map(status => ({ status }))

describe('taskCounts', () => {
  it('leaves merged tasks out of the Board count', () => {
    expect(taskCounts(tasks('merged', 'merged', 'ready'))).toEqual({ board: 1, backlog: 0 })
  })

  it('counts every open status on the Board', () => {
    const open: TaskStatus[] = ['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'blocked', 'failed']
    expect(taskCounts(tasks(...open)).board).toBe(open.length)
  })

  it('counts the Backlog as before', () => {
    expect(taskCounts(tasks('backlog', 'backlog', 'merged', 'ready'))).toEqual({ board: 1, backlog: 2 })
  })

  it('drops a task from the Board count once it merges', () => {
    const list = tasks('ready_to_merge', 'in_progress')
    expect(taskCounts(list).board).toBe(2)
    list[0]!.status = 'merged'
    expect(taskCounts(list).board).toBe(1)
  })
})

describe('runTokens', () => {
  it('shows input, cache reads and output apart', () => {
    expect(runTokens({ inputTokens: 12_402, cacheReadTokens: 1_318_420, outputTokens: 369 })).toBe('12k in · 1.3M cache read · 369 out')
  })

  it('leaves cache reads out for runs recorded before they were counted', () => {
    expect(runTokens({ inputTokens: 44_244, cacheReadTokens: null, outputTokens: 369 })).toBe('44k in · 369 out')
  })
})

describe('runtimes', () => {
  it('labels runtimes Claude and Codex, never Claude Code', () => {
    expect(runtimeLabel('claude-code')).toBe('Claude')
    expect(runtimeLabel('codex')).toBe('Codex')
  })

  it('offers only runtimes whose CLI the runner found', () => {
    expect(detectedRuntimes([{ id: 'claude', version: '2.1.0' }, { id: 'codex', version: null }])).toEqual(['claude-code'])
    expect(detectedRuntimes([{ id: 'claude', version: '2.1.0' }, { id: 'codex', version: '0.50.0' }])).toEqual(['claude-code', 'codex'])
    expect(detectedRuntimes([])).toEqual([])
  })

  it('signs Codex in with device auth', () => {
    expect(cliLoginCommand('codex')).toBe('docker exec -it corral-runner codex login --device-auth')
    expect(cliLoginCommand('claude')).toBe('docker exec -it corral-runner claude')
  })
})

describe('taskTypeBadge', () => {
  it('badges bugs, spikes and designs, not plain tasks (D19, D20)', () => {
    expect(taskTypeBadge('task')).toBeNull()
    expect(taskTypeBadge('bug')).toMatchObject({ label: 'Bug', color: 'error' })
    expect(taskTypeBadge('spike')).toMatchObject({ label: 'Spike', color: 'info' })
    expect(taskTypeBadge('design')).toMatchObject({ label: 'Design', color: 'secondary' })
  })
})
