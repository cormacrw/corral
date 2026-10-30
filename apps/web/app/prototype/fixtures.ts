import corralThumbnail from '~/assets/images/corral-thumbnail.svg'
import type {
  Agent,
  AuditEntry,
  CliStatus,
  DesignVersion,
  Comment,
  Epic,
  EpicInboxItem,
  EpicReview,
  Evidence,
  GlobalStatus,
  Inbox,
  InboxItem,
  TaskInboxItem,
  PlanMessage,
  Plan,
  PlanSession,
  Profile,
  Project,
  PullRequestDetail,
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

export const runner: RunnerStatus = {
  runners: [{ id: 'runner-1', name: 'home-server', online: true, connectedAt: ago(600), lastHeartbeatAt: ago(0), slots: 4, runtimes: ['claude-code', 'codex'], roles: ['pm', 'developer', 'reviewer', 'design'] }],
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
  { id: 'a-paused', name: 'Pax', role: 'developer', runtime: 'codex', concurrency: 1, paused: true, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 0, avatarUrl: null },
  { id: 'a-limited', name: 'Uma', role: 'reviewer', runtime: 'codex', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: ago(-120), activeRuns: 0, avatarUrl: null },
  { id: 'a-pm', name: 'Pam', role: 'pm', runtime: 'claude-code', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: ago(60), activeRuns: 0, avatarUrl: null },
  { id: 'a-dev', name: 'Victor', role: 'developer', runtime: 'claude-code', concurrency: 2, paused: false, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 1, avatarUrl: null },
  { id: 'a-dev2', name: 'Dana', role: 'developer', runtime: 'codex', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 1, avatarUrl: null },
  { id: 'a-rev', name: 'Rita', role: 'reviewer', runtime: 'claude-code', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: null, activeRuns: 1, avatarUrl: null }
]

export const epics: Epic[] = [
  {
    id: 'e-design',
    dependsOn: ['e-mobile'],
    blocks: [],
    projectId: 'p-corral',
    title: 'Design tasks',
    description: 'Versioned, sandboxed prototypes the human approves before the build is planned (D20).',
    reviewMode: 'each_task',
    branch: 'corral/epic-e-design-design-tasks',
    prNumber: null,
    prHeadSha: null,
    reviewState: null,
    taskCount: 7,
    mergedCount: 2,
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
    prHeadSha: null,
    reviewState: null,
    taskCount: 3,
    mergedCount: 1,
    createdAt: ago(60 * 24 * 7),
    updatedAt: ago(60 * 24)
  },
  {
    id: 'e-site', projectId: 'p-site', title: 'Website refresh',
    description: 'Refresh the landing page and navigation.', dependsOn: [], blocks: [],
    reviewMode: 'direct', branch: null, prNumber: null, prHeadSha: null, reviewState: null,
    taskCount: 2, mergedCount: 0, createdAt: ago(60 * 24), updatedAt: ago(30)
  },
  {
    id: 'e-shipped', projectId: 'p-site', title: 'Pricing fixes',
    description: 'Completed fixes.', dependsOn: [], blocks: [],
    reviewMode: 'direct', branch: null, prNumber: null, prHeadSha: null, reviewState: null,
    taskCount: 1, mergedCount: 1, createdAt: ago(60 * 24), updatedAt: ago(10)
  },
  {
    id: 'e-empty', projectId: 'p-site', title: 'Future campaigns',
    description: 'Planning only.', dependsOn: [], blocks: [],
    reviewMode: 'direct', branch: null, prNumber: null, prHeadSha: null, reviewState: null,
    taskCount: 0, mergedCount: 0, createdAt: ago(60), updatedAt: ago(5)
  }
]

// A paragraph of task text, as the editor stores it
function doc(...paragraphs: string[]): Task['description'] {
  return { type: 'doc', content: paragraphs.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) }
}

// A task with sensible defaults; give only what the screen needs
export function task(project: Project, number: number, fields: Partial<Task> & Pick<Task, 'title' | 'status'>): Task {
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
    statusReason: null,
    paused: false,
    branch: null,
    prNumber: null,
    prUrl: null,
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
    planSessionId: null,
    planSessionTitle: null,
    createdAt: ago(60 * 24),
    updatedAt: ago(30),
    ...fields
  }
}

function criteria(...texts: string[]): Task['acceptanceCriteria'] {
  return texts.map((text, position) => ({ id: `c-${position + 1}-${text.length}`, position, text, met: null }))
}

const [corral, site] = projects as [Project, Project]

export const tasks: Task[] = [
  task(corral, 1, { title: 'Design task type and versions', status: 'merged', epicId: 'e-design', prNumber: 60, prUrl: 'https://github.com/cormacrw/corral/pull/60', mergedAt: ago(60 * 20), mergeCommitSha: 'da0ebe6' }),
  task(corral, 2, { title: 'Serve design bundles sandboxed', status: 'merged', epicId: 'e-design', dependsOn: ['COR-1'], prNumber: 62, prUrl: 'https://github.com/cormacrw/corral/pull/62', mergedAt: ago(60 * 3), mergeCommitSha: 'e5e8457' }),
  task(corral, 3, {
    title: 'Static prototype build with mock data',
    status: 'in_progress',
    priority: 'high',
    epicId: 'e-design',
    dependsOn: ['COR-2'],
    branch: 'corral/cor-3-static-prototype',
    prNumber: 66,
    prUrl: 'https://github.com/cormacrw/corral/pull/66',
    lease: { agentId: 'a-dev2', runId: 'r-1', role: 'developer', expiresAt: ago(-10) },
    acceptanceCriteria: criteria('`pnpm prototype` outputs index.html with fixture data', 'Works from a sub-path with no API', 'CLAUDE.md documents it')
  }),
  task(corral, 4, {
    title: 'Design review screen',
    status: 'agent_review',
    type: 'design',
    epicId: 'e-design',
    branch: 'design/COR-4',
    prNumber: 63,
    prUrl: 'https://github.com/cormacrw/corral/pull/63',
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
    prNumber: 64,
    prUrl: 'https://github.com/cormacrw/corral/pull/64',
    reviewRounds: 1,
    gateChecks: [{ name: 'lint', url: null }, { name: 'test', url: null }],
    developer: { id: 'a-dev', name: 'Victor' },
    reviewer: { id: 'a-rev', name: 'Rita' },
    headSha: '5b030d7e1c',
    // COR-190: one criterion unmet, so the Inbox shows "4 of 5 met"
    acceptanceCriteria: criteria('Approve marks the version approved', 'Earlier versions are superseded', 'The approval response identifies the version', 'Diagnostic artifacts are retained', 'A toast confirms the approval').map((c, i) => ({ ...c, met: i !== 4 }))
  }),
  // Pinned to v1 of the design after v2 was approved, so it's flagged (D20)
  task(corral, 6, { title: 'Pin build tasks to a design', status: 'ready', epicId: 'e-design', dependsOn: ['COR-5'], design: { taskRef: 'COR-4', version: 1, screens: ['review', 'review-empty'], newerVersion: 2 } }),
  task(corral, 7, { title: 'PM drafts tasks from an approved design', status: 'ready_to_merge', epicId: 'e-design', prNumber: 65, prUrl: 'https://github.com/cormacrw/corral/pull/65' }),
  task(corral, 8, { title: 'Push notifications for Needs you', status: 'blocked', epicId: 'e-mobile', statusReason: 'Which push service should the server use: Web Push with VAPID keys, or ntfy?' }),
  task(corral, 9, { title: 'Offline board', status: 'failed', type: 'bug', priority: 'urgent', epicId: 'e-mobile', failedRuns: 3, statusReason: 'The runner lost its worktree three times in a row.' }),
  task(corral, 10, { title: 'Install sheet on iOS', status: 'merged', epicId: 'e-mobile', mergedAt: ago(60 * 30) }),
  task(corral, 11, { title: 'Dark mode for the epic graph', status: 'backlog', priority: 'low' }),
  task(corral, 12, { title: 'Spike: Codex reasoning effort', status: 'backlog', type: 'spike' }),
  // Drafts from the proposed plans in planSessions s-1 and s-3
  task(corral, 13, { title: 'Design review screen', status: 'draft', type: 'design', priority: 'high', epicId: 'e-design', planSessionId: 's-1', planSessionTitle: 'Design tasks' }),
  task(corral, 14, { title: 'Approve a design version', status: 'draft', priority: 'urgent', epicId: 'e-design', dependsOn: ['COR-13'], planSessionId: 's-1', planSessionTitle: 'Design tasks' }),
  task(corral, 15, { title: 'Pin a design version to a task', status: 'draft', priority: 'low', epicId: 'e-design', dependsOn: ['COR-14'], planSessionId: 's-1', planSessionTitle: 'Design tasks' }),
  task(corral, 16, { title: 'Cards jump when a run starts', status: 'draft', type: 'bug', planSessionId: 's-3', planSessionTitle: 'Board polish' }),
  task(corral, 17, { title: 'Spike: virtualise long columns', status: 'draft', type: 'spike', priority: 'low', planSessionId: 's-3', planSessionTitle: 'Board polish' }),
  // COR-190: the Inbox message panel's states (design, question, activity, resolved)
  task(corral, 18, {
    title: 'Agents page layout',
    status: 'human_review',
    type: 'design',
    humanReview: true,
    branch: 'design/COR-18',
    reviewRounds: 1,
    developer: { id: 'a-dev2', name: 'Dana' },
    reviewer: { id: 'a-rev', name: 'Rita' },
    acceptanceCriteria: criteria('Three layout options on desktop and mobile', 'Every agent state is shown', 'design.md lists the screen ids').map(c => ({ ...c, met: true }))
  }),
  task(corral, 20, {
    title: 'Show approval confirmation', status: 'human_review', humanReview: true,
    branch: 'corral/cor-20-confirmation', prNumber: 66,
    prUrl: 'https://github.com/cormacrw/test-app/pull/66',
    reviewRounds: 1, headSha: '20aabbccdd',
    gateChecks: [{ name: 'lint', url: null }, { name: 'test', url: null }],
    developer: { id: 'a-dev', name: 'Victor' }, reviewer: { id: 'a-rev', name: 'Rita' },
    acceptanceCriteria: criteria('Approval shows a confirmation', 'Earlier versions are superseded', 'The approval response identifies the version', 'Diagnostic artifacts are retained', 'The Inbox advances after approval').map(c => ({ ...c, met: true }))
  }),
  task(corral, 19, { title: 'Retry button on failed runs', status: 'in_progress', branch: 'corral/cor-19-retry', developer: { id: 'a-dev', name: 'Victor' } }),
  task(site, 1, { title: 'New landing page hero', status: 'ready', type: 'design', epicId: 'e-site' }),
  task(site, 2, { title: 'Fix broken pricing link', status: 'merged', type: 'bug', epicId: 'e-shipped', mergedAt: ago(10) }),
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

const at = (ref: string): Task => tasks.find(t => t.ref === ref)!

export const runs: Run[] = [
  {
    runnerId: null, id: 'r-1', number: 128, agentId: 'a-dev2', agentName: 'Dana', role: 'developer', projectId: 'p-corral',
    taskId: at('COR-3').id, taskRef: 'COR-3', taskTitle: at('COR-3').title, state: 'running', outcome: null, summary: null,
    error: null, headSha: null, inputTokens: 18_200, cacheReadTokens: 240_000, outputTokens: 6_100, rateLimitResetAt: null,
    queuedAt: ago(25), startedAt: ago(24), endedAt: null
  },
  {
    runnerId: null, id: 'r-2', number: 129, agentId: 'a-rev', agentName: 'Rita', role: 'reviewer', projectId: 'p-corral',
    taskId: at('COR-4').id, taskRef: 'COR-4', taskTitle: at('COR-4').title, state: 'running', outcome: null, summary: null,
    error: null, headSha: '9e71e28', inputTokens: 9_000, cacheReadTokens: 80_000, outputTokens: 1_200, rateLimitResetAt: null,
    queuedAt: ago(8), startedAt: ago(7), endedAt: null
  },
  {
    runnerId: null, id: 'r-3', number: 127, agentId: 'a-dev', agentName: 'Victor', role: 'developer', projectId: 'p-corral',
    taskId: at('COR-5').id, taskRef: 'COR-5', taskTitle: at('COR-5').title, state: 'completed', outcome: 'pr_opened',
    summary: 'Approving a version marks it approved and supersedes earlier ones.', error: null, headSha: '5b030d7',
    inputTokens: 30_000, cacheReadTokens: 400_000, outputTokens: 9_800, rateLimitResetAt: null,
    queuedAt: ago(140), startedAt: ago(139), endedAt: ago(95)
  },
  {
    runnerId: null, id: 'r-5', number: 126, agentId: 'a-rev', agentName: 'Rita', role: 'reviewer', projectId: 'p-corral',
    taskId: at('COR-5').id, taskRef: 'COR-5', taskTitle: at('COR-5').title, state: 'completed', outcome: 'approved',
    summary: 'Every criterion is met.', error: null, headSha: '5b030d7',
    inputTokens: 12_000, cacheReadTokens: 90_000, outputTokens: 2_000, rateLimitResetAt: null,
    queuedAt: ago(90), startedAt: ago(89), endedAt: ago(80)
  },
  // A live Codex run, which can't take messages mid-run
  {
    runnerId: null, id: 'r-4', number: 130, agentId: 'a-dev', agentName: 'Victor', role: 'developer', projectId: 'p-site',
    taskId: at('WEB-3').id, taskRef: 'WEB-3', taskTitle: at('WEB-3').title, state: 'running', outcome: null, summary: null,
    error: null, headSha: null, inputTokens: 4_000, cacheReadTokens: 22_000, outputTokens: 900, rateLimitResetAt: null,
    queuedAt: ago(5), startedAt: ago(4), endedAt: null
  }
]

// A task's developer and reviewer are the agents of its latest run of each
// role, as the server fills them; tasks with no run keep what they were
// given (the COR-190 review items name theirs), else "Any available"
for (const t of tasks) {
  const latest = (role: 'developer' | 'reviewer') => runs.filter(r => r.taskId === t.id && r.role === role).sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0]
  const developer = latest('developer')
  const reviewer = latest('reviewer')
  t.developer = developer ? { id: developer.agentId, name: developer.agentName } : t.developer
  t.reviewer = reviewer ? { id: reviewer.agentId, name: reviewer.agentName } : t.reviewer
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
  [at('COR-3').id]: [
    { id: 'cm-1', taskId: at('COR-3').id, author: { kind: 'human', userId: 'user-1' }, body: 'Keep the fixtures out of the production bundle.', pinned: true, createdAt: ago(40) },
    { id: 'cm-2', taskId: at('COR-3').id, author: { kind: 'agent', role: 'developer', runId: 'r-1' }, body: 'Done: the fixtures load only when the prototype flag is set.', pinned: false, createdAt: ago(10) }
  ]
}

export const history: Record<string, AuditEntry[]> = {
  [at('COR-3').id]: [
    { id: 1, projectId: 'p-corral', taskId: at('COR-3').id, actor: { kind: 'human', userId: 'user-1' }, action: 'task.created', detail: {}, createdAt: ago(60 * 24) },
    { id: 2, projectId: 'p-corral', taskId: at('COR-3').id, actor: { kind: 'system', component: 'scheduler' }, action: 'task.transition', detail: { from: 'ready', to: 'in_progress' }, createdAt: ago(25) }
  ]
}

// D21: human files, note-only proof, mixed evidence and artifact-only proof.
const reviewTask = at('COR-5')
const criterionId = (position: number) => reviewTask.acceptanceCriteria[position]!.id
const fileEvidence = (id: string, position: number | null, kind: Evidence['kind'], fileName: string, contentType: string, url: string): Evidence => ({
  id, taskId: reviewTask.id, criterionId: position === null ? null : criterionId(position),
  runId: 'r-2', round: 0, kind, note: '', fileName, contentType, size: 128, url, createdAt: ago(20)
})
const requestUrl = 'data:text/plain,' + encodeURIComponent('POST /api/designs/v1/approve\nHTTP/1.1 200 OK\n{"version":1,"state":"approved"}')
const logUrl = 'data:text/plain,' + encodeURIComponent('Approval recorded for version 1. Earlier versions superseded.')
// A self-contained preview image keeps the prototype independent of the API.
const screenshotUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#f8fafc"/><rect x="32" y="32" width="576" height="296" rx="12" fill="white" stroke="#cbd5e1"/><text x="64" y="90" font-family="sans-serif" font-size="24" fill="#0f172a">Design version 1</text><text x="64" y="146" font-family="sans-serif" font-size="20" fill="#15803d">✓ Approved</text><text x="64" y="198" font-family="sans-serif" font-size="16" fill="#475569">The build can now be planned.</text></svg>')
// A mock screenshot: a titled page in a frame, so thumbnails tell apart
function shot(title: string, line: string, accent: string, width = 640, height = 400): string {
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#f1f5f9"/><rect width="${width}" height="44" fill="${accent}"/><circle cx="24" cy="22" r="7" fill="white" opacity=".7"/><rect x="44" y="16" width="120" height="12" rx="6" fill="white" opacity=".7"/><rect x="24" y="68" width="${width - 48}" height="${height - 92}" rx="12" fill="white" stroke="#cbd5e1"/><text x="48" y="116" font-family="sans-serif" font-size="26" fill="#0f172a">${title}</text><text x="48" y="156" font-family="sans-serif" font-size="17" fill="#475569">${line}</text><rect x="48" y="186" width="${width - 160}" height="14" rx="7" fill="#e2e8f0"/><rect x="48" y="214" width="${width - 240}" height="14" rx="7" fill="#e2e8f0"/><rect x="48" y="${height - 76}" width="120" height="32" rx="8" fill="${accent}"/></svg>`)
}
export const evidence: Record<string, Evidence[]> = {
  [reviewTask.id]: [
    fileEvidence('ev-shot', 0, 'screenshot', 'approved-version.svg', 'image/svg+xml', screenshotUrl),
    fileEvidence('ev-shot-2', 1, 'screenshot', 'versions-list.svg', 'image/svg+xml', shot('Versions', 'v2 approved · v1 superseded', '#14b8a6')),
    fileEvidence('ev-shot-3', 2, 'screenshot', 'inbox-after-approve.svg', 'image/svg+xml', shot('Inbox', 'Design approved. Planning the build.', '#6366f1')),
    fileEvidence('ev-log', 0, 'log', 'approval.log', 'text/plain', logUrl),
    { ...fileEvidence('ev-note', 1, 'note', '', '', ''), fileName: null, contentType: null, url: null, size: 0, note: '**Earlier versions are superseded.** The approval transaction updates previous versions atomically. See `approveDesignVersion` in the design service.' },
    fileEvidence('ev-request', 2, 'request', 'approval-response.txt', 'text/plain', requestUrl),
    fileEvidence('ev-output', 3, 'test_output', 'diagnostics.txt', 'text/plain', logUrl),
    fileEvidence('ev-text', null, 'text', 'agent-summary.txt', 'text/plain', logUrl),
    fileEvidence('ev-other', null, 'other', 'debug.json', 'application/json', 'data:application/json,%7B%22version%22%3A1%7D')
  ]
}

const reviewerSummary = [
  'Approved. I checked out `corral/cor-5-approve-design` at 5b030d7e1c, ran the full test suite and walked the approval flow in a dev stack against test-app.',
  '',
  'Approving version 2 marks it approved and supersedes version 1 in one transaction; I confirmed this by approving twice concurrently and reading back the versions table. The approval response carries the version number and status, and the request/response evidence matches what the server returns.',
  '',
  'Diagnostic artifacts (approval.log, diagnostics.txt) are retained under the run. One criterion is not met: no toast confirms the approval. The page re-renders with the new status, so the human does get feedback, and I judged this minor enough not to block; it is flagged for the human to decide.',
  '',
  'Non-blocking notes: `approveDesignVersion` could share the transaction helper used by `rejectDesignVersion`; the empty state copy says "No designs" where the rest of the app says "Nothing here yet". Neither affects behaviour.'
].join('\n')
const designTask = at('COR-18')
export const reviews: Record<string, Review[]> = {
  [reviewTask.id]: [{
    id: 'review-5', taskId: reviewTask.id, runId: 'r-2', round: 1, headSha: '5b030d7e1c',
    verdict: 'approved', summary: reviewerSummary, author: { kind: 'agent', role: 'reviewer', runId: 'r-2' },
    criteria: reviewTask.acceptanceCriteria.map((c, i) => ({ criterionId: c.id, met: i !== 4, note: i === 4 ? 'No toast is shown after approving; the status badge changes in place instead. Minor, left for the human.' : 'Verified the approval flow and its recorded result in a dev stack, approving twice concurrently.' })),
    createdAt: ago(15)
  }, {
    id: 'review-5a', taskId: reviewTask.id, runId: 'r-0', round: 0, headSha: '1a2b3c4d5e',
    verdict: 'changes_requested', summary: 'Earlier versions stay approved after a newer one is approved. Supersede them in the same transaction.', author: { kind: 'agent', role: 'reviewer', runId: 'r-0' },
    criteria: reviewTask.acceptanceCriteria.map((c, i) => ({ criterionId: c.id, met: i !== 1 && i !== 4, note: i === 1 ? 'v1 is still approved after approving v2.' : 'Looks right.' })),
    createdAt: ago(90)
  }],
  [designTask.id]: [{
    id: 'review-18', taskId: designTask.id, runId: 'r-9', round: 0, headSha: '9c8b7a6d5e',
    verdict: 'approved', summary: 'All three options render on desktop and at 390px, every agent state has a fixture, and design.md lists the screen ids with their states. Option B is the strongest on mobile.', author: { kind: 'agent', role: 'reviewer', runId: 'r-9' },
    criteria: designTask.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Checked in the bundle at both widths.' })),
    createdAt: ago(8)
  }]
}
reviewTask.latestReview = reviews[reviewTask.id]![0]!
designTask.latestReview = reviews[designTask.id]![0]!

// Separate all-met code/PR state, alongside COR-5's deliberately unmet criterion.
const allMetTask = at('COR-20')
evidence[allMetTask.id] = evidence[reviewTask.id]!.map(e => ({
  ...e, id: `${e.id}-20`, taskId: allMetTask.id,
  criterionId: e.criterionId ? allMetTask.acceptanceCriteria[reviewTask.acceptanceCriteria.findIndex(c => c.id === e.criterionId)]!.id : null
}))
reviews[allMetTask.id] = reviews[reviewTask.id]!.map((r, i) => ({
  ...r, id: `${r.id}-20`, taskId: allMetTask.id, headSha: allMetTask.headSha!,
  summary: i === 0 ? reviewerSummary.replace('One criterion is not met: no toast confirms the approval. The page re-renders with the new status, so the human does get feedback, and I judged this minor enough not to block; it is flagged for the human to decide.', 'All five criteria are met. The confirmation appears and the Inbox advances to the next item.') : r.summary,
  criteria: allMetTask.acceptanceCriteria.map(c => ({ criterionId: c.id, met: i === 0, note: 'Checked the confirmation and next-item flow in the static prototype.' }))
}))
allMetTask.latestReview = reviews[allMetTask.id]![0]!

// A code review's PR description and diff (COR-190's proposed endpoint),
// for the PR description and Code diff tabs
const approvePatch = [
  '@@ -41,12 +41,24 @@ export async function approveDesignVersion(db: Db, taskId: string, version: number) {',
  '-  const row = await db.update(designVersions)',
  '-    .set({ status: \'approved\' })',
  '-    .where(and(eq(designVersions.taskId, taskId), eq(designVersions.version, version)))',
  '-    .returning()',
  '-  return row[0]',
  '+  return db.transaction(async (tx) => {',
  '+    // Earlier versions are superseded in the same transaction (D20)',
  '+    await tx.update(designVersions)',
  '+      .set({ status: \'superseded\' })',
  '+      .where(and(eq(designVersions.taskId, taskId), lt(designVersions.version, version)))',
  '+    const [row] = await tx.update(designVersions)',
  '+      .set({ status: \'approved\', approvedAt: new Date() })',
  '+      .where(and(eq(designVersions.taskId, taskId), eq(designVersions.version, version)))',
  '+      .returning()',
  '+    if (!row) throw new NotFoundError(`Design version ${version}`)',
  '+    return row',
  '+  })',
  ' }'
].join('\n')
const routePatch = [
  '@@ -88,6 +88,11 @@ app.post(\'/projects/:slug/tasks/:number/designs/:version/approve\', async (c) => {',
  '   const task = await taskBySlug(c)',
  '-  await approveDesignVersion(db, task.id, Number(c.req.param(\'version\')))',
  '-  return c.json(task)',
  '+  const approved = await approveDesignVersion(db, task.id, Number(c.req.param(\'version\')))',
  '+  await audit(db, task, \'design.approved\', { version: approved.version })',
  '+  // The response identifies the version that was approved',
  '+  return c.json({ ...task, approvedVersion: approved.version })',
  ' })'
].join('\n')
const testPatch = [
  '@@ -0,0 +1,14 @@',
  '+import { describe, expect, it } from \'vitest\'',
  '+import { approveDesignVersion } from \'./designs\'',
  '+',
  '+describe(\'approveDesignVersion\', () => {',
  '+  it(\'supersedes earlier versions in the same transaction\', async () => {',
  '+    const db = await testDb()',
  '+    await seedVersions(db, \'t-1\', [1, 2])',
  '+    await approveDesignVersion(db, \'t-1\', 2)',
  '+    expect(await statuses(db, \'t-1\')).toEqual({ 1: \'superseded\', 2: \'approved\' })',
  '+  })',
  '+})'
].join('\n')
function prDetail(t: Task, body: string): PullRequestDetail {
  return {
    number: t.prNumber!, url: t.prUrl!, title: t.title, body, headBranch: t.branch!,
    // In an `epic` or `each_task` epic, a task PR's base is the epic branch (D23)
    baseBranch: epics.find(e => e.id === t.epicId)?.branch ?? 'main',
    files: [
      { path: 'apps/server/src/designs.ts', status: 'modified', additions: 12, deletions: 5, patch: approvePatch },
      { path: 'apps/server/src/routes/designs.ts', status: 'modified', additions: 4, deletions: 2, patch: routePatch },
      { path: 'apps/server/src/designs.test.ts', status: 'added', additions: 11, deletions: 0, patch: testPatch }
    ]
  }
}
export const pullRequestDetails: Record<string, PullRequestDetail> = {
  [reviewTask.id]: prDetail(reviewTask, [
    '## What',
    '',
    'Approving a design version now supersedes earlier versions in the same transaction, and the response says which version was approved.',
    '',
    '## Why',
    '',
    'COR-5: before this, approving v2 left v1 approved too, so build tasks could pin either.',
    '',
    '## How it was checked',
    '',
    '- New `designs.test.ts` covers supersede-on-approve',
    '- Walked the flow in a dev stack against test-app, approving twice concurrently',
    '',
    'Not done: a toast after approving (criterion 5). The status changes in place.'
  ].join('\n')),
  [allMetTask.id]: prDetail(allMetTask, [
    '## What',
    '',
    'Approving shows a confirmation toast and the Inbox moves on to the next item.',
    '',
    '## How it was checked',
    '',
    '- Unit tests for the approval transaction',
    '- Checked the toast and next-item flow in the static prototype'
  ].join('\n'))
}

// ── COR-190: epic review (D23) ──────────────────────────────────────────────
// Worked examples of an epic PR's life in the Inbox. Needs you: a first
// review in `epic` mode, a first review in `each_task` mode, and a second round
// after the human asked for changes. Also a fix task waiting on the human, and
// Activity and Resolved entries for the other moments.
function epicRow(id: string, project: Project, title: string, description: string, reviewMode: Epic['reviewMode'], prNumber: number, reviewState: Epic['reviewState'], taskCount: number, mergedCount: number): Epic {
  const slug = title.toLowerCase().replaceAll(' ', '-')
  return {
    id, projectId: project.id, title, description, dependsOn: [], blocks: [], reviewMode,
    branch: `corral/epic-${id}-${slug}`, prNumber, prHeadSha: `${prNumber}a7f3c21`, reviewState, taskCount, mergedCount,
    createdAt: ago(60 * 24 * 3), updatedAt: ago(10)
  }
}
epics.push(
  epicRow('e-searches', corral, 'Saved searches', 'Save a board filter and get back to it in one click.', 'epic', 71, 'human_review', 3, 3),
  epicRow('e-newsletter', site, 'Newsletter signup', 'Let visitors subscribe from the landing page and the footer.', 'each_task', 31, 'human_review', 4, 4),
  epicRow('e-exports', corral, 'Run history export', 'Download a project\'s run history as CSV.', 'epic', 75, 'human_review', 3, 3),
  epicRow('e-notify', corral, 'Notification settings', 'Choose which Inbox events send a push.', 'each_task', 78, 'changes_requested', 3, 2),
  epicRow('e-audit', corral, 'Audit log export', 'Export the audit log for a date range.', 'epic', 79, 'in_review', 2, 2),
  epicRow('e-shortcuts', corral, 'Keyboard shortcuts', 'Move around the board and the Inbox from the keyboard.', 'epic', 73, 'changes_requested', 3, 2),
  epicRow('e-themes', corral, 'Project themes', 'Give each project its own accent colour.', 'epic', 70, 'merged', 2, 2),
  // Approved: D23's "ready to merge", which EPIC_REVIEW_STATES lacks (design.md)
  epicRow('e-thumbs', corral, 'Project thumbnails', 'Show a thumbnail for every project.', 'epic', 72, 'human_review', 2, 2)
)

function epicTask(project: Project, number: number, epicId: string, title: string, prNumber: number, fields: Partial<Task> = {}, criteriaCount = 3): Task {
  const repo = project.repository
  return task(project, number, {
    title, status: 'merged', epicId, prNumber, prUrl: `https://github.com/${repo}/pull/${prNumber}`,
    branch: `corral/${project.prefix.toLowerCase()}-${number}`, mergedAt: ago(60 * 5), mergeCommitSha: `${number}e0c4a`,
    developer: { id: 'a-dev', name: 'Victor' }, reviewer: { id: 'a-rev', name: 'Rita' },
    acceptanceCriteria: Array.from({ length: criteriaCount }, (_, position) => ({ id: `c-${project.prefix}-${number}-${position}`, position, text: `${title}: criterion ${position + 1}`, met: true })),
    ...fields
  })
}
const fixTaskCriteria = [
  { id: 'c-52-0', position: 0, text: 'Turning off every event asks for confirmation', met: true },
  { id: 'c-52-1', position: 1, text: 'The settings page explains that a muted event still reaches the Inbox', met: true }
]
tasks.push(
  epicTask(corral, 41, 'e-searches', 'Saved search API', 67),
  epicTask(corral, 42, 'e-searches', 'Save and reopen a search on the board', 68, { humanReview: true }, 4),
  epicTask(corral, 43, 'e-searches', 'Document saved searches', 69, {}, 2),
  epicTask(site, 11, 'e-newsletter', 'Subscribe form component', 24, { humanReview: true }),
  epicTask(site, 12, 'e-newsletter', 'Double opt-in email', 25, { humanReview: true }),
  epicTask(site, 13, 'e-newsletter', 'Add the form to the landing page', 26, { humanReview: true }, 2),
  epicTask(site, 14, 'e-newsletter', 'Add the form to the footer', 27, { humanReview: true }, 2),
  epicTask(corral, 46, 'e-exports', 'Export endpoint streams CSV', 74),
  epicTask(corral, 47, 'e-exports', 'Export button on the Runs page', 76, { humanReview: true }),
  epicTask(corral, 48, 'e-exports', 'Fix: put times in the project\'s time zone', 77, {}, 2),
  epicTask(corral, 50, 'e-notify', 'Notification preferences API', 80, { humanReview: true }),
  epicTask(corral, 51, 'e-notify', 'Notification settings page', 81, { humanReview: true }, 4),
  epicTask(corral, 52, 'e-notify', 'Fix: confirm before muting everything', 82, {
    status: 'human_review', humanReview: true, reviewRounds: 0, mergedAt: null, mergeCommitSha: null, headSha: '52c0ffee11',
    gateChecks: [{ name: 'lint', url: null }, { name: 'test', url: null }], acceptanceCriteria: fixTaskCriteria, updatedAt: ago(6)
  }),
  epicTask(corral, 54, 'e-audit', 'Audit export query', 83),
  epicTask(corral, 55, 'e-audit', 'Audit export page', 84),
  epicTask(corral, 56, 'e-shortcuts', 'Shortcut registry', 85),
  epicTask(corral, 57, 'e-shortcuts', 'Board and Inbox shortcuts', 86),
  epicTask(corral, 58, 'e-shortcuts', 'Resolve the epic PR conflict', 0, { status: 'ready', prNumber: null, prUrl: null, mergedAt: null, mergeCommitSha: null, reviewer: null, developer: null, branch: 'corral/epic-e-shortcuts-keyboard-shortcuts' }, 1),
  epicTask(corral, 59, 'e-themes', 'Theme colour setting', 87),
  epicTask(corral, 60, 'e-themes', 'Apply the theme across the app', 88),
  epicTask(corral, 61, 'e-thumbs', 'Thumbnail upload', 89),
  epicTask(corral, 62, 'e-thumbs', 'Show thumbnails in lists', 90)
)
const epicTaskKinds: Record<string, 'fix' | 'conflict'> = { 'COR-48': 'fix', 'COR-52': 'fix', 'COR-58': 'conflict' }

const taskEvidence = (ref: string, fileName: string, title: string, line: string, accent: string): Evidence => ({
  id: `ev-${ref}-${fileName}`, taskId: at(ref).id, criterionId: null, runId: 'r-2', round: 0, kind: 'screenshot', note: '',
  fileName, contentType: 'image/svg+xml', size: 128, url: shot(title, line, accent), createdAt: ago(60 * 6)
})
Object.assign(evidence, {
  [at('COR-42').id]: [
    taskEvidence('COR-42', 'save-search.svg', 'Save this search', 'Name it, then find it under Saved', '#14b8a6'),
    taskEvidence('COR-42', 'saved-list.svg', 'Saved searches', 'Open, rename or delete', '#6366f1')
  ],
  [at('WEB-13').id]: [taskEvidence('WEB-13', 'landing-form.svg', 'Stay in the loop', 'The form on the landing page', '#f59e0b')],
  [at('WEB-14').id]: [taskEvidence('WEB-14', 'footer-form.svg', 'Footer signup', 'At every width', '#0ea5e9')],
  [at('WEB-12').id]: [taskEvidence('WEB-12', 'confirm-email.svg', 'Confirm your email', 'The double opt-in message', '#ec4899')],
  [at('COR-47').id]: [taskEvidence('COR-47', 'export-button.svg', 'Export CSV', 'On the Runs page', '#6366f1')],
  [at('COR-48').id]: [taskEvidence('COR-48', 'export-times.svg', 'Times match the Runs page', '2026-10-29 14:02 Europe/Dublin', '#14b8a6')],
  [at('COR-51').id]: [taskEvidence('COR-51', 'settings-page.svg', 'Notifications', 'Pick the events that push', '#6366f1')],
  [at('COR-52').id]: [taskEvidence('COR-52', 'mute-confirm.svg', 'Mute everything?', 'You will only see items in the Inbox', '#ef4444')]
})
const fixReview: Review = {
  id: 'review-52', taskId: at('COR-52').id, runId: 'r-2', round: 0, headSha: '52c0ffee11', verdict: 'approved',
  summary: 'Muting the last event now asks for confirmation, and the page says muted events still reach the Inbox. Both criteria are met.',
  criteria: fixTaskCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Checked on the settings page.' })),
  author: { kind: 'agent', role: 'reviewer', runId: 'r-2' }, createdAt: ago(7)
}
reviews[at('COR-52').id] = [fixReview]
at('COR-52').latestReview = fixReview

function changedFile(path: string, status: PullRequestDetail['files'][number]['status'], lines: string[]): PullRequestDetail['files'][number] {
  const additions = lines.filter(l => l.startsWith('+')).length
  const deletions = lines.filter(l => l.startsWith('-')).length
  return { path, status, additions, deletions, patch: [`@@ -12,${deletions + 2} +12,${additions + 2} @@`, ...lines].join('\n') }
}
pullRequestDetails[at('COR-52').id] = {
  ...prDetail(at('COR-52'), '## What\n\nMuting the last event asks for confirmation.\n\n## Why\n\nFrom your review of epic PR #78.'),
  files: [changedFile('apps/web/app/pages/settings/notifications.vue', 'modified', [
    ' function toggle(event: string) {',
    '+  if (enabled.value.length === 1 && enabled.value[0] === event) return confirmMuteAll()',
    '   enabled.value = enabled.value.includes(event) ? without(enabled.value, event) : [...enabled.value, event]',
    ' }'
  ])]
}

function epicPr(epicId: string, body: string, files: PullRequestDetail['files']): PullRequestDetail {
  const epic = epics.find(e => e.id === epicId)!
  const project = projects.find(p => p.id === epic.projectId)!
  return {
    number: epic.prNumber!, url: `https://github.com/${project.repository}/pull/${epic.prNumber}`, title: epic.title, body,
    baseBranch: project.defaultBranch, headBranch: epic.branch!, files
  }
}
const lintTest = [{ name: 'lint', url: null }, { name: 'test', url: null }]
const round = (id: string, number: number, summary: string, findings: EpicReview['rounds'][number]['findings'], minutes: number, verdict: Review['verdict'] = 'approved'): EpicReview['rounds'][number] => ({
  id: `${id}-${number}`, round: number, verdict, reviewer: 'Rita', headSha: `${id.length}f4e2a1b9c`, summary, findings, createdAt: ago(minutes)
})
const exportFix = changedFile('apps/server/src/exports/runs-csv.ts', 'modified', [
  ' export function formatRow(run: Run, project: Project) {',
  '-  return [run.number, run.state, run.startedAt.toISOString()]',
  '+  return [run.number, run.state, formatInTimeZone(run.startedAt, project.timeZone)]',
  ' }'
])
const quietReview = (epicId: string, state: EpicReview['state'], fields: Partial<Omit<EpicReview, 'tasks'>> = {}): Omit<EpicReview, 'tasks'> => {
  const epic = epics.find(e => e.id === epicId)!
  return {
    epicId, title: epic.title, goal: epic.description, reviewMode: epic.reviewMode, state, targetBranch: 'main', gateChecks: lintTest, targetMovedBy: 0,
    pr: epicPr(epicId, `## What\n\n${epic.description}`, [changedFile('apps/web/app/pages/index.vue', 'modified', [' <template>', '+  <EpicFeature />', ' </template>'])]),
    rounds: [], lastFeedback: null, conflictTaskRef: null, mergeCommitSha: null, ...fields
  }
}
export const epicReviews: Record<string, Omit<EpicReview, 'tasks'>> = {
  'e-searches': quietReview('e-searches', 'human_review', {
    targetMovedBy: 6,
    pr: epicPr('e-searches', [
      '## What', '', 'Save a board filter and get back to it in one click.', '', '## Tasks', '',
      '- COR-41 Saved search API (#67)', '- COR-42 Save and reopen a search on the board (#68)', '- COR-43 Document saved searches (#69)'
    ].join('\n'), [
      changedFile('apps/server/src/saved-searches.ts', 'added', ['+export async function saveSearch(db: Db, projectId: string, input: SavedSearchInput) {', '+  return db.insert(savedSearches).values({ projectId, ...input }).returning()', '+}']),
      changedFile('apps/server/src/routes/saved-searches.ts', 'added', ['+app.get(\'/projects/:slug/saved-searches\', listSavedSearches)', '+app.post(\'/projects/:slug/saved-searches\', createSavedSearch)']),
      changedFile('apps/web/app/components/SavedSearchMenu.vue', 'added', ['+<template>', '+  <UDropdownMenu :items="searches" />', '+</template>']),
      changedFile('apps/web/app/pages/projects/[slug]/board.vue', 'modified', [' <BoardFilters v-model="filters">', '+  <SavedSearchMenu :filters="filters" />', ' </BoardFilters>']),
      changedFile('packages/db/migrations/0031_saved_searches.sql', 'added', ['+CREATE TABLE saved_searches (id uuid PRIMARY KEY, project_id uuid NOT NULL, name text NOT NULL);']),
      changedFile('docs/design/board.md', 'modified', ['+## Saved searches', '+', '+Save a filter from the board\'s filter bar.'])
    ]),
    rounds: [round('e-searches', 0, [
      'Approved. The three tasks work as one feature: a search saved on the board goes through the API, survives a reload and reopens with the same filters. I reviewed the combined diff against the epic\'s goal, not each task\'s evidence again.',
      '', 'One thing to look at: the API allows two searches with the same name, and the menu then shows both with nothing to tell them apart. Not blocking.'
    ].join('\n'), [
      { level: 'pass', text: 'Saving, reloading and reopening work end to end', taskRefs: ['COR-41', 'COR-42'] },
      { level: 'pass', text: 'The docs match what shipped', taskRefs: ['COR-43'] },
      { level: 'note', text: 'Two searches can share a name, and the menu can\'t tell them apart', taskRefs: ['COR-41', 'COR-42'] }
    ], 3)]
  }),
  'e-newsletter': quietReview('e-newsletter', 'human_review', {
    pr: epicPr('e-newsletter', '## What\n\nVisitors can subscribe from the landing page and the footer, with double opt-in.', [
      changedFile('src/components/SubscribeForm.astro', 'added', ['+<form method="post" action="/api/subscribe">', '+  <input type="email" name="email" required />', '+</form>']),
      changedFile('src/pages/api/subscribe.ts', 'added', ['+export const POST = async ({ request }) => sendConfirmation(await request.formData())']),
      changedFile('src/components/Footer.astro', 'modified', [' <footer>', '+  <SubscribeForm compact />', ' </footer>'])
    ]),
    rounds: [round('e-newsletter', 0, 'Approved. You reviewed all four tasks, so I only checked them together: the landing page form and the footer form use the same component and post to the same endpoint, and the confirmation email reaches both flows.', [
      { level: 'pass', text: 'Both forms share one component and one endpoint', taskRefs: ['WEB-11', 'WEB-13', 'WEB-14'] },
      { level: 'pass', text: 'The confirmation email arrives from either form', taskRefs: ['WEB-12'] }
    ], 4)]
  }),
  'e-exports': quietReview('e-exports', 'human_review', {
    targetMovedBy: 2,
    pr: epicPr('e-exports', '## What\n\nDownload a project\'s run history as CSV from the Runs page.', [
      exportFix,
      changedFile('apps/server/src/routes/exports.ts', 'added', ['+app.get(\'/projects/:slug/runs.csv\', streamRunsCsv)']),
      changedFile('apps/web/app/pages/agents/index.vue', 'modified', [' <RunsHeader>', '+  <ExportButton />', ' </RunsHeader>'])
    ]),
    lastFeedback: { text: 'The CSV times are in UTC, but the Runs page shows the project\'s time zone. Make them match.', at: ago(60 * 3), fixTaskRefs: ['COR-48'], files: [exportFix] },
    rounds: [
      round('e-exports', 1, 'Approved. COR-48 puts the CSV times in the project\'s time zone, and a row now matches the Runs page. Nothing else on the epic branch moved since your last review.', [
        { level: 'pass', text: 'CSV times match the Runs page', taskRefs: ['COR-48'] }
      ], 5),
      round('e-exports', 0, 'Approved. The export streams, so a long history doesn\'t time out, and the button matches the filters on the page.', [
        { level: 'pass', text: 'The button exports the filtered runs', taskRefs: ['COR-46', 'COR-47'] }
      ], 60 * 5)
    ]
  }),
  'e-notify': quietReview('e-notify', 'changes_requested', { lastFeedback: { text: 'Muting every event should ask first.', at: ago(60), fixTaskRefs: ['COR-52'], files: [] } }),
  'e-audit': quietReview('e-audit', 'in_review'),
  'e-shortcuts': quietReview('e-shortcuts', 'changes_requested', { conflictTaskRef: 'COR-58', targetMovedBy: 9 }),
  'e-themes': quietReview('e-themes', 'merged', { mergeCommitSha: 'c0a1d3e', rounds: [round('e-themes', 0, 'Approved. The theme applies everywhere it should.', [{ level: 'pass', text: 'The accent colour reaches every page', taskRefs: ['COR-60'] }], 90)] }),
  'e-thumbs': quietReview('e-thumbs', 'ready_to_merge', { targetMovedBy: 3, rounds: [round('e-thumbs', 0, 'Approved. Uploads show up in every list.', [{ level: 'pass', text: 'Uploaded thumbnails reach every list', taskRefs: ['COR-62'] }], 70)] })
}
export function epicReview(id: string): EpicReview | null {
  const review = epicReviews[id]
  if (!review) return null
  return {
    ...review,
    tasks: tasks.filter(t => t.epicId === id && t.status !== 'draft').map(t => ({
      ref: t.ref, title: t.title, prNumber: t.prNumber, prUrl: t.prUrl, kind: epicTaskKinds[t.ref] ?? 'task', merged: t.status === 'merged',
      reviewedBy: t.humanReview ? 'human' : 'reviewer',
      criteriaMet: t.acceptanceCriteria.filter(c => c.met).length, criteriaTotal: t.acceptanceCriteria.length,
      evidence: evidence[t.id] ?? []
    }))
  }
}
// When each epic started waiting on the human, in minutes
const epicWaiting: Record<string, number> = { 'e-searches': 2, 'e-newsletter': 3, 'e-exports': 5 }
const epicBodies: Record<string, string> = {
  'e-searches': 'Saved searches is ready for you as a whole: all 3 tasks merged into the epic branch, and they work together. One thing to look at: two searches can share a name.\n\nYou\'ve seen COR-42. COR-41 and COR-43 merged on my approval.',
  'e-newsletter': 'Newsletter signup is ready to go out. You reviewed all 4 tasks, and they work together: both forms share one component and the confirmation email arrives from either.',
  'e-exports': 'Back for round 2: COR-48 fixes the time zone you flagged, and nothing else moved. The CSV times now match the Runs page.',
  'e-audit': 'All 2 tasks merged, so Corral opened epic PR #79. Rita is running the integration review. It comes to you if she approves.',
  'e-shortcuts': 'Rebasing onto main hit a conflict in apps/web/app/layouts/default.vue, so epic PR #73 is on hold. COR-58 is in Ready to resolve it. It comes back through integration review and then to you.',
  'e-themes': 'Project themes is on main as one squash commit, c0a1d3e. The epic branch is deleted, and anything waiting on this epic has started.',
  'e-thumbs': 'You approved Project thumbnails. Main has moved 3 commits, so Corral rebases first, CI runs again, then it merges.'
}
function epicItem(epicId: string, id: string, event: EpicInboxItem['event'], sender: string, role: EpicInboxItem['sender']['role'], subject: string, body: string, minutes: number): EpicInboxItem {
  const epic = epics.find(e => e.id === epicId)!
  const project = projects.find(p => p.id === epic.projectId)!
  return {
    id, type: 'epic_review', event, epicId, taskId: null, taskRef: null, subject, preview: body, body,
    project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
    sender: { name: sender, role }, at: ago(minutes), prUrl: epicReviews[epicId]!.pr.url, resolution: null
  }
}
// What the human did to an epic PR this session, by epic
export const epicResolutions: Record<string, string> = {}

// A design task's submitted versions (D20); the preview itself is served by the server
export const designs: Record<string, DesignVersion[]> = {
  [designTask.id]: [{
    id: 'dv-18-1', version: 1, status: 'submitted', branch: 'design/COR-18', commitSha: '9c8b7a6d5e',
    spec: '# Agents page layout\n\nThree options: `agents-grid`, `agents-list`, `agents-board`.',
    screenshots: [
      { fileName: 'agents-grid-desktop.png', url: shot('Option A · Grid', 'Agents as cards, two per row', '#0ea5e9') },
      { fileName: 'agents-list-desktop.png', url: shot('Option B · List', 'One row per agent, runs inline', '#8b5cf6') },
      { fileName: 'agents-board-desktop.png', url: shot('Option C · Board', 'Columns by role', '#f59e0b') },
      { fileName: 'agents-list-mobile.png', url: shot('Option B', 'Phone', '#8b5cf6', 260, 460) }
    ],
    previewUrl: '/api/designs/dv-18-1/preview/index.html',
    feedback: null, planSessionId: null, createdAt: ago(10)
  }]
}
for (const [taskId, versions] of Object.entries(designs)) {
  const t = tasks.find(x => x.id === taskId)!
  evidence[taskId] = versions.at(-1)!.screenshots.map((s, i) => ({
    id: `ev-dv-${i}`, taskId, criterionId: t.acceptanceCriteria[0]!.id, runId: 'r-9', round: 0, kind: 'screenshot', note: '',
    fileName: s.fileName, contentType: 'image/svg+xml', size: 128, url: s.url, createdAt: ago(10)
  }))
}

// Open PRs and their merge gates (GET /projects/:slug/pull-requests), one
// for each state the Pull requests page shows
function pullRequest(ref: string, fields: Partial<PullRequestStatus> & Pick<PullRequestStatus, 'merge'>): PullRequestStatus {
  const t = at(ref)
  const project = projects.find(p => p.id === t.projectId)!
  return {
    taskRef: t.ref,
    taskTitle: t.title,
    taskStatus: t.status,
    pr: { number: t.prNumber!, url: t.prUrl!, state: 'open', headSha: '5b030d7e1c' },
    review: { verdict: 'approved', headSha: '5b030d7e1c', forHeadCommit: true, createdAt: ago(40) },
    ci: { status: 'passing', checks: project.requiredChecks.map(name => ({ name, conclusion: 'success', url: null })) },
    branch: { name: t.branch, mergeable: true, mergeableState: 'clean', upToDate: true, rebase: 'not_needed' },
    evidenceComplete: true,
    humanReviewOutstanding: false,
    ...fields
  }
}
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

// What each item's agent wrote (COR-190): a long, realistic body for the
// items whose panel is being designed. Others fall back to statusReason.
const inboxBodies: Record<string, string> = {
  'COR-52': 'Fix for your feedback on epic PR #78: muting the last event now asks first, and the page says muted events still reach the Inbox.',
  'COR-20': 'All five criteria are met. Review the approval confirmation and merge PR #66.\n\n' + reviews[allMetTask.id]![0]!.summary,
  'COR-5': 'Rita approved round 2 of this change. Approving a design version now marks it approved and supersedes the earlier versions in the same transaction, and the approval response identifies the version.\n\n' + reviewerSummary,
  'COR-18': 'Dana submitted version 1 of the Agents page design: three layout options (grid, list and board) on desktop and mobile, each with every agent state. Rita approved it. Approve the version to plan its build, or request changes.',
  'COR-19': 'Should **Retry** reuse the failed run\'s worktree, or start from a fresh checkout?\n\nReusing it keeps the agent\'s partial work and is faster, but a corrupted worktree (the usual cause of COR-9) would fail again. A fresh checkout is slower by about 40s on this repo.\n\nI\'d start fresh by default and reuse only when the failure was a timeout. Which do you want?',
  'COR-8': 'Which push service should the server use: Web Push with VAPID keys, or ntfy?\n\nI can\'t continue the notification work without this: the server stores subscriptions differently for each.',
  'COR-9': [
    'The runner lost its worktree three times in a row, so Corral stopped retrying this task.',
    '',
    '## What happened',
    '',
    'Run 1 (Victor, 2h ago) started normally, installed dependencies and began editing `apps/web/app/composables/useOffline.ts`. After 11 minutes the runner logged `ENOENT: no such file or directory, scandir \'/data/runner/worktrees/9f1c…\'` and the run ended with exit code 1. Run 2 (Victor, 1h ago) got as far as the first test run before the same error. Run 3 (Dana, 25m ago) failed during `pnpm install`.',
    '',
    '## Likely cause',
    '',
    'All three runs overlapped with the nightly `git worktree prune` job on the home server. That job removes worktrees whose `.git` file points at a missing directory, and the runner creates the directory a moment after registering the worktree. This looks like a race between the two rather than anything in the task itself.',
    '',
    '## Logs',
    '',
    '```',
    '[runner] claim COR-9 run 3 lease 10m',
    '[runner] git worktree add /data/runner/worktrees/9f1c… corral/cor-9-offline-board',
    '[runner] pnpm install --frozen-lockfile',
    '[prune] removing worktrees/9f1c… (gitdir missing)',
    '[runner] ENOENT: no such file or directory, scandir',
    '[runner] run 3 failed (exit 1); failedRuns 3 of 3',
    '```',
    '',
    '## Options',
    '',
    '- **Retry** once the prune job is moved or disabled; nothing in the branch needs to change.',
    '- **Send back** to the Backlog if offline support should wait.',
    '- **Delete** the task if it is no longer wanted.'
  ].join('\n')
}

// Questions the human has answered in this session (mock-api's inbox actions)
export const answered = new Set<string>()

// A task item of any type, for the Activity and Resolved tabs and questions
function taskItem(ref: string, type: TaskInboxItem['type'], sender: string, role: 'developer' | 'reviewer', subject: string, minutes: number, id?: string): TaskInboxItem {
  const t = at(ref)
  const project = projects.find(p => p.id === t.projectId)!
  const body = inboxBodies[ref] ?? `${subject}.`
  return {
    id: id ?? t.id, type, taskId: t.id, taskRef: t.ref, subject, preview: body, body,
    project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
    sender: { name: sender, role }, at: ago(minutes), prUrl: t.prUrl, resolution: null
  }
}

// The inbox is derived from the tasks above that need the human
export function inbox(): Inbox {
  const needsYou: InboxItem[] = tasks
    .filter(t => t.status === 'human_review' || t.status === 'blocked' || t.status === 'failed')
    .map((t) => {
      const project = projects.find(p => p.id === t.projectId)!
      const type = t.status === 'human_review' ? 'human_review' as const : t.status === 'blocked' ? 'blocked' as const : 'failed' as const
      const subject = type === 'human_review' ? `Review ${t.title}` : t.title
      const body = inboxBodies[t.ref] ?? t.statusReason ?? 'The reviewer approved this change and it needs your review.'
      return {
        id: t.id,
        type,
        project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
        taskId: t.id,
        taskRef: t.ref,
        subject,
        preview: body,
        body,
        sender: type === 'failed' ? { name: 'Corral', role: 'system' as const } : { name: type === 'blocked' ? 'Victor' : 'Rita', role: type === 'blocked' ? 'developer' as const : 'reviewer' as const },
        at: t.updatedAt,
        prUrl: t.prUrl,
        resolution: null
      }
    })
  // Threads waiting on the human: a question, a plan needing approval or an unread reply
  for (const session of planSessions.filter(s => !s.closed && (s.status !== 'none' || s.unread))) {
    const project = projects.find(p => p.id === session.projectId)!
    const messages = planMessages[session.id] ?? []
    const last = messages.at(-1)
    const plan = plans[session.id]?.find(p => p.status === 'proposed')
    const reply = session.status === 'none' ? messages.findLast(m => m.role === 'pm') : undefined
    if (session.status === 'none' && !reply) continue
    needsYou.push({
      id: session.id, type: 'plan_thread', sessionId: session.id,
      project: { id: project.id, slug: project.slug, name: project.name, thumbnailColor: project.thumbnailColor, thumbnailUrl: project.thumbnailUrl },
      subject: session.title, preview: session.preview ?? '',
      question: session.status === 'question' && last ? { text: last.text, recommendation: last.recommendation, options: last.options } : null,
      reply: reply?.text ?? null,
      plan: plan ? { id: plan.id, version: plan.version, title: plan.title, summary: plan.summary, epicCount: plan.epics.length, taskCount: plan.tasks.filter(t => t.change !== 'removed').length } : null,
      // When it started waiting: the question, the plan or the reply
      sender: { name: 'Juno', role: 'pm' }, at: (session.status === 'needs_approval' ? plan?.createdAt : session.status === 'question' ? last?.createdAt : reply?.createdAt) ?? session.updatedAt,
      taskId: null, taskRef: null, prUrl: null, resolution: null,
      runtime: session.runtime, status: session.status, unread: session.unread,
      activeRunId: session.activeRunId,
      planId: plan?.id ?? null
    })
  }
  if (!answered.has('COR-19')) needsYou.push(taskItem('COR-19', 'question', 'Victor', 'developer', 'Should Retry reuse the failed run\'s worktree?', 4))
  for (const [id, review] of Object.entries(epicReviews)) {
    if (review.state === 'human_review') needsYou.push(epicItem(id, id, 'human_review', 'Rita', 'reviewer', `Review the ${review.title} epic`, epicBodies[id]!, epicWaiting[id]!))
  }
  needsYou.sort((a, b) => b.at.localeCompare(a.at))
  const activity = [
    epicItem('e-audit', 'audit-e-audit', 'opened', 'Corral', 'system', 'Epic PR opened: Audit log export', epicBodies['e-audit']!, 12),
    epicItem('e-shortcuts', 'audit-e-shortcuts', 'conflict', 'Corral', 'system', 'Epic PR conflict: Keyboard shortcuts', epicBodies['e-shortcuts']!, 25),
    epicItem('e-themes', 'audit-e-themes', 'merged', 'Corral', 'system', 'Epic PR merged: Project themes', epicBodies['e-themes']!, 38),
    taskItem('COR-7', 'activity', 'Rita', 'reviewer', 'PM drafts tasks from an approved design: approved, waiting to merge', 40, 'audit-7')
  ]
  // Epics acted on this session join the earlier ones
  const acted = Object.entries(epicResolutions).map(([id, resolution]) => ({
    ...epicItem(id, `resolved-${id}`, 'human_review', 'Rita', 'reviewer', `Review the ${epicReviews[id]!.title} epic`, epicBodies[id]!, 0), resolution
  }))
  const resolved = [
    ...acted,
    { ...epicItem('e-thumbs', 'audit-e-thumbs', 'approved', 'Rita', 'reviewer', 'Review the Project thumbnails epic', epicBodies['e-thumbs']!, 55), resolution: 'You approved it. Waiting for CI, after rebasing onto main.' },
    { ...taskItem('COR-10', 'human_review', 'Rita', 'reviewer', 'Review Install sheet on iOS', 60 * 30, 'audit-10'), resolution: 'You approved and merged it' }
  ]
  return { needsYou, activity, resolved, count: needsYou.length }
}
