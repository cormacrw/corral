import { isTaskDone } from '@corral/core'
import { AGENT_RUNTIMES, type Agent, type AgentRuntime, type CliStatus, type Epic, type RunnerInfo, type RunnerRole, type RunnerStatus, type InboxItem, type PlanStatus, type Project, type Run, type Task } from '@corral/contracts'
import type { AgentRole, DesignVersionStatus, EpicReviewMode, EpicReviewState, RunOutcome, RunState, TaskPriority, TaskStatus } from '@corral/core'

export type Color = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

// Status colours from design/README.md (D10). Always shown with the label.
export const STATUS: Record<TaskStatus, { label: string, color: Color }> = {
  draft: { label: 'Draft', color: 'neutral' },
  backlog: { label: 'Backlog', color: 'neutral' },
  ready: { label: 'Ready', color: 'info' },
  in_progress: { label: 'In progress', color: 'primary' },
  agent_review: { label: 'Agent review', color: 'primary' },
  human_review: { label: 'Human review', color: 'warning' },
  ready_to_merge: { label: 'Ready to merge', color: 'success' },
  approved: { label: 'Complete', color: 'success' },
  merged: { label: 'Complete', color: 'success' },
  blocked: { label: 'Blocked', color: 'error' },
  failed: { label: 'Failed', color: 'error' }
}

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

// An epic's review mode (D27)
export const EPIC_REVIEW_MODE: Record<EpicReviewMode, { label: string, description: string }> = {
  epic: { label: 'Epic PR', description: 'Tasks integrate into an epic branch on agent approval; you review them all, with any human checks, on the epic PR' },
  each_task: { label: 'Each task', description: 'You review every task, then the epic PR' },
  direct: { label: 'Direct', description: 'Each task merges straight into the target branch' }
}

// Where an epic PR is in its review (D27)
export const EPIC_REVIEW_STATE: Record<EpicReviewState, { label: string, color: Color }> = {
  open: { label: 'Open', color: 'neutral' },
  in_review: { label: 'Agent review', color: 'info' },
  human_review: { label: 'Awaiting your review', color: 'warning' },
  changes_requested: { label: 'Changes requested', color: 'warning' },
  ready_to_merge: { label: 'Ready to merge', color: 'success' },
  conflict: { label: 'Rebase conflict', color: 'error' },
  merged: { label: 'Merged', color: 'success' }
}

export const EPIC_STATUS_TEXT: Record<Color, string> = {
  primary: 'text-primary', secondary: 'text-secondary', neutral: 'text-muted', info: 'text-info', warning: 'text-warning', success: 'text-success', error: 'text-error'
}

// The counts an epic should show, from live tasks: the server only sends an
// epic again when the epic itself changes
export function epicWithLiveCounts<E extends Epic>(epic: E, tasks: Pick<Task, 'epicId' | 'status' | 'type'>[]): E {
  const counted = tasks.filter(t => t.epicId === epic.id && t.status !== 'draft' && t.status !== 'backlog')
  return { ...epic, taskCount: counted.length, mergedCount: counted.filter(isTaskDone).length }
}

// An epic with work left: unmerged tasks, or an epic PR still to merge (D22, D27)
export function epicInProgress(epic: Pick<Epic, 'reviewMode' | 'branch' | 'reviewState' | 'taskCount' | 'mergedCount'>): boolean {
  if (epic.taskCount === 0) return false
  return epic.mergedCount < epic.taskCount || (epic.reviewMode !== 'direct' && epic.branch !== null && epic.reviewState !== 'merged')
}

// What the epic's review is waiting on, for its progress; null while its
// tasks are still going in and in `direct` mode, which has no epic PR
export function epicReviewStatus(epic: Pick<Epic, 'reviewMode' | 'branch' | 'reviewState' | 'taskCount' | 'mergedCount'>): { label: string, color: Color } | null {
  if (epic.reviewMode === 'direct') return null
  const allMerged = epic.taskCount > 0 && epic.mergedCount === epic.taskCount
  switch (epic.reviewState) {
    case null: return allMerged && epic.branch ? { label: 'All tasks complete, epic PR opening', color: 'neutral' } : null
    case 'open': return allMerged ? { label: 'All tasks complete, waiting for agent review', color: 'neutral' } : { label: 'Epic PR open, tasks still to merge', color: 'neutral' }
    case 'in_review': return { label: 'All tasks complete, agent reviewing', color: 'info' }
    case 'human_review': return { label: 'All tasks complete, awaiting your review', color: 'warning' }
    case 'changes_requested': return { label: 'Changes requested, fixes in progress', color: 'warning' }
    case 'ready_to_merge': return { label: 'Approved, waiting to merge', color: 'success' }
    case 'conflict': return { label: 'Rebase conflict, needs you', color: 'error' }
    case 'merged': return { label: 'Epic PR merged', color: 'success' }
  }
}

export const PRIORITY: Record<TaskPriority, { label: string, color: Color }> = {
  urgent: { label: 'Urgent', color: 'error' },
  high: { label: 'High', color: 'warning' },
  medium: { label: 'Medium', color: 'neutral' },
  low: { label: 'Low', color: 'neutral' }
}

export const ROLE: Record<AgentRole, string> = { pm: 'PM', developer: 'Developer', designer: 'Designer', reviewer: 'Reviewer' }

// Runtime names in the UI. Never "Claude Code" (agent-runtime-and-auth.md, branding).
export const RUNTIME: Record<AgentRuntime, string> = { 'claude-code': 'Claude', 'codex': 'Codex' }
export function runtimeLabel(runtime: string): string {
  return RUNTIME[runtime as AgentRuntime] ?? runtime
}
// Runners (design/settings.md, Runner): a runner turned away for an old
// protocol needs updating; otherwise it's online or offline
const RUNNER_ROLE: Record<RunnerRole, string> = { ...ROLE, design: 'Design' }
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
// How to sign a CLI in inside the runner container (D12, D18)
export function cliLoginCommand(id: CliStatus['id']): string {
  return `docker exec -it corral-runner ${id === 'codex' ? 'codex login --device-auth' : 'claude'}`
}

// design/inbox.md item type badges
export function inboxTypeBadge(type: InboxItem['type']): { label: string, color: Color } {
  return ({
    release_notes: { label: 'Release notes', color: 'neutral' as const },
    epic_activity: { label: 'Epic PR', color: 'neutral' as const },
    epic_review: { label: 'Epic PR', color: 'warning' as const },
    epic_conflict: { label: 'Epic conflict', color: 'error' as const },
    human_review: { label: 'Human review', color: 'warning' as const },
    question: { label: 'Question', color: 'info' as const },
    blocked: { label: 'Blocked', color: 'error' as const },
    failed: { label: 'Failed', color: 'error' as const },
    activity: { label: 'Activity', color: 'neutral' as const },
    plan_thread: { label: 'Plan', color: 'primary' as const }
  })[type]
}

export const TASK_TYPE: Record<Task['type'], string> = {
  task: 'Task', bug: 'Bug', spike: 'Spike', design: 'Design'
}
// The badge on Board and Backlog cards (D19, D20). Plain tasks get none.
export function taskTypeBadge(type: Task['type']): { label: string, color: Color, icon: string } | null {
  if (type === 'bug') return { label: TASK_TYPE.bug, color: 'error', icon: 'i-lucide-bug' }
  if (type === 'spike') return { label: TASK_TYPE.spike, color: 'info', icon: 'i-lucide-flask-conical' }
  if (type === 'design') return { label: TASK_TYPE.design, color: 'secondary', icon: 'i-lucide-palette' }
  return null
}
// Every type's icon, plain tasks included, for rows that show it on its own
export function taskTypeIcon(type: Task['type']): string {
  return taskTypeBadge(type)?.icon ?? 'i-lucide-square-check'
}

// A run that hasn't finished yet
const LIVE_RUN_STATES: readonly string[] = ['queued', 'starting', 'running', 'waiting_for_input', 'stopping']
export function isLiveRun(run: Pick<Run, 'state'>): boolean {
  return LIVE_RUN_STATES.includes(run.state)
}

// design/agent.md: what a run was for. Only a task or an epic's integration
// review has a title of its own, and only a PM run is a turn.
export function runRef(run: Pick<Run, 'taskRef' | 'epicId'>): string {
  return run.taskRef ?? (run.epicId ? 'Epic' : 'Plan')
}

export function runTitle(run: Pick<Run, 'taskTitle' | 'epicTitle' | 'summary' | 'role'>): string {
  return run.taskTitle ?? run.epicTitle ?? run.summary ?? (run.role === 'pm' ? 'PM turn' : 'Run')
}

// design/agent.md outcome badges
export function runBadge(run: Pick<Run, 'state' | 'outcome' | 'role'>): { label: string, color: Color } {
  if (isLiveRun(run)) return { label: 'Live', color: 'primary' }
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

// Cache reads are shown apart: they cost far less than fresh input
export function runTokens(run: Pick<Run, 'inputTokens' | 'cacheReadTokens' | 'outputTokens'>): string {
  const parts = [`${tokens(run.inputTokens ?? 0)} in`]
  if (run.cacheReadTokens !== null) parts.push(`${tokens(run.cacheReadTokens)} cache read`)
  parts.push(`${tokens(run.outputTokens ?? 0)} out`)
  return parts.join(' · ')
}

// Working comes from the lease, not the status (D10)
export function isWorking(agent: Agent): boolean {
  return agent.activeRuns > 0
}

// Idle has no marker. Explicit pause takes precedence over a usage cooldown.
// Layouts that already indicate work can request exception markers only.
export function agentStatus(agent: Pick<Agent, 'paused' | 'pausedUntil' | 'activeRuns'>, now = Date.now(), showWorking = true): { label: string, color: Color } | null {
  if (agent.paused) return { label: 'Paused', color: 'neutral' }
  if (agent.pausedUntil && new Date(agent.pausedUntil).getTime() > now) return { label: 'Waiting on usage limit', color: 'neutral' }
  if (showWorking && agent.activeRuns > 0) return { label: 'Working', color: 'success' }
  return null
}

// The note under a board card (design/board.md)
// An epic's name for display; numbered when it isn't loaded yet
export function epicTitle(epics: { id: string, title: string }[] | undefined, id: string, fallbackIndex: number): string {
  return epics?.find(e => e.id === id)?.title ?? `Epic ${fallbackIndex + 1}`
}

export function taskNote(task: Task, all: Task[], reviewRoundCap: number): { text: string, color: Color } | null {
  // Takes the note's place: nothing else about the task moves until it's resumed
  if (task.paused) return { text: 'Paused', color: 'warning' }
  if (task.status === 'ready' && task.waitingOnEpics.length > 0) return { text: `Waiting on epic: ${task.waitingOnEpics.map(e => e.title).join(', ')}`, color: 'neutral' }
  if (task.status === 'ready' && task.dependsOn.length > 0) {
    const waiting = task.dependsOn.filter(ref => !all.some(t => t.ref === ref && isTaskDone(t)))
    if (waiting.length > 0) return { text: `Waiting on ${waiting.join(', ')}`, color: 'neutral' }
  }
  if (task.status === 'blocked' || task.status === 'failed') return { text: task.statusReason, color: 'error' }
  if (task.status === 'human_review') return { text: 'Waiting for you', color: 'warning' }
  if (task.status === 'ready_to_merge') return { text: 'Merges when checks pass', color: 'neutral' }
  if (task.reviewRounds > 0 && (task.status === 'in_progress' || task.status === 'agent_review')) {
    return { text: `Review round ${task.reviewRounds} of ${reviewRoundCap}`, color: 'neutral' }
  }
  return null
}

// Sidebar counts: the Board counts open work only, so merged tasks drop out
export function taskCounts(tasks: Pick<Task, 'status'>[]): { board: number, backlog: number } {
  return {
    board: tasks.filter(t => t.status !== 'backlog' && t.status !== 'merged' && t.status !== 'approved').length,
    backlog: tasks.filter(t => t.status === 'backlog').length
  }
}
