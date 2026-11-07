import type { Run } from '@corral/contracts'
import { runTitle } from '~/utils/labels.ts'

// Small helpers for Home's live agents list

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
