import { deliveryInProgress, type TaskStatus } from '@corral/core'
import { cliLoginCommand } from '@corral/contracts/client'
import { describe, expect, it } from 'vitest'
import { agentStatus, detectedRuntimes, epicHistoryText, epicReviewStatus, epicWithLiveCounts, inboxItemLink, plural, runRef, runTitle, runTokens, statusCounts, taskCounts } from './labels.ts'

const tasks = (...statuses: TaskStatus[]) => statuses.map(status => ({ status }))

describe('statusCounts', () => {
  it('combines merged tasks and approved designs into one Complete count', () => {
    expect(statusCounts(tasks('merged', 'approved', 'ready', 'merged', 'approved')).map(({ status, count }) => ({ status, count }))).toEqual([
      { status: 'ready', count: 1 },
      { status: 'approved', count: 4 }
    ])
  })
})

describe('epicHistoryText', () => {
  it('never shows a raw code for an event or action it has no words for', () => {
    expect(epicHistoryText({ action: 'epic.pr', detail: { epicId: 'e', event: 'something_new' } })).not.toContain('something_new')
    expect(epicHistoryText({ action: 'epic.other', detail: { epicId: 'e' } })).not.toContain('epic.other')
  })
})

describe('taskCounts', () => {
  it('leaves merged tasks out of the Board count', () => {
    expect(taskCounts(tasks('merged', 'merged', 'ready'))).toEqual({ board: 1, backlog: 0 })
  })

  it('counts every open status on the Board', () => {
    const open: TaskStatus[] = ['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'blocked', 'failed']
    expect(taskCounts(tasks(...open)).board).toBe(open.length)
  })

  it('excludes Approved designs from open board work, and counts the Backlog apart', () => {
    expect(taskCounts([{ status: 'approved' }, { status: 'merged' }, { status: 'ready' }, { status: 'backlog' }])).toEqual({ board: 1, backlog: 1 })
  })
})

describe('runTokens', () => {
  it('shows cache reads and the weighted cost only when they were recorded', () => {
    const known = runTokens({ agentRuntime: 'codex', inputTokens: 2_000, cacheWriteTokens: null, cacheReadTokens: 1_000_000, outputTokens: 100_000 })
    expect(known).toContain('cache read')
    expect(known).toMatch(/\$\d/)
    expect(runTokens({ agentRuntime: 'claude-code', inputTokens: 44_244, cacheReadTokens: null, outputTokens: 369 })).not.toContain('cache read')
  })
})

describe('runtimes', () => {
  it('offers only runtimes whose CLI the runner found', () => {
    expect(detectedRuntimes([{ id: 'claude', version: '2.1.0' }, { id: 'codex', version: null }])).toEqual(['claude-code'])
    expect(detectedRuntimes([{ id: 'claude', version: '2.1.0' }, { id: 'codex', version: '0.50.0' }])).toEqual(['claude-code', 'codex'])
    expect(detectedRuntimes([])).toEqual([])
  })

  it('signs Codex in with device auth', () => {
    expect(cliLoginCommand('codex')).toContain('--device-auth')
    expect(cliLoginCommand('claude')).not.toContain('--device-auth')
  })
})

describe('agentStatus', () => {
  const now = Date.parse('2026-10-29T12:00:00Z')
  const idle = { paused: false, pausedUntil: null, activeRuns: 0 }
  const paused = agentStatus({ ...idle, paused: true }, now)
  const cooling = agentStatus({ ...idle, pausedUntil: new Date(now + 1000).toISOString() }, now)

  it('shows explicit pause even during a usage cooldown or active run', () => {
    expect(paused).not.toBeNull()
    expect(agentStatus({ ...idle, paused: true, pausedUntil: new Date(now + 1000).toISOString(), activeRuns: 1 }, now)).toEqual(paused)
  })

  it('shows a future usage cooldown', () => {
    expect(cooling).not.toBeNull()
    expect(cooling).not.toEqual(paused)
  })

  it('leaves past and just-expired cooldowns unmarked', () => {
    for (const offset of [-1000, 0]) {
      expect(agentStatus({ ...idle, pausedUntil: new Date(now + offset).toISOString() }, now)).toBeNull()
    }
  })

  it('leaves idle agents unmarked', () => {
    expect(agentStatus(idle, now)).toBeNull()
  })

  it('marks Working only on request', () => {
    expect(agentStatus({ ...idle, activeRuns: 1 }, now, true)).not.toBeNull()
    expect(agentStatus({ ...idle, activeRuns: 1 }, now)).toBeNull()
    expect(agentStatus({ ...idle, paused: true }, now)).toEqual(paused)
  })
})

describe('epic review status', () => {
  const epic = { reviewMode: 'epic' as const, branch: 'corral/epic-1', reviewState: null, taskCount: 2, mergedCount: 2 }

  it('has nothing to say while tasks are going in, or in direct mode', () => {
    expect(epicReviewStatus({ ...epic, mergedCount: 1 })).toBeNull()
    expect(epicReviewStatus({ ...epic, reviewMode: 'direct' })).toBeNull()
    expect(epicReviewStatus({ ...epic, reviewMode: 'direct', reviewState: 'ready_to_merge', sync: { state: 'failed', error: 'x' } })).toBeNull()
  })

  it('reports a stopped fix apart from a stopped rebase', () => {
    const stopped = (fix?: 'ci') => epicReviewStatus({ ...epic, reviewState: 'ready_to_merge', sync: { state: 'failed', error: 'x', ...fix && { fix } } })?.label
    expect(stopped('ci')).not.toBe(stopped())
  })

  it('keeps a parent task in progress until its PR merges, and a direct one until its tasks do', () => {
    expect(deliveryInProgress({ ...epic, reviewState: 'human_review' })).toBe(true)
    expect(deliveryInProgress({ ...epic, reviewState: 'merged' })).toBe(false)
    expect(deliveryInProgress({ ...epic, reviewMode: 'direct' })).toBe(false)
    expect(deliveryInProgress({ ...epic, branch: null })).toBe(false)
    expect(deliveryInProgress({ ...epic, taskCount: 0, mergedCount: 0 })).toBe(false)
  })

  it('counts live board tasks, leaving out Drafts and Backlog', () => {
    const counted = epicWithLiveCounts({ id: 'e', taskCount: 0, mergedCount: 0 } as Parameters<typeof epicWithLiveCounts>[0], [
      { type: 'task', epicId: 'e', status: 'merged' }, { type: 'task', epicId: 'e', status: 'ready' }, { type: 'design', epicId: 'e', status: 'approved' }, { type: 'design', epicId: 'e', status: 'merged' }, { type: 'task', epicId: 'e', status: 'backlog' }, { type: 'task', epicId: 'e', status: 'draft' }, { type: 'task', epicId: 'other', status: 'merged' }
    ])
    expect(counted).toMatchObject({ taskCount: 4, mergedCount: 2 })
  })
})

describe('runRef and runTitle', () => {
  const run = { taskRef: null, taskTitle: null, epicId: null, epicTitle: null, summary: null, role: 'pm' as const }

  it('names a parent task review after its parent, live or finished', () => {
    const live = { ...run, role: 'reviewer' as const, epicId: 'e-1', epicTitle: 'Saved searches' }
    expect(runRef(live)).not.toBe(runRef(run))
    expect(runTitle(live)).toBe('Saved searches')
    expect(runTitle({ ...live, summary: 'Works together.' })).toBe('Saved searches')
  })

  it('gives PM runs a fallback title no other role gets', () => {
    expect(runTitle({ ...run, role: 'reviewer' })).not.toBe(runTitle(run))
  })

  it('shows a task run\'s ref and title', () => {
    const task = { ...run, role: 'developer' as const, taskRef: 'COR-3', taskTitle: 'Prototype build' }
    expect(runRef(task)).toBe('COR-3')
    expect(runTitle(task)).toBe('Prototype build')
  })
})

describe('inboxItemLink', () => {
  it('opens the parent for a parent task\'s item, not the task the server named for it', () => {
    expect(inboxItemLink({ taskRef: 'COR-3', epicId: 'e-1' })?.to).toBe('/epics/e-1')
  })
  it('opens the task otherwise, and nothing without one', () => {
    expect(inboxItemLink({ taskRef: 'COR-3' })?.to).toBe('/tasks/COR-3')
    expect(inboxItemLink({ taskRef: null })).toBeNull()
  })
})

it('counts in the singular and the plural', () => {
  expect(plural(1, 'task')).toBe('1 task')
  expect(plural(0, 'task')).toBe('0 tasks')
  expect(plural(2, 'run')).toBe('2 runs')
})
