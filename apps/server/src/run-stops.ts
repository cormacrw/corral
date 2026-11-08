// Why the server stopped a run, kept as the run's error. The runner's later
// run.ended may add the agent's last activity after the reason
// (`withLastActivity`), so reasons are matched with `stoppedBy`.
export const STOP = {
  human: 'Stopped by a human',
  killSwitch: 'Stopped: Corral was stopped',
  runnerOffline: 'The runner went offline before the run started',
  turnOffline: 'The runner went offline before the turn started',
  fixNotStarted: 'The fix could not start yet',
  runnerRestarted: 'The runner restarted during the run: it shut down before it could report',
  taskDeleted: 'The task was deleted',
  projectRemoved: 'The project was removed',
  leaseExpired: 'Lease expired: no heartbeat from the runner',
  pmLeaseExpired: 'PM turn lease expired: no heartbeat from the runner',
  fixLeaseExpired: 'Task fix lease expired',
  reviewLeaseExpired: 'Task review lease expired'
} as const

const LAST_ACTIVITY = '. Last transcript activity: '

export function withLastActivity(error: string, lastActivityAt: string | null | undefined): string {
  return lastActivityAt ? `${error}${LAST_ACTIVITY}${lastActivityAt}` : error
}

export const hasLastActivity = (error: string): boolean => error.includes(LAST_ACTIVITY)

export function stoppedBy(error: string | null | undefined, ...reasons: string[]): boolean {
  return error != null && reasons.includes(error.split(LAST_ACTIVITY)[0]!)
}

// Stops the task is retried after, which ask the runner to keep the run's work
export function keepsWork(error: string | null | undefined): boolean {
  return stoppedBy(error, STOP.human, STOP.killSwitch)
}

// A developer run on an epic that never reached a runner says nothing about the fix
export function neverStarted(error: string | null | undefined): boolean {
  return stoppedBy(error, STOP.runnerOffline, STOP.fixNotStarted)
}
