import type { Epic, Project, Run, Task } from '@corral/contracts'
import { completedAt, type TaskStatus } from '@corral/core'
import { columnKey } from '~/features/board/utils/board.ts'
import { dayRows } from '~/utils/days'
import { epicWithLiveCounts, runTitle } from '~/utils/labels.ts'

// Home's figures (design/home.md on the web, design/mobile.md on a phone),
// counted from the task and epic lists the shell already loads, by the
// Board's columns, so they match each project's Board.

// In progress is every Board column between Ready and Blocked & failed: the
// approved, unmerged statuses an agent or the human is moving (D10)
export function homeColumn(status: TaskStatus): 'ready' | 'in_progress' | 'blocked' | 'complete' | null {
  const key = columnKey(status)
  if (key === undefined) return null
  return key === 'ready' || key === 'blocked' || key === 'complete' ? key : 'in_progress'
}
export const isInProgress = (status: TaskStatus): boolean => homeColumn(status) === 'in_progress'

// The stages in progress, each shown apart in open work
export const IN_PROGRESS_STAGES = ['in_progress', 'agent_review', 'human_review', 'ready_to_merge'] as const satisfies readonly TaskStatus[]
export type InProgressStage = typeof IN_PROGRESS_STAGES[number]
export const OPEN_STAGES = ['ready', ...IN_PROGRESS_STAGES] as const satisfies readonly TaskStatus[]
export type OpenStage = typeof OPEN_STAGES[number]

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

// Tasks finished per local day for the last `days` days, today last, one
// count per project. Merged tasks and approved designs both count, as the
// Board's Done column does.
export interface MergedDay { date: Date, index: number, total: number, byProject: Record<string, number> }
export function mergedByDay(projects: Pick<Project, 'id'>[], tasks: Record<string, Pick<Task, 'type' | 'status' | 'mergedAt' | 'updatedAt'>[] | undefined>, days: number, now: number): MergedDay[] {
  const { rows, rowAt } = dayRows<MergedDay>(days, now, (date, index) => ({ date, index, total: 0, byProject: Object.fromEntries(projects.map(p => [p.id, 0])) }))
  for (const project of projects) {
    for (const task of tasks[project.id] ?? []) {
      const done = completedAt(task)
      const row = done && rowAt(done)
      if (!row) continue
      row.byProject[project.id] = (row.byProject[project.id] ?? 0) + 1
      row.total++
    }
  }
  return rows
}

// Merged in the last 7 days against the 7 before, from 14 days of rows
export function weekOverWeek(rows: Pick<MergedDay, 'total'>[]): { thisWeek: number, lastWeek: number } {
  const sum = (list: Pick<MergedDay, 'total'>[]) => list.reduce((n, r) => n + r.total, 0)
  return { thisWeek: sum(rows.slice(-7)), lastWeek: sum(rows.slice(-14, -7)) }
}

// Open work per project by stage. Backlog is left out so it doesn't drown the rest.
export function openWork<P extends Pick<Project, 'id'>>(projects: P[], tasks: Record<string, Pick<Task, 'status'>[] | undefined>): { project: P, total: number, stages: Record<OpenStage, number> }[] {
  return projects.map((project) => {
    const stages = Object.fromEntries(OPEN_STAGES.map(s => [s, 0])) as Record<OpenStage, number>
    for (const task of tasks[project.id] ?? []) {
      if ((OPEN_STAGES as readonly string[]).includes(task.status)) stages[task.status as OpenStage]++
    }
    return { project, stages, total: OPEN_STAGES.reduce((n, s) => n + stages[s], 0) }
  })
}

// The parents touched most recently, across projects. Collapsed one-task
// epics have no parent to show, so they're left out.
export function recentEpics<P extends Pick<Project, 'id'>>(projects: P[], epics: Record<string, Epic[] | undefined>, tasks: Record<string, Pick<Task, 'epicId' | 'status' | 'type'>[] | undefined>, limit: number): { epic: Epic, project: P }[] {
  return projects
    .flatMap(project => (epics[project.id] ?? [])
      .filter(epic => epic.taskId || epic.branch)
      .map(epic => ({ epic: epicWithLiveCounts(epic, tasks[project.id] ?? []), project })))
    .sort((a, b) => Date.parse(b.epic.updatedAt) - Date.parse(a.epic.updatedAt))
    .slice(0, limit)
}

// Hours, to one decimal under 10 and whole above; days past two days
export function formatDuration(ms: number): string {
  const hours = ms / 3_600_000
  if (hours >= 48) return `${(hours / 24).toFixed(1)}d`
  if (hours >= 10) return `${Math.round(hours)}h`
  if (hours >= 1) return `${hours.toFixed(1)}h`
  return `${Math.max(1, Math.round(ms / 60_000))}m`
}
