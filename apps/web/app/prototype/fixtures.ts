import { RUNNER_PROTOCOL_VERSION } from '@corral/contracts'
import corralThumbnail from '~/assets/images/corral-thumbnail.svg'
import type {
  Agent,
  AuditEntry,
  CliStatus,
  Comment,
  DesignVersion,
  Epic,
  Evidence,
  GlobalStatus,
  FlowMetrics,
  FlowMetricsQuery,
  Inbox,
  InboxItem,
  ReleaseNotesItem,
  PlanMessage,
  Plan,
  PlanSession,
  PlanThreadAttention,
  Profile,
  Project,
  PullRequestDetail,
  PullRequestFile,
  PullRequestStatus,
  RepoList,
  Review,
  Run,
  RunEvent,
  RunnerStatus,
  Task
} from '@corral/contracts'

// The prototype's data (D20, `pnpm prototype`): what the server would return,
// as plain objects of the contract types. Design agents edit or add to these
// so a screen shows the states they're designing; app/prototype/mock-api.ts
// serves them in place of /api. Nothing here reaches dev or production builds.

// An ISO time `minutes` before the page loaded, so the fixtures always look recent
const loadedAt = Date.now()
export function ago(minutes: number): string {
  return new Date(loadedAt - minutes * 60_000).toISOString()
}

export const profile: Profile = { id: 'user-1', name: 'Cormac', avatarUrl: null }

// Two runners, one of them offline, and an old one turned away for its
// protocol (design/settings.md, Runner)
export const runner: RunnerStatus = {
  runners: [
    { commit: 'prototype', serverCommit: 'prototype', behind: false, draining: false, updateRequested: false, id: 'runner-1', name: 'home-server', online: true, slotsInUse: 3, protocol: 2, needsUpdate: false, connectedAt: ago(600), lastHeartbeatAt: ago(0), slots: 4, runtimes: ['claude-code', 'codex'], roles: ['pm', 'developer', 'reviewer', 'design'] },
    { commit: 'prototype', serverCommit: 'prototype', behind: false, draining: false, updateRequested: false, id: 'runner-2', name: 'macbook', online: false, slotsInUse: 0, protocol: 2, needsUpdate: false, connectedAt: ago(300), lastHeartbeatAt: ago(42), slots: 2, runtimes: ['claude-code'], roles: ['developer', 'reviewer'] },
    { commit: 'prototype', serverCommit: 'prototype', behind: false, draining: false, updateRequested: false, id: 'runner-3', name: 'old-mini', online: false, slotsInUse: 0, protocol: 1, needsUpdate: true, connectedAt: ago(15), lastHeartbeatAt: ago(15), slots: 1, runtimes: [], roles: [] },
    ...['behind', 'draining', 'waiting', 'building', 'offline', 'failed'].map((state, i) => ({
      slotsInUse: state === 'draining' ? 2 : 0, protocol: RUNNER_PROTOCOL_VERSION, needsUpdate: false, id: `remote-${i}`, name: `gaming-pc-${state}`, online: state !== 'offline',
      commit: '1234567890123456789012345678901234567890',
      serverCommit: '9abcdef0123456789abcdef0123456789abcdef012',
      behind: true,
      draining: ['draining', 'waiting', 'building', 'offline'].includes(state),
      updateRequested: state !== 'behind' && state !== 'failed',
      activeRunCount: state === 'draining' ? 2 : 0,
      updateState: ['failed', 'building'].includes(state) ? state : '',
      updateError: state === 'failed' ? 'Image build failed; old runner taking work' : '',
      connectedAt: ago(60), lastHeartbeatAt: ago(0), slots: 4,
      runtimes: ['codex'], roles: ['developer' as const]
    }))
  ],
  protocol: 2,
  online: true,
  runnerId: 'runner-1',
  name: 'home-server',
  connectedAt: ago(600),
  lastHeartbeatAt: ago(0)
}

export const status: GlobalStatus = { stopped: false, updating: false }

export const projects: Project[] = [
  {
    id: 'p-corral',
    name: 'Corral',
    slug: 'corral',
    prefix: 'COR',
    thumbnailUrl: corralThumbnail,
    thumbnailColor: '#14b8a6',
    nextTaskNumber: 13,
    repository: 'cormacrw/corral',
    defaultBranch: 'main',
    mergeMethod: 'squash',
    requiredChecks: ['lint', 'test'],
    paused: false,
    humanReviewDefault: false,
    epicReviewModeDefault: 'epic',
    reviewRoundCap: 3,
    failedRunCap: 3,
    createdAt: ago(60 * 24 * 14),
    updatedAt: ago(60)
  },
  {
    id: 'p-site',
    name: 'Marketing site',
    slug: 'marketing-site',
    prefix: 'WEB',
    thumbnailUrl: null,
    thumbnailColor: '#8b5cf6',
    nextTaskNumber: 3,
    repository: 'cormacrw/site',
    defaultBranch: 'main',
    mergeMethod: 'squash',
    requiredChecks: [],
    paused: true,
    humanReviewDefault: true,
    epicReviewModeDefault: 'direct',
    reviewRoundCap: 3,
    failedRunCap: 3,
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(60 * 5)
  }
]

export const agents: Agent[] = [
  { id: 'a-design', name: 'Iris', role: 'designer', runtime: 'claude-code', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 1, avatarUrl: null },
  { id: 'a-paused', name: 'Pax', role: 'developer', runtime: 'codex', concurrency: 1, paused: true, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 0, avatarUrl: null },
  { id: 'a-limited', name: 'Uma', role: 'reviewer', runtime: 'codex', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: ago(-120), activeRuns: 0, avatarUrl: null },
  { id: 'a-pm', name: 'Pam', role: 'pm', runtime: 'claude-code', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: ago(60), activeRuns: 0, avatarUrl: null },
  { id: 'a-dev', name: 'Victor', role: 'developer', runtime: 'claude-code', concurrency: 2, paused: false, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 1, avatarUrl: null },
  { id: 'a-dev2', name: 'Dana', role: 'developer', runtime: 'codex', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 1, avatarUrl: null },
  { id: 'a-rev', name: 'Rita', role: 'reviewer', runtime: 'claude-code', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 2, avatarUrl: null }
]

export const epics: Epic[] = [
  {
    id: 'e-searches',
    dependsOn: [],
    blocks: [],
    projectId: 'p-corral',
    title: 'Saved searches',
    description: 'Save a board search and come back to it.',
    reviewMode: 'epic',
    branch: 'corral/epic-e-searches-saved-searches',
    prNumber: 212,
    prUrl: 'https://github.com/cormacrw/corral/pull/212',
    prHeadSha: '6f1c2ab94d',
    reviewState: 'conflict',
    reviewModeLocked: true,
    taskCount: 3,
    mergedCount: 3,
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(12)
  },
  {
    id: 'e-design',
    dependsOn: ['e-mobile'],
    blocks: [],
    projectId: 'p-corral',
    title: 'Design tasks',
    description: 'Versioned, sandboxed prototypes the human approves before the build is planned (D20).',
    reviewMode: 'each_task',
    branch: null,
    prNumber: null,
    prUrl: null,
    prHeadSha: null,
    reviewState: null,
    reviewModeLocked: true,
    taskCount: 9,
    mergedCount: 3,
    createdAt: ago(60 * 24 * 2),
    updatedAt: ago(60)
  },
  {
    id: 'e-mobile',
    dependsOn: [],
    blocks: ['e-design'],
    projectId: 'p-corral',
    title: 'Mobile app',
    description: 'The installable app for phones (D17).',
    reviewMode: 'direct',
    branch: null,
    prNumber: null,
    prUrl: null,
    prHeadSha: null,
    reviewState: null,
    reviewModeLocked: true,
    taskCount: 3,
    mergedCount: 1,
    createdAt: ago(60 * 24 * 7),
    updatedAt: ago(60 * 24)
  },
  {
    id: 'e-site', projectId: 'p-site', title: 'Website refresh',
    description: 'Refresh the landing page and navigation.', dependsOn: [], blocks: [],
    reviewMode: 'direct', branch: null, prNumber: null, prUrl: null, prHeadSha: null, reviewState: null, reviewModeLocked: false,
    taskCount: 2, mergedCount: 0, createdAt: ago(60 * 24), updatedAt: ago(30)
  },
  {
    id: 'e-shipped', projectId: 'p-site', title: 'Pricing fixes',
    description: 'Completed fixes.', dependsOn: [], blocks: [],
    reviewMode: 'direct', branch: null, prNumber: null, prUrl: null, prHeadSha: null, reviewState: null, reviewModeLocked: false,
    taskCount: 1, mergedCount: 1, createdAt: ago(60 * 24), updatedAt: ago(10)
  },
  {
    id: 'e-empty', projectId: 'p-site', title: 'Future campaigns',
    description: 'Planning only.', dependsOn: [], blocks: [],
    reviewMode: 'direct', branch: null, prNumber: null, prUrl: null, prHeadSha: null, reviewState: null, reviewModeLocked: false,
    taskCount: 0, mergedCount: 0, createdAt: ago(60), updatedAt: ago(5)
  },
  // Nothing has opened a PR, so its review mode can still change
  {
    id: 'e-exports', projectId: 'p-corral', title: 'CSV exports',
    description: 'Export the board and run history as CSV.', dependsOn: [], blocks: [],
    reviewMode: 'epic', branch: 'corral/epic-e-exports-csv-exports', prNumber: null, prUrl: null, prHeadSha: null, reviewState: null, reviewModeLocked: false,
    taskCount: 2, mergedCount: 0, createdAt: ago(60 * 5), updatedAt: ago(40)
  },
  // One epic in each other epic PR review state (D27), its tasks all merged
  // but for the fix still open under changes requested
  epicInReview('e-alerts', 'Failure alerts', 'human_review', 214),
  epicInReview('e-webhooks', 'Webhook retries', 'open', 215),
  epicInReview('e-audit', 'Audit trail', 'in_review', 216),
  epicInReview('e-themes', 'Project themes', 'changes_requested', 217),
  epicInReview('e-digest', 'Weekly digest', 'ready_to_merge', 218),
  epicInReview('e-tags', 'Task tags', 'merged', 219)
]

function epicInReview(id: string, title: string, reviewState: Epic['reviewState'], prNumber: number): Epic {
  const fixing = reviewState === 'changes_requested'
  return {
    id, projectId: 'p-corral', title, description: `${title}, reviewed as one epic PR.`, dependsOn: [], blocks: [],
    reviewMode: 'epic', branch: `corral/epic-${id}`, prNumber, prUrl: `https://github.com/cormacrw/corral/pull/${prNumber}`,
    prHeadSha: `${prNumber}c2ab94d`, reviewState, reviewModeLocked: true,
    taskCount: fixing ? 3 : 2, mergedCount: 2, createdAt: ago(60 * 24 * 2), updatedAt: ago(prNumber - 200)
  }
}

// A paragraph of task text, as the editor stores it
function doc(...paragraphs: string[]): Task['description'] {
  return { type: 'doc', content: paragraphs.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) }
}

// A task with sensible defaults; give only what the screen needs
export function task(project: Project, number: number, fields: Partial<Task> & Pick<Task, 'title'> & Pick<Task, 'status'>): Task {
  return {
    id: `t-${project.prefix.toLowerCase()}-${number}`,
    projectId: project.id,
    ref: `${project.prefix}-${number}`,
    number,
    description: doc(`${fields.title}.`),
    priority: 'medium',
    type: 'task',
    epicId: null,
    humanReview: project.humanReviewDefault,
    reviewRounds: 0,
    failedRuns: 0,
    paused: false,
    branch: null,
    pr: null,
    acceptanceCriteria: [],
    dependsOn: [],
    waitingOnEpics: [],
    lease: null,
    // Filled from the runs below: null until a run of the role claims it (D15)
    developer: null,
    reviewer: null,
    headSha: null,
    latestReview: null,
    mergeCommitSha: null,
    mergedAt: null,
    gateChecks: null,
    design: null,
    createdAt: ago(60 * 24),
    updatedAt: ago(30),
    ...fields,
    ...fixtureStatus(fields)
  }
}

function fixtureStatus(fields: Partial<Task> & Pick<Task, 'status'>) {
  if (fields.status === 'draft') return { status: fields.status, statusReason: null, draftSession: fields.draftSession ?? null } as const
  if (fields.status === 'blocked' || fields.status === 'failed') {
    if (!fields.statusReason?.trim()) throw new Error('Fixture needs a reason')
    return { status: fields.status, statusReason: fields.statusReason, draftSession: null } as const
  }
  return { status: fields.status, statusReason: null, draftSession: null } as const
}

function criteria(...texts: string[]): Task['acceptanceCriteria'] {
  return texts.map((text, position) => ({ id: `c-${position + 1}-${text.length}`, position, text, met: null }))
}

const [corral, site] = projects as [Project, Project]

export const tasks: Task[] = [
  task(corral, 20, { title: 'Design the agent settings experience', type: 'design', status: 'in_progress', branch: 'design/COR-20', humanReview: true, lease: { agentId: 'a-design', runId: 'r-design', role: 'designer', expiresAt: ago(-10) }, acceptanceCriteria: criteria('Agent settings work on desktop and mobile') }),
  task(corral, 41, { title: 'Navigation design', type: 'design', status: 'human_review', epicId: 'e-design', branch: 'design/COR-41', humanReview: true }),
  task(corral, 40, { title: 'Approved navigation prototype', type: 'design', status: 'approved', epicId: 'e-design', branch: 'design/COR-40', humanReview: true }),
  task(corral, 1, { title: 'Design task type and versions', status: 'merged', epicId: 'e-design', pr: { number: 60, url: 'https://github.com/cormacrw/corral/pull/60' }, mergedAt: ago(60 * 20), mergeCommitSha: 'da0ebe6' }),
  task(corral, 2, { title: 'Serve design bundles sandboxed', status: 'merged', epicId: 'e-design', dependsOn: ['COR-1'], pr: { number: 62, url: 'https://github.com/cormacrw/corral/pull/62' }, mergedAt: ago(60 * 3), mergeCommitSha: 'e5e8457' }),
  task(corral, 3, {
    title: 'Static prototype build with mock data',
    status: 'in_progress',
    priority: 'high',
    epicId: 'e-design',
    dependsOn: ['COR-2'],
    branch: 'corral/cor-3-static-prototype',
    pr: { number: 66, url: 'https://github.com/cormacrw/corral/pull/66' },
    lease: { agentId: 'a-dev2', runId: 'r-1', role: 'developer', expiresAt: ago(-10) },
    acceptanceCriteria: criteria('`pnpm prototype` outputs index.html with fixture data', 'Works from a sub-path with no API', 'CLAUDE.md documents it')
  }),
  task(corral, 4, {
    title: 'Design review screen',
    status: 'agent_review',
    type: 'design',
    epicId: 'e-design',
    branch: 'design/COR-4',
    pr: { number: 63, url: 'https://github.com/cormacrw/corral/pull/63' },
    lease: { agentId: 'a-rev', runId: 'r-2', role: 'reviewer', expiresAt: ago(-12) },
    reviewRounds: 1,
    acceptanceCriteria: criteria('Shows every version with its screenshots', 'Approve and request changes from the page')
  }),
  task(corral, 5, {
    title: 'Approve a design version from the inbox',
    status: 'human_review',
    humanReview: true,
    epicId: 'e-design',
    branch: 'corral/cor-5-approve-design',
    pr: { number: 64, url: 'https://github.com/cormacrw/corral/pull/64' },
    reviewRounds: 1,
    gateChecks: [{ name: 'lint', url: null }, { name: 'test', url: null }],
    acceptanceCriteria: criteria('Approve marks the version approved', 'Earlier versions are superseded', 'The approval response identifies the version', 'Diagnostic artifacts are retained').map(c => ({ ...c, met: true }))
  }),
  // Pinned to v1 of the design after v2 was approved, so it's flagged (D20)
  task(corral, 6, { title: 'Pin build tasks to a design', status: 'ready', epicId: 'e-design', dependsOn: ['COR-5'], design: { taskRef: 'COR-4', version: 1, screens: ['review', 'review-empty'], newerVersion: 2 } }),
  task(corral, 7, { title: 'PM drafts tasks from an approved design', status: 'ready_to_merge', epicId: 'e-design', pr: { number: 65, url: 'https://github.com/cormacrw/corral/pull/65' } }),
  task(corral, 8, { title: 'Push notifications for Needs you', status: 'blocked', epicId: 'e-mobile', statusReason: 'Which push service should the server use: Web Push with VAPID keys, or ntfy?' }),
  task(corral, 9, { title: 'Offline board', status: 'failed', type: 'bug', priority: 'urgent', epicId: 'e-mobile', failedRuns: 3, statusReason: 'The runner lost its worktree three times in a row.' }),
  task(corral, 10, { title: 'Install sheet on iOS', status: 'merged', epicId: 'e-mobile', mergedAt: ago(60 * 30) }),
  task(corral, 11, { title: 'Dark mode for the epic graph', status: 'backlog', priority: 'low' }),
  task(corral, 12, { title: 'Spike: Codex reasoning effort', status: 'backlog', type: 'spike' }),
  // Drafts from the proposed plans in planSessions s-1 and s-3
  task(corral, 13, { title: 'Design review screen', status: 'draft', type: 'design', priority: 'high', epicId: 'e-design', draftSession: { id: 's-1', title: 'Design tasks' } }),
  task(corral, 14, { title: 'Approve a design version', status: 'draft', priority: 'urgent', epicId: 'e-design', dependsOn: ['COR-13'], draftSession: { id: 's-1', title: 'Design tasks' } }),
  task(corral, 15, { title: 'Pin a design version to a task', status: 'draft', priority: 'low', epicId: 'e-design', dependsOn: ['COR-14'], draftSession: { id: 's-1', title: 'Design tasks' } }),
  task(corral, 16, { title: 'Cards jump when a run starts', status: 'draft', type: 'bug', draftSession: { id: 's-3', title: 'Board polish' } }),
  task(corral, 17, { title: 'Spike: virtualise long columns', status: 'draft', type: 'spike', priority: 'low', draftSession: { id: 's-3', title: 'Board polish' } }),
  // Stopped by a human, one in each state a run can be stopped in
  task(corral, 18, {
    title: 'Retry webhooks after a server restart',
    status: 'agent_review',
    paused: true,
    branch: 'corral/cor-18-retry-webhooks',
    pr: { number: 67, url: 'https://github.com/cormacrw/corral/pull/67' },
    acceptanceCriteria: criteria('Undelivered webhooks are sent again after a restart')
  }),
  task(corral, 19, { title: 'Keep the run log open across reloads', status: 'in_progress', paused: true, branch: 'corral/cor-19-run-log' }),
  ...epicTasks('e-searches', 36, ['Save a board search', 'List saved searches', 'Share a saved search']),
  task(corral, 21, { title: 'Export the board as CSV', status: 'ready', epicId: 'e-exports' }),
  task(corral, 22, { title: 'Export run history as CSV', status: 'ready', epicId: 'e-exports', dependsOn: ['COR-21'] }),
  ...epicTasks('e-alerts', 23, ['Alert when a run fails', 'Alert when a runner disconnects']),
  ...epicTasks('e-webhooks', 25, ['Queue failed webhooks', 'Back off between retries']),
  ...epicTasks('e-audit', 27, ['Record every status change', 'Show the trail on a task']),
  ...epicTasks('e-themes', 29, ['Pick a project colour', 'Theme the board header']),
  task(corral, 31, { title: 'Fix: theme contrast on the board header', status: 'in_progress', epicId: 'e-themes' }),
  ...epicTasks('e-digest', 32, ['Collect the week\'s merges', 'Send the digest']),
  ...epicTasks('e-tags', 34, ['Add tags to tasks', 'Filter the Board by tag'], 60),
  task(corral, 39, {
    title: 'Spike: resilient SSE reconnects', type: 'spike', status: 'human_review',
    headSha: 'findings-spike-39',
    acceptanceCriteria: criteria('Recommend a reconnect strategy').map(c => ({ ...c, met: true }))
  }),
  task(site, 1, { title: 'New landing page hero', status: 'ready', type: 'design', epicId: 'e-site' }),
  task(site, 2, { title: 'Fix broken pricing link', status: 'merged', type: 'bug', epicId: 'e-shipped', mergedAt: ago(60 * 24 * 10) }),
  task(site, 3, {
    title: 'Footer links open in the same tab',
    epicId: 'e-site',
    status: 'in_progress',
    type: 'bug',
    branch: 'corral/web-3-footer-links',
    lease: { agentId: 'a-dev', runId: 'r-4', role: 'developer', expiresAt: ago(-14) },
    acceptanceCriteria: criteria('Footer links open in the same tab')
  })
]

function epicTasks(epicId: string, first: number, titles: string[], mergedMinutesAgo = 60 * 24 * 5): Task[] {
  return titles.map((title, i) => task(corral, first + i, {
    title, status: 'merged', epicId, pr: { number: first + 100 + i, url: `https://github.com/cormacrw/corral/pull/${first + 100 + i}` },
    mergedAt: ago(mergedMinutesAgo), mergeCommitSha: `${first + i}e8457`
  }))
}

const at = (ref: string): Task => tasks.find(t => t.ref === ref)!

export const runs: Run[] = [
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-design', number: 140, agentId: 'a-design', agentName: 'Iris', agentRuntime: 'claude-code', role: 'designer', projectId: 'p-corral',
    planSessionId: null, taskId: at('COR-20').id, taskRef: 'COR-20', taskTitle: at('COR-20').title, epicId: null, epicTitle: null, state: 'running', outcome: null, summary: null,
    error: null, headSha: null, inputTokens: 12000, cacheReadTokens: 80000, outputTokens: 3000, rateLimitResetAt: null,
    queuedAt: ago(12), startedAt: ago(11), endedAt: null, timings: null
  },
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-design-done', number: 139, agentId: 'a-design', agentName: 'Iris', agentRuntime: 'claude-code', role: 'designer', projectId: 'p-corral',
    planSessionId: null, taskId: at('COR-4').id, taskRef: 'COR-4', taskTitle: at('COR-4').title, epicId: null, epicTitle: null, state: 'completed', outcome: 'design_submitted', summary: 'Submitted the review screen prototype.',
    error: null, headSha: 'design-review-v1', inputTokens: 8000, cacheReadTokens: 60000, outputTokens: 2000, rateLimitResetAt: null,
    queuedAt: ago(120), startedAt: ago(119), endedAt: ago(100), timings: null
  },
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-1', number: 128, agentId: 'a-dev2', agentName: 'Dana', agentRuntime: 'claude-code', role: 'developer', projectId: 'p-corral',
    planSessionId: null, taskId: at('COR-3').id, taskRef: 'COR-3', taskTitle: at('COR-3').title, epicId: null, epicTitle: null, state: 'running', outcome: null, summary: null,
    error: null, headSha: null, inputTokens: 18_200, cacheReadTokens: 240_000, outputTokens: 6_100, rateLimitResetAt: null,
    queuedAt: ago(25), startedAt: ago(24), endedAt: null, timings: null
  },
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-2', number: 129, agentId: 'a-rev', agentName: 'Rita', agentRuntime: 'claude-code', role: 'reviewer', projectId: 'p-corral',
    planSessionId: null, taskId: at('COR-4').id, taskRef: 'COR-4', taskTitle: at('COR-4').title, epicId: null, epicTitle: null, state: 'running', outcome: null, summary: null,
    error: null, headSha: '9e71e28', inputTokens: 9_000, cacheReadTokens: 80_000, outputTokens: 1_200, rateLimitResetAt: null,
    queuedAt: ago(8), startedAt: ago(7), endedAt: null, timings: null
  },
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-3', number: 127, agentId: 'a-dev', agentName: 'Victor', agentRuntime: 'claude-code', role: 'developer', projectId: 'p-corral',
    planSessionId: null, taskId: at('COR-5').id, taskRef: 'COR-5', taskTitle: at('COR-5').title, epicId: null, epicTitle: null, state: 'completed', outcome: 'pr_opened',
    summary: 'Approving a version marks it approved and supersedes earlier ones.', error: null, headSha: '5b030d7',
    inputTokens: 30_000, cacheReadTokens: 400_000, outputTokens: 9_800, rateLimitResetAt: null,
    queuedAt: ago(140), startedAt: ago(139), endedAt: ago(95),
    timings: {
      totalMs: 2_700_000,
      phases: [
        { phase: 'worktree_prepare', durationMs: 40_000 },
        { phase: 'session_setup', durationMs: 20_000 },
        { phase: 'agent_cold_start', durationMs: 2_520_000 },
        { phase: 'push', durationMs: 90_000 },
        { phase: 'finish', durationMs: 30_000 }
      ],
      tools: [
        { tool: 'get_task', count: 2, totalMs: 800, maxMs: 500 },
        { tool: 'exec_command', count: 36, totalMs: 1_080_000, maxMs: 240_000 },
        { tool: 'apply_patch', count: 12, totalMs: 6_000, maxMs: 1_200 }
      ]
    }
  },
  {
    runnerId: 'runner-2', runnerName: 'macbook', id: 'r-5', number: 126, agentId: 'a-rev', agentName: 'Rita', agentRuntime: 'claude-code', role: 'reviewer', projectId: 'p-corral',
    planSessionId: null, taskId: at('COR-5').id, taskRef: 'COR-5', taskTitle: at('COR-5').title, epicId: null, epicTitle: null, state: 'completed', outcome: 'approved',
    summary: 'Every criterion is met.', error: null, headSha: '5b030d7',
    inputTokens: 12_000, cacheReadTokens: 90_000, outputTokens: 2_000, rateLimitResetAt: null,
    queuedAt: ago(90), startedAt: ago(89), endedAt: ago(80), timings: null
  },
  // One of each way a run gets cut off, so the Activity tab and the run list show their errors
  ...([
    [121, 'failed', 'The run hit its time limit of 60 minutes. Last transcript activity: 2026-10-30T08:59:41.000Z', 410],
    [122, 'interrupted', 'Stopped by the server: The server no longer recognises this run. Last transcript activity: 2026-10-30T09:40:12.000Z', 380],
    [123, 'interrupted', 'The runner shut down (container stop or redeploy) and stopped the agent. Last transcript activity: 2026-10-30T10:12:03.000Z', 330],
    [124, 'failed', 'The agent was killed by SIGTERM, which came from outside Corral. Last transcript activity: 2026-10-30T11:02:55.000Z', 280]
  ] as const).map(([number, state, error, endedAgo]): Run => ({
    runnerId: null, runnerName: null, id: `r-cut-${number}`, number, agentId: 'a-dev2', agentName: 'Dana', agentRuntime: 'claude-code', role: 'developer', projectId: 'p-corral',
    planSessionId: null, taskId: at('COR-3').id, taskRef: 'COR-3', taskTitle: at('COR-3').title, epicId: null, epicTitle: null, state, outcome: state === 'failed' ? 'failed' : null, summary: null,
    error, headSha: null, inputTokens: 4_000, cacheReadTokens: 22_000, outputTokens: 900, rateLimitResetAt: null,
    queuedAt: ago(endedAgo + 22), startedAt: ago(endedAgo + 21), endedAt: ago(endedAgo), timings: null
  })),
  // PM turns have no outcome to report: one finished, one stopped
  ...([
    [125, 'completed', 'The flaky test is the SSE reconnect one.', null, 240],
    [120, 'interrupted', null, 'Stopped by a human', 500]
  ] as const).map(([number, state, summary, error, endedAgo]): Run => ({
    runnerId: 'runner-1', runnerName: 'home-server', id: `r-pm-${number}`, number, agentId: 'a-pm', agentName: 'Pam', agentRuntime: 'claude-code', role: 'pm', projectId: 'p-corral',
    planSessionId: null, taskId: null, taskRef: null, taskTitle: null, epicId: null, epicTitle: null, state, outcome: null, summary,
    error, headSha: null, inputTokens: 2_000, cacheReadTokens: 12_000, outputTokens: 400, rateLimitResetAt: null,
    queuedAt: ago(endedAgo + 3), startedAt: ago(endedAgo + 2), endedAt: ago(endedAgo), timings: null
  })),
  // A live Codex run, which can't take messages mid-run
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-4', number: 130, agentId: 'a-dev', agentName: 'Victor', agentRuntime: 'claude-code', role: 'developer', projectId: 'p-site',
    planSessionId: null, taskId: at('WEB-3').id, taskRef: 'WEB-3', taskTitle: at('WEB-3').title, epicId: null, epicTitle: null, state: 'running', outcome: null, summary: null,
    error: null, headSha: null, inputTokens: 4_000, cacheReadTokens: 22_000, outputTokens: 900, rateLimitResetAt: null,
    queuedAt: ago(5), startedAt: ago(4), endedAt: null, timings: null
  },
  // An epic's integration review has no task, live and finished
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-epic', number: 131, agentId: 'a-rev', agentName: 'Rita', agentRuntime: 'claude-code', role: 'reviewer', projectId: 'p-corral',
    planSessionId: null, taskId: null, taskRef: null, taskTitle: null, epicId: 'e-searches', epicTitle: 'Saved searches', state: 'running', outcome: null, summary: null,
    error: null, headSha: '6f1c2ab94d', inputTokens: 7_000, cacheReadTokens: 50_000, outputTokens: 1_000, rateLimitResetAt: null,
    queuedAt: ago(3), startedAt: ago(2), endedAt: null, timings: null
  },
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-epic-done', number: 125, agentId: 'a-rev', agentName: 'Rita', agentRuntime: 'claude-code', role: 'reviewer', projectId: 'p-corral',
    planSessionId: null, taskId: null, taskRef: null, taskTitle: null, epicId: 'e-searches', epicTitle: 'Saved searches', state: 'completed', outcome: 'changes_requested',
    summary: 'The UI sends the wrong search field.', error: null, headSha: '4d2be81',
    inputTokens: 11_000, cacheReadTokens: 70_000, outputTokens: 1_800, rateLimitResetAt: null,
    queuedAt: ago(200), startedAt: ago(199), endedAt: ago(190), timings: null
  },
  // A PM turn belongs to a Plan session, not a task or an epic
  {
    runnerId: 'runner-1', runnerName: 'home-server', id: 'r-pm', number: 120, agentId: 'a-pm', agentName: 'Pam', agentRuntime: 'claude-code', role: 'pm', projectId: 'p-corral',
    planSessionId: null, taskId: null, taskRef: null, taskTitle: null, epicId: null, epicTitle: null, state: 'completed', outcome: null, summary: null,
    error: null, headSha: null, inputTokens: 2_000, cacheReadTokens: 10_000, outputTokens: 400, rateLimitResetAt: null,
    queuedAt: ago(300), startedAt: ago(299), endedAt: ago(297), timings: null
  }
]

// A task's author and reviewer are the agents of its latest run of each
// role, as the server fills them; tasks with no run stay "Any available"
for (const t of tasks) {
  const latest = (role: 'developer' | 'designer' | 'reviewer') => runs.filter(r => r.taskId === t.id && r.role === role).sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0]
  const developer = latest(t.type === 'design' ? 'designer' : 'developer')
  const reviewer = latest('reviewer')
  t.developer = developer ? { id: developer.agentId, name: developer.agentName } : null
  t.reviewer = reviewer ? { id: reviewer.agentId, name: reviewer.agentName } : null
}

// Unbreakable tokens that once widened the Plan conversation past a phone's screen
const LONG_PATH = 'apps/web/app/components/plan/conversation/PlanConversationMessageLogWithAVeryLongName.vue'
const LONG_URL = 'https://github.com/cormacrw/corral/blob/main/apps/web/app/pages/plan/%5BsessionId%5D.vue?plain=1#L180-L260'
const LONG_CODE = 'useTaskFlyout().openPlanWithAVeryLongOptionName({ replace: true })'
const WIDE_TABLE = [
  '| File | Change | Reason |',
  '| --- | --- | --- |',
  `| ${LONG_PATH} | Adds overflow-wrap anywhere to every paragraph | A long token widens its flex parent |`,
  '| apps/web/app/components/RunTranscript.vue | Constrains the step list | Tool output is whitespace-pre-wrap |'
].join('\n')
const LONG_BLOCK = '```ts\nconst message = await api.plan.message(session.value.id, text.value, taskRef.value ?? undefined) // and a long trailing comment\n```'

export const runEvents: Record<string, RunEvent[]> = {
  'r-1': [
    { type: 'system', text: 'Run #128 started on home-server' },
    { type: 'message', text: 'Reading CLAUDE.md and docs/README.md first.' },
    { type: 'tool_call', id: 'call-1', tool: 'Bash', input: { command: 'cat apps/web/nuxt.config.ts' } },
    { type: 'tool_result', id: 'call-1', output: 'export default defineNuxtConfig({ … })', isError: false },
    { type: 'thinking', text: 'All API calls go through one function, so fixtures can replace it.' },
    { type: 'message', text: 'Adding a fixture-backed data layer behind a build flag.' }
  ],
  'r-3': [
    { type: 'system', text: 'Run #127 started on home-server' },
    { type: 'message', text: 'Approving a version marks it approved and supersedes earlier ones.' },
    { type: 'system', text: 'Reported pr_opened' }
  ],
  'r-4': [
    { type: 'system', text: 'Run #130 started on home-server' },
    { type: 'message', text: 'Looking for the footer component.' },
    { type: 'tool_call', id: 'call-1', tool: 'Bash', input: { command: 'grep -rn target=\\"_blank\\" src/components' } },
    { type: 'tool_result', id: 'call-1', output: 'src/components/SiteFooter.vue:14', isError: false }
  ],
  // The Plan session full of long tokens (s-4): a finished turn and the live one
  'r-plan-1': [
    { type: 'thinking', text: `The overflow comes from ${LONG_PATH}, where a ${LONG_CODE} never breaks.` },
    { type: 'tool_call', id: 'call-1', tool: 'Read', input: { file_path: LONG_PATH } },
    { type: 'tool_result', id: 'call-1', output: `${LONG_URL}\n${'x'.repeat(240)}`, isError: false },
    { type: 'tool_call', id: 'call-2', tool: 'Bash', input: { command: `grep -rn "${LONG_CODE}" ${LONG_PATH}` } },
    { type: 'tool_result', id: 'call-2', output: `grep: ${LONG_PATH}: No such file or directory`, isError: true }
  ],
  'r-plan-2': [
    { type: 'thinking', text: `Checking ${LONG_URL} next.` },
    { type: 'tool_call', id: 'call-1', tool: 'Bash', input: { command: `curl -s ${LONG_URL}` } },
    { type: 'tool_result', id: 'call-1', output: 'y'.repeat(300), isError: true }
  ]
}

export const comments: Record<string, Comment[]> = {
  [at('COR-39').id]: [{
    id: 'cm-findings', taskId: at('COR-39').id, author: { kind: 'agent', role: 'developer', runId: 'r-spike' }, pinned: false, createdAt: ago(10),
    body: '## Findings\n\n### Recommendation\n\nUse **exponential backoff** with jitter.\n\n- Resume from the last event ID.\n- Cap the retry delay at 30 seconds.\n\nFollow up: add reconnect coverage for interrupted streams.'
  }],
  [at('COR-3').id]: [
    { id: 'cm-1', taskId: at('COR-3').id, author: { kind: 'human', userId: 'user-1' }, body: 'Keep the fixtures out of the production bundle.', pinned: true, createdAt: ago(40) },
    { id: 'cm-2', taskId: at('COR-3').id, author: { kind: 'agent', role: 'developer', runId: 'r-1' }, body: 'Done: the fixtures load only when the prototype flag is set.', pinned: false, createdAt: ago(10) },
    { id: 'cm-rebase-verified', taskId: at('COR-3').id, author: { kind: 'system', component: 'server' }, body: 'Trivial rebase verified without review: only the conflicted files changed (`apps/server/src/app.ts`) and no project doc changed on the base. The approval carried over to f6e5d4c3b2.', pinned: false, createdAt: ago(5) }
  ]
}

export const history: Record<string, AuditEntry[]> = {
  [at('COR-3').id]: [
    { id: 1, projectId: 'p-corral', taskId: at('COR-3').id, actor: { kind: 'human', userId: 'user-1' }, action: 'task.created', detail: {}, createdAt: ago(60 * 24) },
    { id: 2, projectId: 'p-corral', taskId: at('COR-3').id, actor: { kind: 'system', component: 'scheduler' }, action: 'task.transition', detail: { from: 'ready', to: 'in_progress' }, createdAt: ago(25) },
    { id: 3, projectId: 'p-corral', taskId: at('COR-3').id, actor: { kind: 'system', component: 'scheduler' }, action: 'run.ended', detail: { runId: 'r-rebase-1', runNumber: 119, state: 'completed', outcome: 'pr_rebased', review: 'trivial', conflictedFiles: ['apps/web/app/components/TaskDetail.vue', 'apps/server/src/prompts.ts'] }, createdAt: ago(20) },
    { id: 4, projectId: 'p-corral', taskId: at('COR-3').id, actor: { kind: 'system', component: 'scheduler' }, action: 'run.ended', detail: { runId: 'r-rebase-2', runNumber: 120, state: 'completed', outcome: 'pr_rebased', review: 'needs_review', conflictedFiles: ['packages/core/src/task-machine.ts', 'docs/decisions.md'] }, createdAt: ago(15) },
    { id: 5, projectId: 'p-corral', taskId: at('COR-3').id, actor: { kind: 'system', component: 'server' }, action: 'rebase.verified', detail: { approvedHeadSha: 'a1b2c3d4e5', headSha: 'f6e5d4c3b2', conflictedFiles: ['apps/server/src/app.ts'] }, createdAt: ago(5) }
  ]
}

// D21: human files, note-only proof, mixed evidence and artifact-only proof.
const reviewTask = at('COR-5')
const criterionId = (position: number) => reviewTask.acceptanceCriteria[position]!.id
const fileEvidence = (id: string, position: number | null, kind: Exclude<Evidence['kind'], 'note'>, fileName: string, contentType: string, url: string): Evidence => ({
  id, taskId: reviewTask.id, criterionId: position === null ? null : criterionId(position),
  runId: 'r-2', round: 0, kind, note: '', fileName, contentType, size: 128, url, createdAt: ago(20)
})
const requestUrl = 'data:text/plain,' + encodeURIComponent('POST /api/designs/v1/approve\nHTTP/1.1 200 OK\n{"version":1,"state":"approved"}')
const logUrl = 'data:text/plain,' + encodeURIComponent('Approval recorded for version 1. Earlier versions superseded.')
// A self-contained preview image keeps the prototype independent of the API.
const screenshotUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#f8fafc"/><rect x="32" y="32" width="576" height="296" rx="12" fill="white" stroke="#cbd5e1"/><text x="64" y="90" font-family="sans-serif" font-size="24" fill="#0f172a">Design version 1</text><text x="64" y="146" font-family="sans-serif" font-size="20" fill="#15803d">✓ Approved</text><text x="64" y="198" font-family="sans-serif" font-size="16" fill="#475569">The build can now be planned.</text></svg>')
export const evidence: Record<string, Evidence[]> = {
  [at('COR-39').id]: [{
    id: 'ev-spike', taskId: at('COR-39').id, criterionId: at('COR-39').acceptanceCriteria[0]!.id, runId: 'r-spike', round: 0, kind: 'note',
    note: '**Investigation:** replaying the last event ID recovered missed events; capped backoff avoided repeated immediate retries.',
    fileName: null, contentType: null, size: 0, url: null, createdAt: ago(15)
  }],
  [reviewTask.id]: [
    fileEvidence('ev-shot', 0, 'screenshot', 'approved-version.svg', 'image/svg+xml', screenshotUrl),
    fileEvidence('ev-log', 0, 'log', 'approval.log', 'text/plain', logUrl),
    { id: 'ev-note', taskId: reviewTask.id, criterionId: criterionId(1), runId: 'r-2', round: 0, kind: 'note', createdAt: ago(20), fileName: null, contentType: null, url: null, size: 0, note: '**Earlier versions are superseded.** The approval transaction updates previous versions atomically. See `approveDesignVersion` in the design service.' },
    { ...fileEvidence('ev-request', 2, 'request', 'approval-response.txt', 'text/plain', requestUrl), createdAt: ago(40) },
    fileEvidence('ev-output', 3, 'test_output', 'diagnostics.txt', 'text/plain', logUrl),
    fileEvidence('ev-text', null, 'text', 'agent-summary.txt', 'text/plain', logUrl),
    fileEvidence('ev-other', null, 'other', 'debug.json', 'application/json', 'data:application/json,%7B%22version%22%3A1%7D')
  ]
}

// A long file name and link, to keep the Inbox's epic review honest at phone width
const alertTask = at('COR-23')
evidence[alertTask.id] = [
  fileEvidence('ev-alert-log', null, 'log', 'failed-run-alert-delivered-to-every-open-browser-session.log', 'text/plain', logUrl),
  { id: 'ev-alert-note', taskId: alertTask.id, criterionId: null, runId: 'r-2', round: 0, kind: 'note', createdAt: ago(20), fileName: null, contentType: null, url: null, size: 0, note: 'Checked with https://github.com/cormacrw/corral/blob/main/apps/server/src/notifications/failed-run-alerts.test.ts and a stopped runner.' }
]

export const reviews: Record<string, Review[]> = {
  [at('COR-39').id]: [{
    id: 'review-spike', taskId: at('COR-39').id, runId: 'r-spike-review', round: 0, headSha: 'findings-spike-39',
    verdict: 'approved', summary: 'The findings answer the investigation.', author: { kind: 'agent', role: 'reviewer', runId: 'r-spike-review' },
    criteria: at('COR-39').acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: 'The recommendation covers replay and bounded retries.' })),
    createdAt: ago(5)
  }],
  [reviewTask.id]: [{
    id: 'review-5', taskId: reviewTask.id, runId: 'r-2', round: 0, headSha: '5b030d7e1c',
    verdict: 'approved', summary: 'Approval verified.', author: { kind: 'agent', role: 'reviewer', runId: 'r-2' },
    criteria: reviewTask.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Verified the approval flow and its recorded result.' })),
    createdAt: ago(15)
  }]
}

// Open PRs and their merge gates (GET /projects/:slug/pull-requests), one
// for each state the Pull requests page shows
function pullRequest(ref: string, fields: Partial<PullRequestStatus> & Pick<PullRequestStatus, 'merge'>): PullRequestStatus {
  const t = at(ref)
  const project = projects.find(p => p.id === t.projectId)!
  if (!t.pr) throw new Error('Pull request fixture needs PR data')
  return {
    taskRef: t.ref,
    taskTitle: t.title,
    taskStatus: t.status,
    pr: { number: t.pr.number, url: t.pr.url, state: 'open', headSha: '5b030d7e1c' },
    review: { verdict: 'approved', headSha: '5b030d7e1c', forHeadCommit: true, createdAt: ago(40) },
    ci: { status: 'passing', checks: project.requiredChecks.map(name => ({ name, conclusion: 'success', url: null })) },
    branch: { name: t.branch, mergeable: true, mergeableState: 'clean', upToDate: true, rebase: 'not_needed' },
    evidenceComplete: true,
    humanReviewOutstanding: false,
    ...fields
  }
}
// PR descriptions and diffs by task (GET /projects/:slug/tasks/:number/pull-request)
const approvePatch = [
  '@@ -41,5 +41,8 @@ export async function approveDesignVersion(db: Database, taskId: string, version: number) {',
  '-  await db.update(designVersions).set({ status: \'approved\' }).where(eq(designVersions.version, version))',
  '+  return db.transaction(async (tx) => {',
  '+    await tx.update(designVersions).set({ status: \'superseded\' }).where(eq(designVersions.taskId, taskId))',
  '+    return tx.update(designVersions).set({ status: \'approved\' }).where(eq(designVersions.version, version))',
  '+  })'
].join('\n')
const approveFiles: PullRequestFile[] = [
  { path: 'apps/server/src/designs.ts', status: 'modified', additions: 4, deletions: 1, patch: approvePatch },
  { path: 'apps/server/src/designs.test.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+it(\'supersedes earlier versions in the same transaction\')' }
]
function prDetail(ref: string, body: string, fields: Partial<PullRequestDetail> = {}): PullRequestDetail {
  const t = at(ref)
  return {
    number: t.prNumber!, url: t.prUrl!, title: t.title, body, headBranch: t.branch ?? `corral/${t.ref.toLowerCase()}`,
    // In an `epic` or `each_task` epic, a task PR's base is the epic branch (D23)
    baseBranch: epics.find(e => e.id === t.epicId)?.branch ?? 'main',
    files: approveFiles, totalFiles: approveFiles.length, truncated: false, ...fields
  }
}
export const pullRequestDetails: PullRequestDetail[] = [
  prDetail('COR-5', '## What\n\nApproving a design version supersedes earlier versions in the same transaction.\n\n## How it was checked\n\n- New `designs.test.ts` covers supersede-on-approve'),
  // Over the cap: the rest of the diff is on GitHub
  prDetail('COR-7', '## What\n\nThe PM drafts tasks from an approved design.', { totalFiles: 34, truncated: true })
]

const eligible = { eligible: true, failingGate: null, failedGates: [] }

export const pullRequests: PullRequestStatus[] = [
  // Sent back: changes requested on an older commit, a failing check and a conflict
  pullRequest('COR-3', {
    review: { verdict: 'changes_requested', headSha: '1a2b3c4d5e', forHeadCommit: false, createdAt: ago(90) },
    ci: { status: 'failing', checks: [{ name: 'lint', conclusion: 'success', url: null }, { name: 'test', conclusion: 'failure', url: null }] },
    branch: { name: 'corral/cor-3-static-prototype', mergeable: false, mergeableState: 'dirty', upToDate: true, rebase: 'conflict' },
    evidenceComplete: false,
    merge: { eligible: false, failingGate: 'approvalIsForHeadCommit', failedGates: ['approvalIsForHeadCommit', 'requiredChecksPassed', 'evidenceComplete', 'mergeable'] }
  }),
  // In review: not reviewed yet, CI still running, behind the base
  pullRequest('COR-4', {
    review: null,
    ci: { status: 'pending', checks: [{ name: 'lint', conclusion: 'success', url: null }, { name: 'test', conclusion: 'pending', url: null }] },
    branch: { name: 'design/COR-4', mergeable: true, mergeableState: 'behind', upToDate: false, rebase: 'requested' },
    merge: { eligible: false, failingGate: 'approvalIsForHeadCommit', failedGates: ['approvalIsForHeadCommit', 'requiredChecksPassed'] }
  }),
  pullRequest('COR-5', { humanReviewOutstanding: true, merge: eligible }),
  pullRequest('COR-7', { merge: eligible })
]

export const planSessions: PlanSession[] = [
  {
    id: 's-idle', projectId: 'p-corral', title: 'Explore keyboard shortcuts', runtime: 'codex',
    preview: 'We can pick this up when you are ready.', unread: false, closed: false,
    status: 'none', activeRunId: null, createdAt: ago(120), updatedAt: ago(90)
  },
  {
    id: 's-1', projectId: 'p-corral', title: 'Design tasks', runtime: 'claude-code',
    preview: 'Here is a plan with six tasks. Approve it to put them on the board.',
    unread: true, closed: false, status: 'needs_approval', activeRunId: null, createdAt: ago(60 * 26), updatedAt: ago(60 * 25)
  },
  {
    id: 's-2', projectId: 'p-corral', title: 'Mobile push', runtime: 'claude-code',
    preview: 'Which push service should we use?', unread: false, closed: false, status: 'question', activeRunId: null,
    createdAt: ago(60 * 4), updatedAt: ago(60 * 3)
  },
  {
    id: 's-3', projectId: 'p-corral', title: 'Board polish', runtime: 'claude-code',
    preview: 'Here is a plan with two tasks. Approve it to put them on the board.', unread: false, closed: false, status: 'needs_approval', activeRunId: null,
    createdAt: ago(60 * 51), updatedAt: ago(60 * 50)
  },
  {
    id: 's-4', projectId: 'p-corral', title: 'Long tokens', runtime: 'claude-code',
    preview: 'Here is what widens the thread.', unread: false, closed: false, status: 'none', activeRunId: 'r-plan-2',
    createdAt: ago(60 * 2), updatedAt: ago(5)
  },
  {
    id: 's-5', projectId: 'p-corral', title: 'Flaky CI', runtime: 'claude-code',
    preview: 'The flaky test is the SSE reconnect one.', unread: true, closed: false, status: 'none', activeRunId: null,
    createdAt: ago(60 * 7), updatedAt: ago(60 * 6)
  }
]

export const planMessages: Record<string, PlanMessage[]> = {
  's-idle': [
    { id: 'm-idle', sessionId: 's-idle', role: 'pm', kind: 'message', text: 'We can pick this up when you are ready.', recommendation: null, options: null, planId: null, runId: null, createdAt: ago(90) }
  ],
  's-1': [
    { id: 'm-1', sessionId: 's-1', role: 'human', kind: 'message', text: 'Plan design tasks: prototypes the human approves before the build.', recommendation: null, options: null, planId: null, runId: null, createdAt: ago(60 * 26) },
    { id: 'm-2', sessionId: 's-1', role: 'pm', kind: 'message', text: 'Here is a plan with six tasks. Approve it to put them on the board.', recommendation: null, options: null, planId: 'plan-1', runId: null, createdAt: ago(60 * 25) }
  ],
  's-2': [
    { id: 'm-3', sessionId: 's-2', role: 'human', kind: 'message', text: 'Add push notifications for Needs you.', recommendation: null, options: null, planId: null, runId: null, createdAt: ago(60 * 4) },
    { id: 'm-4', sessionId: 's-2', role: 'pm', kind: 'question', text: 'Which push service should we use?', recommendation: 'Web Push', options: ['Web Push with VAPID keys', 'ntfy'], planId: null, runId: null, createdAt: ago(60 * 3) }
  ],
  's-3': [
    { id: 'm-5', sessionId: 's-3', role: 'human', kind: 'message', text: 'The board jumps around when runs start. Tidy it up.', recommendation: null, options: null, planId: null, runId: null, createdAt: ago(60 * 51) },
    { id: 'm-6', sessionId: 's-3', role: 'pm', kind: 'message', text: 'Here is a plan with two tasks. Approve it to put them on the board.', recommendation: null, options: null, planId: 'plan-3', runId: null, createdAt: ago(60 * 50) }
  ],
  's-4': [
    { id: 'm-7', sessionId: 's-4', role: 'human', kind: 'message', text: `On my phone the thread scrolls sideways. See ${LONG_PATH} and ${LONG_URL}, around \`${LONG_CODE}\`.\n\n${WIDE_TABLE}\n\n${LONG_BLOCK}`, recommendation: null, options: null, planId: null, runId: null, createdAt: ago(60 * 2) },
    { id: 'm-8', sessionId: 's-4', role: 'pm', kind: 'message', text: `Here is what widens the thread:\n\n- ${LONG_PATH}\n- [${LONG_URL}](${LONG_URL})\n- \`${LONG_CODE}\`\n\n${WIDE_TABLE}\n\n${LONG_BLOCK}`, recommendation: null, options: null, planId: 'plan-4', runId: 'r-plan-1', createdAt: ago(60) }
  ],
  's-5': [
    { id: 'm-9', sessionId: 's-5', role: 'human', kind: 'message', text: 'Why does CI keep failing on main?', recommendation: null, options: null, planId: null, runId: null, createdAt: ago(60 * 7) },
    { id: 'm-10', sessionId: 's-5', role: 'pm', kind: 'message', text: 'The flaky test is the SSE reconnect one. It waits a fixed 50 ms for the server to restart; polling for the reconnect would fix it.', recommendation: null, options: null, planId: null, runId: null, createdAt: ago(60 * 6) }
  ]
}

// What Juno does next in a session when you reply (mock-api.ts): asks the
// next question, then proposes the plan once they run out or you say stop
export const grilling: Record<string, { questions: Pick<PlanMessage, 'text' | 'recommendation' | 'options'>[], plan: Pick<Plan, 'title' | 'summary' | 'tasks'> }> = {
  's-2': {
    questions: [
      { text: 'What should a push say? Only the task and why it needs you, or a preview of the agent\'s message too?', recommendation: 'Task ref, title and the reason', options: ['Task ref, title and the reason', 'Include a preview of the message'] },
      { text: 'Which items should push? Everything in Needs you can get noisy.', recommendation: 'Questions and human review only', options: ['Everything in Needs you', 'Questions and human review only', 'Only blocked tasks'] },
      { text: 'Should tapping a push open the Inbox item, or the task page?', recommendation: 'The Inbox item', options: ['The Inbox item', 'The task page'] }
    ],
    plan: {
      title: 'Mobile push',
      summary: 'Web Push notifications for Needs you items, opening the Inbox item.',
      tasks: [
        { key: 'T1', change: 'added', revises: false, taskId: null, epicId: null, ref: null, title: 'VAPID keys and push subscriptions', status: 'draft', priority: 'urgent', humanReview: false, dependsOn: [] },
        { key: 'T2', change: 'added', revises: false, taskId: null, epicId: null, ref: null, title: 'Send a push when an item needs you', status: 'draft', priority: 'high', humanReview: true, dependsOn: ['T1'] },
        { key: 'T3', change: 'added', revises: false, taskId: null, epicId: null, ref: null, title: 'Open the Inbox item from a push', status: 'draft', priority: 'low', humanReview: false, dependsOn: ['T2'] }
      ]
    }
  }
}

export const plans: Record<string, Plan[]> = {
  's-1': [
    {
      id: 'plan-1', sessionId: 's-1', projectId: 'p-corral', epicId: null, version: 1, title: 'Design tasks',
      summary: 'A design task type whose deliverable is an approved, versioned prototype.', status: 'proposed', approvedAt: null,
      epics: [{ key: 'E1', id: 'e-design', title: 'Design tasks', reviewMode: 'each_task' }],
      tasks: [
        { key: 'T1', change: 'added', revises: false, taskId: 't-cor-13', epicId: 'e-design', ref: 'COR-13', title: 'Design review screen', status: 'draft', priority: 'high', humanReview: true, dependsOn: [] },
        { key: 'T2', change: 'added', revises: false, taskId: 't-cor-14', epicId: 'e-design', ref: 'COR-14', title: 'Approve a design version', status: 'draft', priority: 'urgent', humanReview: false, dependsOn: ['T1'] },
        { key: 'T3', change: 'added', revises: false, taskId: 't-cor-15', epicId: 'e-design', ref: 'COR-15', title: 'Pin a design version to a task', status: 'draft', priority: 'low', humanReview: false, dependsOn: ['T2'] }
      ],
      createdAt: ago(60 * 25)
    }
  ],
  's-3': [
    {
      id: 'plan-3', sessionId: 's-3', projectId: 'p-corral', epicId: null, version: 1, title: 'Board polish',
      summary: 'Steadier cards while runs start, and a look at long columns.', status: 'proposed', approvedAt: null,
      epics: [],
      tasks: [
        { key: 'T1', change: 'added', revises: false, taskId: 't-cor-16', epicId: null, ref: 'COR-16', title: 'Cards jump when a run starts', status: 'draft', priority: 'medium', humanReview: false, dependsOn: [] },
        { key: 'T2', change: 'added', revises: false, taskId: 't-cor-17', epicId: null, ref: 'COR-17', title: 'Spike: virtualise long columns', status: 'draft', priority: 'low', humanReview: false, dependsOn: [] }
      ],
      createdAt: ago(60 * 50)
    }
  ],
  's-4': [
    {
      id: 'plan-4', sessionId: 's-4', projectId: 'p-corral', epicId: null, version: 1, title: 'Keep the Plan conversation within a phone\'s screen width',
      summary: 'Long tokens wrap; code blocks and tables scroll in their own box.', status: 'approved', approvedAt: ago(30), epics: [],
      tasks: [
        { key: 'T1', change: 'added', revises: false, taskId: null, epicId: null, ref: null, title: 'Wrap long tokens in messages', status: 'draft', priority: 'high', humanReview: false, dependsOn: [] }
      ],
      createdAt: ago(60)
    }
  ]
}

export const repos: RepoList = {
  signedIn: true,
  fetchedAt: ago(1),
  repos: [
    { nameWithOwner: 'cormacrw/corral', description: 'An autonomous software factory', isPrivate: true, updatedAt: ago(30), defaultBranch: 'main', selectable: false, reason: 'used_by_project', usedBy: { slug: 'corral', name: 'Corral' } },
    { nameWithOwner: 'cormacrw/test-app', description: 'Test repository', isPrivate: false, updatedAt: ago(60 * 24), defaultBranch: 'main', selectable: true, reason: null, usedBy: null }
  ]
}

export const clis: CliStatus[] = [
  { id: 'claude', name: 'Claude Code', version: '2.1.0', signedIn: true },
  { id: 'codex', name: 'Codex', version: '0.50.0', signedIn: false }
]

export const releaseNotes: ReleaseNotesItem[] = [{
  id: 'release-demo', deploymentId: 'release-demo', type: 'release_notes',
  project: { id: projects[0]!.id, slug: projects[0]!.slug, name: projects[0]!.name, thumbnailColor: projects[0]!.thumbnailColor, thumbnailUrl: projects[0]!.thumbnailUrl },
  subject: 'Release notes', preview: 'A clearer board and faster task reviews.',
  sender: { name: agents.find(a => a.role === 'pm')?.name ?? 'PM', role: 'pm' }, at: ago(5),
  fromSha: '6a3b2c1', toSha: '9d8e7f6',
  notes: '## What shipped\n\n- **Clearer board:** COR-3 makes tasks easier to find.\n- Faster task reviews and a more useful Inbox.\n- Attachments are now checked with SHA-256.',
  notesStatus: 'ready', unread: true, taskId: null, taskRef: null, prUrl: null, resolution: null
}]
export const resolvedInbox: Inbox['resolved'] = []

// The inbox is derived from the tasks above that need the human
// What a thread waits on, or nothing when it's missing the data its status needs
function threadAttention(status: PlanSession['status'], last?: PlanMessage, plan?: Plan, reply?: PlanMessage): PlanThreadAttention | null {
  if (status === 'question') {
    if (last?.kind !== 'question') return null
    return { status, question: { text: last.text, recommendation: last.recommendation, options: last.options }, plan: null, planId: null, reply: null }
  }
  if (status === 'needs_approval') {
    if (!plan) return null
    const summary = { id: plan.id, version: plan.version, title: plan.title, summary: plan.summary, epicCount: plan.epics.length, taskCount: plan.tasks.filter(t => t.change !== 'removed').length }
    return { status, question: null, plan: summary, planId: plan.id, reply: null }
  }
  return reply ? { status, question: null, plan: null, planId: null, reply: reply.text } : null
}

export function inbox(): Inbox {
  const needsYou: InboxItem[] = tasks
    .filter(t => t.status === 'human_review' || t.status === 'blocked' || t.status === 'failed')
    .map((t) => {
      const project = projects.find(p => p.id === t.projectId)!
      const type = t.status === 'human_review' ? 'human_review' as const : t.status === 'blocked' ? 'blocked' as const : 'failed' as const
      const subject = type === 'human_review' ? `Review ${t.title}` : t.title
      const body = (t.type === 'spike' ? comments[t.id]?.findLast(c => c.body.startsWith('## Findings'))?.body : null) ?? t.statusReason ?? 'The reviewer approved this change and it needs your review.'
      const message = t.ref === 'COR-5'
        ? 'I fixed the approval flow you flagged. Approving a version now supersedes earlier versions in the same transaction. The reviewer approved the change; it is ready for your review.'
        : t.type === 'spike' ? 'I recommend exponential backoff with jitter and replay from the last event ID. The findings are ready for you to accept.' : body
      return {
        id: t.id,
        type,
        project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
        taskId: t.id,
        taskRef: t.ref,
        subject,
        preview: message.slice(0, 200),
        message,
        since: t.ref === 'COR-5' ? { at: ago(30), text: 'Keep earlier evidence and show the approval result.', notes: [], fixTasks: [] } : null,
        newArtifacts: [
          ...(t.type === 'design' ? (designVersions[t.id] ?? []).slice(0, 1).map(v => ({ id: v.id, kind: 'design' as const, name: `Design v${v.version}`, url: v.previewUrl, taskRef: null, at: v.createdAt })) : []),
          ...(evidence[t.id] ?? []).filter(e => e.kind !== 'note' && e.url && e.createdAt > (t.ref === 'COR-5' ? ago(30) : '')).map(e => ({ id: e.id, kind: e.kind as Exclude<Evidence['kind'], 'note'>, name: e.fileName!, url: e.url!, taskRef: null, at: e.createdAt }))
        ],
        body,
        sender: type === 'failed' ? { name: 'Corral', role: 'system' as const } : { name: type === 'blocked' ? 'Victor' : 'Rita', role: type === 'blocked' ? 'developer' as const : 'reviewer' as const },
        at: t.updatedAt,
        prUrl: t.pr?.url ?? null,
        resolution: null
      }
    })
  // Threads waiting on the human: a question, a plan needing approval or an unread reply
  for (const session of planSessions.filter(s => !s.closed && (s.status !== 'none' || s.unread))) {
    const project = projects.find(p => p.id === session.projectId)!
    const messages = planMessages[session.id] ?? []
    const last = messages.at(-1)
    const plan = plans[session.id]?.find(p => p.status === 'proposed')
    const reply = messages.findLast(m => m.role === 'pm')
    const waiting = threadAttention(session.status, last, plan, reply)
    if (!waiting) continue
    needsYou.push({
      ...waiting,
      id: session.id, type: 'plan_thread', sessionId: session.id,
      project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
      subject: session.title, preview: session.preview ?? '',
      // When it started waiting: the question, the plan or the reply
      sender: { name: agents.find(a => a.role === 'pm')?.name ?? 'PM', role: 'pm' }, at: (session.status === 'needs_approval' ? plan?.createdAt : session.status === 'question' ? last?.createdAt : reply?.createdAt) ?? session.updatedAt,
      taskId: null, taskRef: null, prUrl: null, resolution: null,
      runtime: session.runtime, unread: session.unread,
      activeRunId: session.activeRunId
    })
  }
  const review = epics.find(e => e.reviewState === 'human_review')
  if (review) {
    const project = projects.find(p => p.id === review.projectId)!
    const body = 'The combined diff matches the epic\'s goal. Failed runs and runner disconnects share one alert path, and the tasks agree on its payload.'
    needsYou.push({
      id: review.id, type: 'epic_review', epicId: review.id, taskId: null, taskRef: null, subject: review.title,
      project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
      preview: body, body, message: body, sender: { name: 'Rita', role: 'reviewer' }, at: review.updatedAt,
      prUrl: review.prUrl!, resolution: null, headSha: review.prHeadSha!,
      tasks: tasks.filter(t => t.epicId === review.id).map(task => ({ task, evidence: evidence[task.id] ?? [] })),
      since: null, newArtifacts: []
    })
  }
  const conflict = epics.find(e => e.reviewState === 'conflict')
  if (conflict) {
    const project = projects.find(p => p.id === conflict.projectId)!
    const files = ['apps/server/src/routes/search.ts', 'apps/web/app/pages/search.vue', 'apps/web/app/components/saved-searches/SavedSearchShareDialogWithExpiryOptions.vue']
    const body = `The epic PR can't rebase onto main. Conflicting files: ${files.join(', ')}.`
    needsYou.push({
      id: conflict.id, type: 'epic_conflict', epicId: conflict.id, taskId: null, taskRef: null, subject: conflict.title,
      project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
      preview: body, body, message: body, sender: { name: 'Corral', role: 'system' }, at: conflict.updatedAt,
      prUrl: conflict.prUrl!, resolution: null, headSha: conflict.prHeadSha!, targetBranch: 'main', files, since: null, newArtifacts: []
    })
  }
  const completed = tasks.find(t => t.status === 'merged')!
  const project = projects.find(p => p.id === completed.projectId)!
  const activity: Inbox['activity'] = [{
    id: 'activity-merged', type: 'activity',
    project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
    taskId: completed.id, taskRef: completed.ref, subject: completed.title,
    preview: 'The task was merged.', body: 'The task was merged.',
    sender: { name: 'Corral', role: 'system' }, at: completed.updatedAt,
    prUrl: completed.pr?.url ?? null, resolution: null
  }]
  const count = needsYou.length
  needsYou.push(...releaseNotes.filter(r => !r.resolution))
  needsYou.sort((a, b) => b.at.localeCompare(a.at))
  return { needsYou, activity, resolved: [...resolvedInbox, ...releaseNotes.filter(r => r.resolution)], count }
}

// Different cohorts make every window visibly distinct. Marketing site has no
// merges in 7d, demonstrating the window-specific empty state.
export function flowMetrics(slug: string, window: FlowMetricsQuery['window']): FlowMetrics {
  const scale = window === '7d' ? 1 : window === '30d' ? 2 : 3
  const empty = slug === 'marketing-site' && window === '7d'
  const pair = (hours: number) => ({ medianMs: hours * scale * 3_600_000, p90Ms: hours * scale * 1.8 * 3_600_000 })
  return {
    window,
    mergedTaskCount: empty ? 0 : 3 * scale,
    leadTime: empty ? pair(0) : pair(48),
    cycleTime: empty ? pair(0) : pair(12),
    timeInStatus: empty
      ? []
      : [
          { status: 'backlog', ...pair(36) },
          { status: 'ready', ...pair(2) },
          { status: 'in_progress', ...pair(4) },
          { status: 'agent_review', ...pair(1) },
          { status: 'human_review', ...pair(4) },
          { status: 'ready_to_merge', ...pair(1) }
        ],
    runsByRole: empty
      ? []
      : [
          { role: 'developer', duration: pair(0.5), queueWait: pair(0.1) },
          { role: 'reviewer', duration: pair(0.2), queueWait: pair(0.05) },
          { role: 'pm', duration: pair(0.1), queueWait: pair(0.02) }
        ],
    averageDeveloperRuns: empty ? 0 : scale,
    slowestTasks: empty
      ? []
      : (slug === 'corral' ? ['COR-1', 'COR-10', 'COR-2'] : ['WEB-2']).map((ref, i) => ({
          ref, leadTimeMs: (72 - i * 12) * scale * 3_600_000, dominantStatus: 'backlog'
        }))
  }
}

// The Complete column's approved design also exercises the reopening panel.
export const designVersions: Record<string, DesignVersion[]> = {
  't-cor-41': [{
    id: 'design-cor-41-v2', version: 2, status: 'submitted', branch: 'design/COR-41', commitSha: 'prototype-navigation-review',
    spec: '# Navigation prototype\n\n## Screens\n- navigation: project links and board states',
    // In the static fixture, the same app's board is the submitted preview.
    screenshots: [], previewUrl: './#/projects/corral/board', feedback: null, planSessionId: null, createdAt: ago(10)
  }],
  't-cor-40': [{
    id: 'design-cor-40-v1', version: 1, status: 'approved', branch: 'design/COR-40', commitSha: 'prototype-navigation',
    spec: '# Navigation prototype\n\n## Screens\n- navigation: project links and board states',
    screenshots: [], previewUrl: 'about:blank', feedback: null, planSessionId: null, createdAt: ago(30)
  }]
}
