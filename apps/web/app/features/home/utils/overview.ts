import type { Epic, Project, Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import { completedAt } from '~/features/runs/utils/completion.ts'
import { epicWithLiveCounts } from '~/utils/labels.ts'

// The web Home's figures (design/home.md), counted from the task and epic
// lists the shell already loads, so they match each project's Board.

const DAY = 86_400_000

export const startOfDay = (at: number): number => {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

// Tasks finished per local day for the last `days` days, today last, one
// count per project. Merged tasks and approved designs both count, as the
// Board's Done column does.
export interface MergedDay { date: Date, index: number, total: number, byProject: Record<string, number> }
export function mergedByDay(projects: Pick<Project, 'id'>[], tasks: Record<string, Pick<Task, 'type' | 'status' | 'mergedAt' | 'updatedAt'>[] | undefined>, days: number, now: number): MergedDay[] {
  const first = startOfDay(now) - (days - 1) * DAY
  const rows: MergedDay[] = Array.from({ length: days }, (_, index) => ({
    date: new Date(first + index * DAY),
    index,
    total: 0,
    byProject: Object.fromEntries(projects.map(p => [p.id, 0]))
  }))
  for (const project of projects) {
    for (const task of tasks[project.id] ?? []) {
      const done = completedAt(task)
      if (!done) continue
      // Days rather than 24h steps, so a clock change doesn't shift a merge
      const index = Math.round((startOfDay(Date.parse(done)) - first) / DAY)
      const row = rows[index]
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

// Open work per project by stage: Ready, then the statuses an agent or the
// human is moving. Backlog is left out so it doesn't drown the rest.
export const OPEN_STAGES = ['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge'] as const satisfies readonly TaskStatus[]
export type OpenStage = typeof OPEN_STAGES[number]
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
