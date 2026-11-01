import type { Agent, Inbox, Task } from '@corral/contracts'
import { onBoard } from './board.ts'

// What a project's card on the mobile Projects tab shows (design/mobile.md)
export interface ProjectCardSummary {
  board: number
  backlog: number
  // One line under the name: who is working, or why nothing is
  line: string
  // An agent holds a lease on one of the project's tasks
  working: { agent: string, role: Agent['role'] } | null
}

// A project's share of Needs you
export function projectNeedsYou(inbox: Inbox | null, projectId: string | undefined) {
  return inbox?.needsYou.filter(i => i.project.id === projectId) ?? []
}

const VERB: Record<Agent['role'], string> = { pm: 'planning', developer: 'building', designer: 'designing', reviewer: 'reviewing' }

export function projectCardSummary(
  project: { paused: boolean },
  tasks: Pick<Task, 'ref' | 'type' | 'status' | 'mergedAt' | 'updatedAt' | 'lease' | 'developer' | 'reviewer'>[],
  needsYou: number,
  now = Date.now()
): ProjectCardSummary {
  // Work in flight: the Board's columns without recently merged tasks
  const board = tasks.filter(t => t.status !== 'merged' && t.status !== 'approved' && onBoard(t, now)).length
  const backlog = tasks.filter(t => t.status === 'backlog').length
  const needs = needsYou > 0 ? `${needsYou} needs you.` : ''
  const leased = tasks.filter(t => t.lease)
  const first = leased[0]
  if (project.paused) {
    return { board, backlog, working: null, line: ['No new runs start while paused.', needs].filter(Boolean).join(' ') }
  }
  if (first?.lease) {
    const role = first.lease.role
    // The lease is held by the task's latest run of that role
    const agent = (role === 'reviewer' ? first.reviewer?.name : role === 'developer' ? first.developer?.name : null) ?? (role === 'reviewer' ? 'Reviewer' : 'Developer')
    const more = leased.length > 1 ? ` and ${leased.length - 1} more` : ''
    return { board, backlog, working: { agent, role }, line: `${agent} ${VERB[role]} ${first.ref}${more}` }
  }
  return { board, backlog, working: null, line: needs || 'Nothing running.' }
}
