import type { Agent, Task } from '@corral/contracts'
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

const VERB: Record<Agent['role'], string> = { pm: 'planning', developer: 'building', reviewer: 'reviewing' }

export function projectCardSummary(
  project: { paused: boolean },
  tasks: Pick<Task, 'ref' | 'status' | 'mergedAt' | 'lease'>[],
  agents: Pick<Agent, 'id' | 'name' | 'role'>[],
  needsYou: number,
  now = Date.now()
): ProjectCardSummary {
  const board = tasks.filter(t => onBoard(t, now)).length
  const backlog = tasks.filter(t => t.status === 'backlog').length
  const needs = needsYou > 0 ? `${needsYou} needs you.` : ''
  const leased = tasks.filter(t => t.lease)
  const first = leased[0]
  if (project.paused) {
    return { board, backlog, working: null, line: ['No new runs start while paused.', needs].filter(Boolean).join(' ') }
  }
  if (first?.lease) {
    const role = first.lease.role
    const agent = agents.find(a => a.id === first.lease!.agentId)?.name ?? (role === 'reviewer' ? 'Reviewer' : 'Developer')
    const more = leased.length > 1 ? ` and ${leased.length - 1} more` : ''
    return { board, backlog, working: { agent, role }, line: `${agent} ${VERB[role]} ${first.ref}${more}` }
  }
  return { board, backlog, working: null, line: needs || 'Nothing running.' }
}
