import { RUNTIMES_TAKING_MESSAGES, type Agent, type Run } from '@corral/contracts'
import { isLiveRun, runtimeLabel } from '~/utils/labels'

// What the agent page shows under a run's transcript (design/agent.md):
// finished runs stay read-only (PRD §7.11), a PM turn is messaged in Plan,
// and a live developer or reviewer run gets the composer. The composer is
// disabled, with the reason, when the message couldn't reach the agent.
export type RunComposer
  = | { kind: 'read-only' }
    | { kind: 'plan' }
    | { kind: 'open' }
    | { kind: 'disabled', reason: string }

export function runComposer(run: Pick<Run, 'state' | 'role'>, agent: Pick<Agent, 'name' | 'runtime'>, runnerOnline: boolean): RunComposer {
  if (!isLiveRun(run)) return { kind: 'read-only' }
  if (run.role === 'pm') return { kind: 'plan' }
  if (!(RUNTIMES_TAKING_MESSAGES as readonly string[]).includes(agent.runtime)) {
    return { kind: 'disabled', reason: `${runtimeLabel(agent.runtime)} can't take messages mid-run. Comment on the task and ${agent.name} reads it on its next run.` }
  }
  if (run.state === 'queued') return { kind: 'disabled', reason: `This run hasn't started yet. You can message ${agent.name} once it starts.` }
  if (run.state === 'stopping') return { kind: 'disabled', reason: 'This run is stopping.' }
  if (!runnerOnline) return { kind: 'disabled', reason: 'The runner is offline, so a message can\'t reach the agent.' }
  return { kind: 'open' }
}
