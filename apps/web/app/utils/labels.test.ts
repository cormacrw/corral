import type { TaskStatus } from '@corral/core'
import { describe, expect, it } from 'vitest'
import { agentStatus, cliLoginCommand, detectedRuntimes, formatMs, epicInProgress, epicReviewStatus, epicWithLiveCounts, inboxItemLink, plural, prNumberLabel, runtimeLabel, runBadge, runRef, runTitle, runTokens, statusCounts, taskCounts, taskTypeBadge, cardTypeIcon } from './labels.ts'

const tasks = (...statuses: TaskStatus[]) => statuses.map(status => ({ status }))

describe('statusCounts', () => {
  it('combines merged tasks and approved designs into one Complete count', () => {
    expect(statusCounts(tasks('merged', 'approved', 'ready', 'merged', 'approved'))).toEqual([
      { status: 'ready', label: 'Ready', count: 1 },
      { status: 'approved', label: 'Complete', count: 4 }
    ])
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

describe('agentStatus', () => {
  const now = Date.parse('2026-10-29T12:00:00Z')
  const idle = { paused: false, pausedUntil: null, activeRuns: 0 }

  it('shows explicit pause even during a usage cooldown or active run', () => {
    expect(agentStatus({ ...idle, paused: true, pausedUntil: new Date(now + 1000).toISOString(), activeRuns: 1 }, now)).toEqual({ label: 'Paused', color: 'neutral' })
  })

  it('shows a future usage cooldown', () => {
    expect(agentStatus({ ...idle, pausedUntil: new Date(now + 1000).toISOString() }, now)?.label).toBe('Waiting on usage limit')
  })

  it('leaves past and just-expired cooldowns unmarked', () => {
    for (const offset of [-1000, 0]) {
      expect(agentStatus({ ...idle, pausedUntil: new Date(now + offset).toISOString() }, now)).toBeNull()
    }
  })

  it('leaves idle agents unmarked', () => {
    expect(agentStatus(idle, now)).toBeNull()
  })

  it('can omit Working when the layout already indicates work', () => {
    expect(agentStatus({ ...idle, activeRuns: 1 }, now)?.label).toBe('Working')
    expect(agentStatus({ ...idle, activeRuns: 1 }, now, false)).toBeNull()
    expect(agentStatus({ ...idle, paused: true }, now, false)?.label).toBe('Paused')
  })
})

it('excludes Approved designs from open board work', () => {
  expect(taskCounts([{ status: 'approved' }, { status: 'merged' }, { status: 'ready' }, { status: 'backlog' }])).toEqual({ board: 1, backlog: 1 })
})

it('gives a Board card an icon for every type but a plain task', () => {
  expect(cardTypeIcon('task')).toBeNull()
  expect(cardTypeIcon('bug')).toEqual({ name: 'i-lucide-bug', label: 'Bug' })
  expect(cardTypeIcon('design')).toEqual({ name: 'i-lucide-paintbrush', label: 'Design' })
  expect(cardTypeIcon('spike')).toEqual({ name: 'i-lucide-flask-conical', label: 'Spike' })
})

it('labels completed rebase developer runs', () => {
  expect(runBadge({ state: 'completed', role: 'developer', outcome: 'pr_rebased' })).toEqual({ label: 'PR rebased', color: 'primary' })
})

describe('epic review status', () => {
  const epic = { reviewMode: 'epic' as const, branch: 'corral/epic-1', reviewState: null, taskCount: 2, mergedCount: 2 }

  it('says all tasks complete and awaiting review for an epic PR with the human', () => {
    expect(epicReviewStatus({ ...epic, reviewState: 'human_review' })?.label).toBe('All tasks complete, awaiting your review')
  })

  it('has nothing to say while tasks are going in, or in direct mode', () => {
    expect(epicReviewStatus({ ...epic, mergedCount: 1 })).toBeNull()
    expect(epicReviewStatus({ ...epic, reviewState: 'ready_to_merge', sync: { state: 'deciding', question: 'Which?', taskId: 't', taskRef: 'COR-1' } })).toEqual({ label: 'Rebase needs your decision', color: 'warning' })
    expect(epicReviewStatus({ ...epic, reviewState: 'open', sync: { state: 'resolving', files: ['a.ts'], taskId: 't', taskRef: 'COR-1' } })).toEqual({ label: 'Resolving a rebase conflict', color: 'info' })
    expect(epicReviewStatus({ ...epic, reviewState: 'ready_to_merge', sync: { state: 'failed', error: 'Network down' } })).toEqual({ label: 'Rebase stopped, retry to carry on', color: 'error' })
    expect(epicReviewStatus({ ...epic, reviewMode: 'direct' })).toBeNull()
  })

  it('keeps an epic in progress until its PR merges, and a direct one until its tasks do', () => {
    expect(epicInProgress({ ...epic, reviewState: 'human_review' })).toBe(true)
    expect(epicInProgress({ ...epic, reviewState: 'merged' })).toBe(false)
    expect(epicInProgress({ ...epic, reviewMode: 'direct' })).toBe(false)
    expect(epicInProgress({ ...epic, branch: null })).toBe(false)
    expect(epicInProgress({ ...epic, taskCount: 0, mergedCount: 0 })).toBe(false)
  })

  it('counts live board tasks, leaving out Drafts and Backlog', () => {
    const counted = epicWithLiveCounts({ id: 'e', taskCount: 0, mergedCount: 0 } as Parameters<typeof epicWithLiveCounts>[0], [
      { type: 'task', epicId: 'e', status: 'merged' }, { type: 'task', epicId: 'e', status: 'ready' }, { type: 'design', epicId: 'e', status: 'approved' }, { type: 'design', epicId: 'e', status: 'merged' }, { type: 'task', epicId: 'e', status: 'backlog' }, { type: 'task', epicId: 'e', status: 'draft' }, { type: 'task', epicId: 'other', status: 'merged' }
    ])
    expect(counted).toMatchObject({ taskCount: 4, mergedCount: 2 })
  })
})

describe('formatMs', () => {
  it('scales from milliseconds to days', () => {
    expect([0, 400, 9000, 60_000, 125_000, 3_599_600, 5_400_000, 86_400_000, 129_600_000].map(formatMs))
      .toEqual(['0 ms', '400 ms', '9.0 s', '1m 0s', '2m 5s', '1h', '1.5h', '1d', '1.5d'])
  })
})

describe('runRef and runTitle', () => {
  const run = { taskRef: null, taskTitle: null, epicId: null, epicTitle: null, summary: null, role: 'pm' as const }

  it('names an epic review after its epic, live or finished', () => {
    const live = { ...run, role: 'reviewer' as const, epicId: 'e-1', epicTitle: 'Saved searches' }
    expect(runRef(live)).toBe('Epic')
    expect(runTitle(live)).toBe('Saved searches')
    expect(runTitle({ ...live, summary: 'Works together.' })).toBe('Saved searches')
  })

  it('keeps PM turn and Plan for PM runs only', () => {
    expect(runRef(run)).toBe('Plan')
    expect(runTitle(run)).toBe('PM turn')
    expect(runTitle({ ...run, role: 'reviewer' })).not.toBe('PM turn')
  })

  it('shows a task run\'s ref and title', () => {
    const task = { ...run, role: 'developer' as const, taskRef: 'COR-3', taskTitle: 'Prototype build' }
    expect(runRef(task)).toBe('COR-3')
    expect(runTitle(task)).toBe('Prototype build')
  })
})

describe('inboxItemLink', () => {
  it('opens the epic for an epic\'s item, not the task the server named for it', () => {
    expect(inboxItemLink({ taskRef: 'COR-3', epicId: 'e-1' })).toEqual({ to: '/epics/e-1', label: 'Epic' })
  })
  it('opens the task otherwise, and nothing without one', () => {
    expect(inboxItemLink({ taskRef: 'COR-3' })).toEqual({ to: '/tasks/COR-3', label: 'Task' })
    expect(inboxItemLink({ taskRef: null })).toBeNull()
  })
})

it('counts in the singular and the plural', () => {
  expect(plural(1, 'task')).toBe('1 task')
  expect(plural(0, 'task')).toBe('0 tasks')
  expect(plural(2, 'run')).toBe('2 runs')
})

it('names a PR by number when its URL has one', () => {
  expect(prNumberLabel('https://github.com/o/r/pull/41')).toBe('#41')
  expect(prNumberLabel(null)).toBe('Open PR')
})
