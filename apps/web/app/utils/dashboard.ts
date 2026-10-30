import type { Run, Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import { runTitle } from './labels.ts'

// The Home dashboard's numbers (design/mobile.md), all counted from the live
// task lists so they match the Board's columns for the same project.

// In progress is every approved, unmerged status an agent or the human is
// moving (D10). Blocked and failed are counted separately.
export const IN_PROGRESS_STAGES = ['in_progress', 'agent_review', 'human_review', 'ready_to_merge'] as const satisfies readonly TaskStatus[]
export type InProgressStage = typeof IN_PROGRESS_STAGES[number]

export interface DashboardCounts {
  // Ready, not started: the Board's Ready column
  todo: number
  inProgress: number
  stages: Record<InProgressStage, number>
  // The Board's Blocked & failed column
  blocked: number
  // Human review
  waitingForReview: number
  mergedToday: number
  // Merged today without the reviewer asking for changes
  firstPassToday: number
}

// Whether an ISO time falls on the same local calendar day as `now`
export function isToday(iso: string | null, now = new Date()): boolean {
  if (!iso) return false
  const at = new Date(iso)
  return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
}

export function dashboardCounts(tasks: Pick<Task, 'status' | 'mergedAt' | 'reviewRounds'>[], now = new Date()): DashboardCounts {
  const stages = Object.fromEntries(IN_PROGRESS_STAGES.map(s => [s, 0])) as Record<InProgressStage, number>
  const counts: DashboardCounts = { todo: 0, inProgress: 0, stages, blocked: 0, waitingForReview: 0, mergedToday: 0, firstPassToday: 0 }
  for (const task of tasks) {
    if (task.status === 'ready') counts.todo++
    else if ((IN_PROGRESS_STAGES as readonly TaskStatus[]).includes(task.status)) {
      counts.inProgress++
      stages[task.status as InProgressStage]++
    } else if (task.status === 'blocked' || task.status === 'failed') counts.blocked++
    else if (task.status === 'merged' && isToday(task.mergedAt, now)) {
      counts.mergedToday++
      if (task.reviewRounds === 0) counts.firstPassToday++
    }
  }
  counts.waitingForReview = stages.human_review
  return counts
}

// How long a run has been going, short: "45s", "18m", "2h 5m"
export function elapsed(startIso: string | null, now = Date.now()): string {
  if (!startIso) return ''
  const seconds = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// What a live run on Home is on. 'Planning' is for PM turns only: a run on a
// task or an epic names it, and any other run falls back to its own title.
export function liveRunTitle(run: Pick<Run, 'taskTitle' | 'epicTitle' | 'summary' | 'role'>, sessionTitle: string | null): string {
  if (run.taskTitle ?? run.epicTitle) return runTitle(run)
  if (sessionTitle) return `Answering in ${sessionTitle}`
  return run.role === 'pm' ? 'Planning' : runTitle(run)
}
