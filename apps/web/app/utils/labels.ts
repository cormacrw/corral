import { TONE_TEXT } from '~/lib/tone'
import type { Tone } from '~/lib/tone'
import { deliveryCounts, DONE_STATUS, isActiveRun, AGENT_RUNTIME_IDS, AGENT_RUNTIMES, parseTaskRef, REVIEW_MODE_CHOICES, ROLE_LABELS, TASK_STATUS_LABELS } from '@corral/core'
import { cacheWritesUnknown, EPIC_PR_ACTIVITY, weightedRunCost } from '@corral/contracts/client'
import type { Agent, AuditEntry, CliStatus, Epic, EpicFixRun, EpicPrEvent, RunnerInfo, RunnerRole, RunnerStatus, InboxItem, Project, Run, Task } from '@corral/contracts'
import type { AgentRuntime, CliId, MergeMethod, PlanStatus, RunSessionStart, DesignVersionStatus, EpicFixKind, EpicReviewMode, EpicReviewState, RunOutcome, RunState, TaskPriority, TaskStatus } from '@corral/core'
import { epicPath, taskPath } from './routes'
import { inboxBadge } from './inbox-kinds'

export type Color = Tone

// Status colours from design/README.md (D10). Always shown with the label.
const STATUS_COLOR: Record<TaskStatus, Color> = {
  draft: 'neutral',
  backlog: 'neutral',
  ready: 'info',
  in_progress: 'primary',
  agent_review: 'primary',
  human_review: 'warning',
  ready_to_merge: 'success',
  approved: 'success',
  merged: 'success',
  blocked: 'error',
  failed: 'error',
  parent: 'neutral'
}
export const STATUS = Object.fromEntries((Object.keys(STATUS_COLOR) as TaskStatus[]).map(status => [status, { label: TASK_STATUS_LABELS[status], color: STATUS_COLOR[status] }])) as Record<TaskStatus, { label: string, color: Color }>

// Tasks counted by status label, in STATUS order, so merged tasks and approved
// designs share one Complete count.
export function statusCounts(tasks: Pick<Task, 'status'>[]): { status: TaskStatus, label: string, count: number }[] {
  const counts = new Map<string, { status: TaskStatus, label: string, count: number }>()
  for (const status of Object.keys(STATUS) as TaskStatus[]) {
    const count = tasks.filter(t => t.status === status).length
    if (count === 0) continue
    const { label } = STATUS[status]
    const seen = counts.get(label)
    if (seen) seen.count += count
    else counts.set(label, { status, label, count })
  }
  return [...counts.values()]
}

// A design version's state (D20)
export const DESIGN_VERSION_STATUS: Record<DesignVersionStatus, { label: string, color: Color }> = {
  submitted: { label: 'Submitted', color: 'warning' },
  changes_requested: { label: 'Changes requested', color: 'neutral' },
  approved: { label: 'Approved', color: 'success' },
  superseded: { label: 'Superseded', color: 'neutral' }
}

// A plan version's state (D9)
export const PLAN_STATUS: Record<PlanStatus, { label: string, color: Color }> = {
  proposed: { label: 'Waiting for approval', color: 'primary' },
  approved: { label: 'Approved', color: 'success' },
  superseded: { label: 'Superseded', color: 'neutral' },
  discarded: { label: 'Discarded', color: 'neutral' }
}

// An epic's review mode (D27). `each_task` is retired and only names merged history.
export const EPIC_REVIEW_MODE: Record<EpicReviewMode, { label: string, description: string }> = {
  epic: { label: 'The task\'s PR', description: 'Subtasks integrate into the task\'s branch on agent approval; you review them all, with any human checks, on the task\'s PR' },
  each_task: { label: 'Each subtask (retired)', description: 'You reviewed every subtask, then the task\'s PR' },
  direct: { label: 'Direct', description: 'Each subtask merges straight into the target branch' }
}

// The review modes on offer, with their labels
export const REVIEW_MODE_OPTIONS = REVIEW_MODE_CHOICES.map(value => ({ value, ...EPIC_REVIEW_MODE[value] }))

export const MERGE_METHOD: Record<MergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Merge commit',
  rebase: 'Rebase and merge'
}

// Where an epic PR is in its review (D27)
export const EPIC_REVIEW_STATE: Record<EpicReviewState, { label: string, color: Color }> = {
  open: { label: 'Open', color: 'neutral' },
  in_review: { label: 'Agent review', color: 'info' },
  human_review: { label: 'Awaiting your review', color: 'warning' },
  changes_requested: { label: 'Changes requested', color: 'warning' },
  ready_to_merge: { label: 'Ready to merge', color: 'success' },
  merged: { label: 'Merged', color: 'success' }
}

// Everything listEpicHistory returns: the audit rows whose detail has the epicId.
export function epicHistoryText(entry: Pick<AuditEntry, 'action' | 'detail'>): string {
  const d = entry.detail
  switch (entry.action) {
    case 'task.created': return 'created the task'
    case 'task.promoted': return 'added the first subtask to this task'
    case 'epic.updated': return `edited ${(d.changed as string[] | undefined)?.join(', ') ?? 'the task'}`
    case 'merge.refused': return `reported GitHub refused the merge: ${String(d.message)}`
    case 'epic.pr': return [EPIC_PR_ACTIVITY[d.event as EpicPrEvent] ?? 'updated the task\'s PR', d.summary].filter(Boolean).join(': ')
    default: return 'updated the task'
  }
}

// The counts an epic should show, from live tasks: the server only sends an
// epic again when the epic itself changes
export function epicWithLiveCounts<E extends Epic>(epic: E, tasks: Pick<Task, 'epicId' | 'status' | 'type'>[]): E {
  return { ...epic, ...deliveryCounts(tasks.filter(t => t.epicId === epic.id)) }
}

// A developer run on an epic, with no task (D29)
export const EPIC_CONFLICT_PENDING = 'Rebase conflict waits until the task\'s PR is about to land'

export const EPIC_FIX: Record<EpicFixKind, { active: string, past: string }> = {
  conflict: { active: 'Resolving a rebase conflict', past: 'Rebase conflict' },
  ci: { active: 'Fixing a CI failure', past: 'CI failure' },
  review: { active: 'Addressing integration review', past: 'Integration review changes' }
}

export const epicStoppedLabel = (fix: EpicFixKind | null | undefined) => fix === 'ci' || fix === 'review' ? 'Fix stopped' : 'Rebase stopped'

// What the developer reported, and whether review followed
export function epicFixResult(run: Pick<EpicFixRun, 'behaviourChanged' | 'reReviewed'>): string[] {
  return [
    run.behaviourChanged === null ? 'Not reported' : run.behaviourChanged ? 'Behaviour changed' : 'Behaviour unchanged',
    ...run.reReviewed === null ? [] : [run.reReviewed ? 'Reviewed again' : 'Kept approval']
  ]
}

// What the epic's review is waiting on, for its progress; null while its
// tasks are still going in and in `direct` mode, which has no epic PR
export function epicReviewStatus(epic: Pick<Epic, 'reviewMode' | 'branch' | 'reviewState' | 'taskCount' | 'mergedCount'> & Partial<Pick<Epic, 'sync'>>): { label: string, color: Color } | null {
  if (epic.reviewMode === 'direct') return null
  if (epic.sync?.state === 'rebasing') return { label: 'Rebasing onto the target branch', color: 'info' }
  if (epic.sync?.state === 'deciding') return { label: 'Rebase needs your decision', color: 'warning' }
  if (epic.sync?.state === 'fixing') return { label: EPIC_FIX[epic.sync.fix].active, color: 'info' }
  if (epic.sync?.state === 'failed') return { label: `${epicStoppedLabel(epic.sync.fix)}, retry to carry on`, color: 'error' }
  const allMerged = epic.taskCount > 0 && epic.mergedCount === epic.taskCount
  switch (epic.reviewState) {
    case null: return allMerged && epic.branch ? { label: 'All subtasks complete, the task\'s PR opening', color: 'neutral' } : null
    case 'open': return allMerged ? { label: 'All tasks complete, waiting for agent review', color: 'neutral' } : { label: 'Task\'s PR open, subtasks still to merge', color: 'neutral' }
    case 'in_review': return { label: 'All tasks complete, agent reviewing', color: 'info' }
    case 'human_review': return { label: 'All tasks complete, awaiting your review', color: 'warning' }
    case 'changes_requested': return { label: 'Changes requested, fixes in progress', color: 'warning' }
    case 'ready_to_merge': return { label: 'Approved, waiting to merge', color: 'success' }
    case 'merged': return { label: 'Task\'s PR merged', color: 'success' }
  }
}

export const PRIORITY: Record<TaskPriority, { label: string, color: Color }> = {
  urgent: { label: 'Urgent', color: 'error' },
  high: { label: 'High', color: 'warning' },
  medium: { label: 'Medium', color: 'neutral' },
  low: { label: 'Low', color: 'neutral' }
}

// Runtime names in the UI. Never "Claude Code" (agent-runtime-and-auth.md, branding).
const CLI_NAMES: Record<CliId, string> = { claude: 'Claude', codex: 'Codex' }
export const RUNTIME = Object.fromEntries(AGENT_RUNTIME_IDS.map(runtime => [runtime, CLI_NAMES[AGENT_RUNTIMES[runtime]]])) as Record<AgentRuntime, string>
export function runtimeLabel(runtime: string): string {
  return RUNTIME[runtime as AgentRuntime] ?? runtime
}
// Runners (design/settings.md, Runner): a runner turned away for an old
// protocol needs updating; otherwise it's online or offline
const RUNNER_ROLE: Record<RunnerRole, string> = { ...ROLE_LABELS, design: 'Design' }
export function runnerRoles(roles: RunnerRole[]): string {
  return roles.map(r => RUNNER_ROLE[r]).join(', ')
}
export function runnerState(runner: Pick<RunnerInfo, 'online' | 'needsUpdate'>): { label: string, color: Color } {
  if (runner.needsUpdate) return { label: 'Needs update', color: 'warning' }
  return runner.online ? { label: 'Online', color: 'success' } : { label: 'Offline', color: 'error' }
}
// The shell's one-line summary: "home-server", "2 of 3 online", or why none is
export function runnerSummary(status: RunnerStatus | null): string {
  const runners = status?.runners ?? []
  const online = runners.filter(r => r.online)
  if (!runners.length) return 'not connected'
  if (runners.length === 1) return runners[0]!.needsUpdate ? `${runners[0]!.name} needs an update` : runners[0]!.name
  return `${online.length} of ${runners.length} online`
}

// The runtimes whose CLI the runner found installed, for the runtime menu (D18)
export function detectedRuntimes(clis: Pick<CliStatus, 'id' | 'version'>[]): AgentRuntime[] {
  return (Object.keys(AGENT_RUNTIMES) as AgentRuntime[]).filter(r => clis.some(c => c.id === AGENT_RUNTIMES[r] && c.version))
}

// An item's badge: a stopped task-with-subtasks shares the conflict's type,
// not its meaning
export function inboxItemBadge(item: Pick<InboxItem, 'type'> & { stopped?: unknown }): { label: string, color: Color } {
  return item.stopped ? { label: 'Task stopped', color: 'error' } : inboxBadge(item)
}

export const TASK_TYPE: Record<Task['type'], string> = {
  task: 'Task', bug: 'Bug', spike: 'Spike', design: 'Design'
}
// The badge on Board and Backlog cards (D19, D20). Plain tasks get none.
export function taskTypeBadge(type: Task['type']): { label: string, color: Color, icon: string } | null {
  if (type === 'bug') return { label: TASK_TYPE.bug, color: 'error', icon: 'i-hugeicons-bug-01' }
  if (type === 'spike') return { label: TASK_TYPE.spike, color: 'info', icon: 'i-hugeicons-test-tube' }
  if (type === 'design') return { label: TASK_TYPE.design, color: 'info', icon: 'i-hugeicons-paint-board' }
  return null
}
// The muted icon on a Board card, which leaves colour to the priority. Plain tasks get none.
export function cardTypeIcon(type: Task['type']): { name: string, label: string } | null {
  if (type === 'bug') return { name: 'i-hugeicons-bug-01', label: TASK_TYPE.bug }
  if (type === 'design') return { name: 'i-hugeicons-paint-brush-02', label: TASK_TYPE.design }
  if (type === 'spike') return { name: 'i-hugeicons-test-tube', label: TASK_TYPE.spike }
  return null
}
// Every type's icon, plain tasks included, for rows that show it on its own
export function taskTypeIcon(type: Task['type']): string {
  return taskTypeBadge(type)?.icon ?? 'i-hugeicons-checkmark-square-02'
}

// design/agent.md: what a run was for. Only a task or an epic's integration
// review has a title of its own, and only a PM run is a turn.
export function runRef(run: Pick<Run, 'taskRef' | 'epicId'>): string {
  return run.taskRef ?? (run.epicId ? 'Task' : 'Plan')
}

export function runTitle(run: Pick<Run, 'taskTitle' | 'epicTitle' | 'summary' | 'role'>): string {
  return run.taskTitle ?? run.epicTitle ?? run.summary ?? (run.role === 'pm' ? 'PM turn' : 'Run')
}

// design/agent.md outcome badges
export function runBadge(run: Pick<Run, 'state' | 'outcome' | 'role'>): { label: string, color: Color } {
  if (isActiveRun(run.state)) return { label: 'Live', color: 'primary' }
  const outcome = run.outcome as RunOutcome | null
  switch (outcome) {
    case 'pr_opened': return { label: 'PR opened', color: 'primary' }
    case 'pr_rebased': return { label: 'PR rebased', color: 'primary' }
    case 'pr_updated': return { label: 'PR updated', color: 'primary' }
    case 'commit_submitted': return { label: 'Commit submitted', color: 'primary' }
    case 'findings_reported': return { label: 'Findings reported', color: 'primary' }
    case 'design_submitted': return { label: 'Design submitted', color: 'primary' }
    case 'approved': return { label: 'Approved', color: 'success' }
    case 'changes_requested': return { label: 'Changes requested', color: 'warning' }
    case 'blocked': return { label: 'Blocked', color: 'error' }
    case 'stuck': return { label: 'Stuck', color: 'error' }
    case 'failed': return { label: 'Failed', color: 'error' }
    case 'rate_limited': return { label: 'Rate limited', color: 'neutral' }
    default: break
  }
  const state = run.state as RunState
  if (state === 'interrupted') return { label: 'Interrupted', color: 'neutral' }
  if (state === 'failed') return { label: 'Failed', color: 'error' }
  return { label: run.role === 'pm' ? 'Answered' : 'Completed', color: 'success' }
}

// The dot beside a status, spelled out so Tailwind sees every class
export const STATUS_DOT: Record<Color, string> = { neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-destructive', success: 'bg-success' }

// Where an Inbox item's task lives: an epic's activity is about the epic, and
// its taskRef is only one of the epic's tasks
export function inboxItemLink(item: { taskRef: string | null, epicId?: string | null }) {
  if (item.epicId) return { to: epicPath(item.epicId), label: 'Task' }
  return item.taskRef ? { to: taskPath(item.taskRef), label: 'Task' } : null
}

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')
}

const palette = ['#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#ca8a04', '#64748b']
export const THUMBNAIL_COLORS = palette

export function projectColor(project: Pick<Project, 'thumbnailColor' | 'name'>): string {
  if (project.thumbnailColor) return project.thumbnailColor
  let hash = 0
  for (const char of project.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]!
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export function duration(startIso: string | null, endIso: string | null, now = Date.now()): string {
  if (!startIso) return '—'
  const ms = (endIso ? new Date(endIso).getTime() : now) - new Date(startIso).getTime()
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// A measured duration, from milliseconds up to days
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  if (seconds < 86_400) return `${Number((ms / 3_600_000).toFixed(1))}h`
  return `${Number((ms / 86_400_000).toFixed(1))}d`
}

// startedAt is recorded after worktree/session preparation and the API has no
// assignment timestamp, so every queue-to-start figure is labelled this way.
export const QUEUE_WAIT_LABEL = 'Queue wait (queued to started, including preparation)'

export function tokens(n: number | null): string {
  if (n === null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export const RUN_SESSION_LABELS: Record<RunSessionStart, string> = { fresh: 'Fresh', resumed_warm: 'Resumed warm', resumed_cold: 'Resumed cold' }

export function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`
}

// Cache traffic is shown apart: it costs differently from fresh input
export function runTokens(run: Pick<Run, 'agentRuntime' | 'inputTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'outputTokens' | 'sessionStart'>): string {
  const parts = [`${tokens(run.inputTokens ?? 0)} in${cacheWritesUnknown(run) ? ' (includes cache writes)' : ''}`]
  if (run.cacheWriteTokens !== null && run.cacheWriteTokens !== undefined) parts.push(`${tokens(run.cacheWriteTokens)} cache write`)
  if (run.cacheReadTokens !== null) parts.push(`${tokens(run.cacheReadTokens)} cache read`)
  parts.push(`${tokens(run.outputTokens ?? 0)} out`)
  const cost = weightedRunCost(run)
  if (cost !== null) parts.push(`${dollars(cost)} weighted, excluding input`)
  if (run.sessionStart) parts.push(RUN_SESSION_LABELS[run.sessionStart].toLowerCase())
  return parts.join(' · ')
}

// Working comes from the lease, not the status (D10)
export function isWorking(agent: Agent): boolean {
  return agent.activeRuns > 0
}

// Explicit pause takes precedence over a usage cooldown
export function waitingOnUsageLimit(agent: Pick<Agent, 'paused' | 'pausedUntil'>, now = Date.now()): boolean {
  return !agent.paused && !!agent.pausedUntil && new Date(agent.pausedUntil).getTime() > now
}

// Idle has no marker. Most layouts already indicate work, so Working is only
// marked on request.
export function agentStatus(agent: Pick<Agent, 'paused' | 'pausedUntil' | 'activeRuns'>, now = Date.now(), showWorking = false): { label: string, color: Color } | null {
  if (agent.paused) return { label: 'Paused', color: 'neutral' }
  if (waitingOnUsageLimit(agent, now)) return { label: 'Waiting on usage limit', color: 'neutral' }
  if (showWorking && agent.activeRuns > 0) return { label: 'Working', color: 'success' }
  return null
}

// An epic's name for display; numbered when it isn't loaded yet
export function epicTitle(epics: { id: string, title: string }[] | undefined, id: string, fallbackIndex: number): string {
  return epics?.find(e => e.id === id)?.title ?? `Task ${fallbackIndex + 1}`
}

// Sidebar counts: the Board counts open work only, so merged tasks drop out
const DONE_STATUSES: readonly Task['status'][] = Object.values(DONE_STATUS)
export function taskCounts(tasks: Pick<Task, 'status'>[]): { board: number, backlog: number } {
  return {
    board: tasks.filter(t => t.status !== 'backlog' && !DONE_STATUSES.includes(t.status)).length,
    backlog: tasks.filter(t => t.status === 'backlog').length
  }
}

// The number in a task ref: COR-123 is 123
export const taskNumber = (ref: string) => parseTaskRef(ref)?.number ?? Number.NaN

export const priorityText = (task: Pick<Task, 'priority'>) => TONE_TEXT[PRIORITY[task.priority].color]
