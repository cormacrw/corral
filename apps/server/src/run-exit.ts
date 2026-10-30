import type { RunExit } from '@corral/contracts'

// What a run's error says about how its agent process ended, so the run shows
// who stopped it. A runner that hasn't been updated sends no details.
export function runExitError(exit: Exclude<RunExit, { kind: 'rate_limited' }>, lastActivityAt: string | null | undefined): string {
  return withLastActivity(exitMessage(exit), lastActivityAt)
}

export function withLastActivity(error: string, lastActivityAt: string | null | undefined): string {
  return lastActivityAt ? `${error}. Last transcript activity: ${lastActivityAt}` : error
}

function exitMessage(exit: Exclude<RunExit, { kind: 'rate_limited' }>): string {
  switch (exit.kind) {
    case 'exited': return `The agent exited (code ${exit.code}) without reporting an outcome`
    case 'stopped': return exit.reason ? `Stopped by the server: ${exit.reason}` : 'Stopped'
    case 'timed_out': return exit.limitSeconds ? `The run hit its time limit of ${limit(exit.limitSeconds)}` : 'The run hit its time limit'
    case 'runner_shutdown': return 'The runner shut down (container stop or redeploy) and stopped the agent'
    case 'signalled': return `The agent was killed by ${exit.signal}, which came from outside Corral`
    case 'error': return exit.message
  }
}

function limit(seconds: number): string {
  if (seconds % 60 !== 0) return `${seconds} seconds`
  const minutes = seconds / 60
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}
