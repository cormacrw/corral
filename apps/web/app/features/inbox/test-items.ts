import { DEFAULT_AGENT_RUNTIME } from '@corral/core'
import type { Inbox, PlanThreadItem, PullRequestDetail, Task, TaskInboxItem } from '@corral/contracts'

// Small Inbox data for the inbox tests, so editing the demo data can't break them

export const project = { id: 'p-1', slug: 'app', name: 'App', thumbnailColor: null, thumbnailUrl: null }
const at = '2026-11-01T00:00:00.000Z'

// A task item, with the task ID derived from its ref
export function taskItem(taskRef: string, type: TaskInboxItem['type'], fields: Partial<TaskInboxItem> = {}): TaskInboxItem {
  return {
    id: `t-${taskRef}`, type, project, taskId: `t-${taskRef}`, taskRef,
    subject: `Task ${taskRef}`, preview: '', message: '', body: '',
    sender: { name: 'Rita', role: 'reviewer' }, at, prUrl: null, resolution: null, unread: false,
    since: null, newArtifacts: [],
    ...fields
  }
}

// The task behind an item
export function task(ref: string, fields: Partial<Task> = {}): Task {
  return {
    id: `t-${ref}`, projectId: project.id, ref, number: Number(ref.split('-')[1]) || 1, title: `Task ${ref}`,
    description: null, implementationPlan: null, priority: 'medium', type: 'task', kind: 'normal',
    epicId: null, parentTask: null, rollup: null, humanReview: true, reviewRounds: 0, failedRuns: 0, paused: false,
    branch: null, pr: null, acceptanceCriteria: [], dependsOn: [], waitingOnEpics: [], lease: null,
    developer: null, reviewer: null, headSha: null, latestReview: null, mergeCommitSha: null, mergedAt: null,
    submission: null, gateChecks: null, design: null, createdAt: at, updatedAt: at,
    status: 'human_review', statusReason: null, draftSession: null,
    ...fields
  } as Task
}

export function planThread(id: string, fields: Partial<PlanThreadItem> = {}): PlanThreadItem {
  return {
    id, sessionId: id, type: 'plan_thread', taskId: null, taskRef: null, prUrl: null, resolution: null, project,
    sender: { name: 'Juno', role: 'pm' }, at, subject: `Thread ${id}`, preview: '', runtime: DEFAULT_AGENT_RUNTIME,
    status: 'question', question: { text: 'Which one?', recommendation: null, options: null }, plan: null, planId: null, failure: null,
    unread: false, activeRunId: null,
    ...fields
  } as PlanThreadItem
}

export const inboxOf = (needsYou: Inbox['needsYou'], rest: Partial<Inbox> = {}): Inbox => ({ needsYou, activity: [], resolved: [], count: needsYou.length, ...rest })

export function pullRequest(number: number, fields: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number, url: `https://github.com/o/r/pull/${number}`, title: 'Change', body: '', baseBranch: 'main', headBranch: 'corral/change', headSha: 'sha',
    files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+a' }], totalFiles: 1, truncated: false,
    ...fields
  }
}
