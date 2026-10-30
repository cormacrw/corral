import { AGENT_RUNTIMES, type Agent, type AgentRuntime, type CliStatus, type EpicReview, type InboxItem, type PlanStatus, type Project, type Run, type Task } from '@corral/contracts'
import type { AgentRole, DesignVersionStatus, EpicReviewMode, RunOutcome, RunState, TaskPriority, TaskStatus } from '@corral/core'

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
  merged: { label: 'Merged', color: 'success' },
  blocked: { label: 'Blocked', color: 'error' },
  failed: { label: 'Failed', color: 'error' }
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

// An epic's review mode (D23)
export const EPIC_REVIEW_MODE: Record<EpicReviewMode, { label: string, description: string }> = {
  epic: { label: 'Epic PR', description: 'Tasks merge into an epic branch on approval; you review the epic PR' },
  each_task: { label: 'Each task', description: 'You review every task, then the epic PR' },
  direct: { label: 'Direct', description: 'Each task merges straight into the target branch' }
}

export const PRIORITY: Record<TaskPriority, { label: string, color: Color }> = {
  urgent: { label: 'Urgent', color: 'error' },
  high: { label: 'High', color: 'warning' },
  medium: { label: 'Medium', color: 'neutral' },
  low: { label: 'Low', color: 'neutral' }
}

export const ROLE: Record<AgentRole, string> = { pm: 'PM', developer: 'Developer', reviewer: 'Reviewer' }

// Runtime names in the UI. Never "Claude Code" (agent-runtime-and-auth.md, branding).
export const RUNTIME: Record<AgentRuntime, string> = { 'claude-code': 'Claude', 'codex': 'Codex' }
export function runtimeLabel(runtime: string): string {
  return RUNTIME[runtime as AgentRuntime] ?? runtime
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
    human_review: { label: 'Human review', color: 'warning' as const },
    question: { label: 'Question', color: 'info' as const },
    blocked: { label: 'Blocked', color: 'error' as const },
    failed: { label: 'Failed', color: 'error' as const },
    activity: { label: 'Activity', color: 'neutral' as const },
    plan_thread: { label: 'Plan', color: 'primary' as const },
    epic_review: { label: 'Epic review', color: 'warning' as const }
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

// design/agent.md outcome badges
export function runBadge(run: Pick<Run, 'state' | 'outcome' | 'role'>): { label: string, color: Color } {
  if (isLiveRun(run)) return { label: 'Live', color: 'primary' }
  const outcome = run.outcome as RunOutcome | null
  switch (outcome) {
    case 'pr_opened': return { label: 'PR opened', color: 'primary' }
    case 'pr_updated': return { label: 'PR updated', color: 'primary' }
    case 'findings_reported': return { label: 'Findings reported', color: 'primary' }
    case 'design_submitted': return { label: 'Design submitted', color: 'primary' }
    case 'approved': return { label: 'Approved', color: 'success' }
    case 'changes_requested': return { label: 'Changes requested', color: 'warning' }
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
// Where an epic PR stands, in plain words (D23)
export const EPIC_PR_STATE: Record<EpicReview['state'], string> = {
  open: 'Opened',
  in_review: 'In integration review',
  human_review: 'Waiting on you',
  changes_requested: 'Waiting on a fix task',
  ready_to_merge: 'Approved, merging after CI',
  merged: 'Merged'
}

// An epic's name for display; numbered when it isn't loaded yet
export function epicTitle(epics: { id: string, title: string }[] | undefined, id: string, fallbackIndex: number): string {
  return epics?.find(e => e.id === id)?.title ?? `Epic ${fallbackIndex + 1}`
}

export function taskNote(task: Task, all: Task[], reviewRoundCap: number): { text: string, color: Color } | null {
  if (task.status === 'ready' && task.waitingOnEpics.length > 0) return { text: `Waiting on epic: ${task.waitingOnEpics.map(e => e.title).join(', ')}`, color: 'neutral' }
  if (task.status === 'ready' && task.dependsOn.length > 0) {
    const waiting = task.dependsOn.filter(ref => all.find(t => t.ref === ref)?.status !== 'merged')
    if (waiting.length > 0) return { text: `Waiting on ${waiting.join(', ')}`, color: 'neutral' }
  }
  if (task.status === 'blocked' || task.status === 'failed') return { text: task.statusReason ?? STATUS[task.status].label, color: 'error' }
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
    board: tasks.filter(t => t.status !== 'backlog' && t.status !== 'merged').length,
    backlog: tasks.filter(t => t.status === 'backlog').length
  }
}
