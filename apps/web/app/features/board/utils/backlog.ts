import { isTaskDone } from '@corral/core'
import type { Epic, Task } from '@corral/contracts'
import { epicTitle } from '~/utils/labels'

// The Backlog's epic groups (design/backlog.md)
export interface BacklogGroup {
  id: string
  title: string
  rows: Task[]
  merged: number
  total: number
}

type Row = Pick<Task, 'ref' | 'title' | 'status' | 'type' | 'mergedAt' | 'updatedAt'>

export function matchesBacklog(task: Row, search: string, showCompleted: boolean): boolean {
  return (task.status === 'backlog' || (showCompleted && isTaskDone(task))) && (!search || `${task.ref} ${task.title}`.toLowerCase().includes(search.toLowerCase()))
}

// Every group that has a row to show. Its progress counts the group's whole
// task list, not only the rows.
export function backlogGroups(tasks: Task[], rows: Task[], epics: Pick<Epic, 'id' | 'title'>[]): BacklogGroup[] {
  const groupOf = (t: Task) => t.parentTask ? t.epicId! : 'none'
  const ids = [...new Set(tasks.map(groupOf))]
  return ids.map((id, i) => ({
    id,
    title: id === 'none' ? 'On their own' : epicTitle(epics, id, i),
    rows: rows.filter(t => groupOf(t) === id),
    merged: tasks.filter(t => groupOf(t) === id && isTaskDone(t)).length,
    total: tasks.filter(t => groupOf(t) === id).length
  })).filter(g => g.rows.length > 0)
}

export const movableRows = (group: Pick<BacklogGroup, 'rows'>) => group.rows.filter(t => t.status === 'backlog')

export const moveGroupLabel = (group: Pick<BacklogGroup, 'rows'>) => movableRows(group).length === 1 ? 'Move to board' : 'Move all to board'

export { priorityText } from '~/utils/labels'
