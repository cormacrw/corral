import type { RunEvent, RunExit, RunJob } from '@corral/contracts'
import type { AgentLauncher, AgentProcess, AgentSession } from './agent-runtime.ts'
import type { RunOutbox } from './run-outbox.ts'
import type { RunSpool } from './run-spool.ts'
import type { RunTimer } from './run-timings.ts'
import type { ToolOutcome } from './mcp.ts'

// One run on this runner, shared by the run manager and the parts it uses:
// the outbox, the spool, the agent tools and the warm PM sessions.

export type StopReason = Extract<RunExit, { kind: 'stopped' | 'timed_out' | 'runner_shutdown' }>['kind']

type UsageEvent = Extract<RunEvent, { type: 'usage' }>

interface ToolState {
  // Set once the server accepted report_outcome; the run is over
  outcomeAccepted: boolean
  // Settles when the server answers a report_outcome call that is still open
  reporting: Promise<unknown> | null
  // The report_outcome call under way, push included; a retry joins it
  outcomeCall: Promise<ToolOutcome> | null
  // Pushes under way for a report or a design, ahead of telling the server
  pushes: number
}

export interface Run {
  job: RunJob
  // Null when the runner has no adapter for job.runtime; the run ends at once
  runtime: AgentLauncher | null
  // A PM turn whose process stays warm for the session's next turn (D9)
  warm: boolean
  scratchDir: string
  worktree: string | null
  initialHeadSha: string | null
  outbox: RunOutbox
  // Open from the start of the agent work until the run ends
  spool: RunSpool | null
  timer: RunTimer
  tools: ToolState
  // Set when the server, the timeout or a runner shutdown asked for the process
  // to die. The first one wins: it's what cut the run off. keepWork: the stop
  // asked for uncommitted work to be saved.
  stop: { reason: StopReason, detail: string, keepWork: boolean } | null
  lease: { confirmedUntil: number, revoked: boolean }
  process: AgentProcess | null
  // The live session taking messages; null between processes and once it closes
  session: AgentSession | null
  // Messages that arrived while there was no live session to take them
  queuedMessages: string[]
  agent: AgentState
  ended: boolean
  // Settles once the server has been told the run ended
  closing: Promise<void>
  // Resolves with the same moment, but exists from the start of the run
  closed: PromiseWithResolvers<void>
  timeoutTimer: NodeJS.Timeout | null
  unregisterTools: (() => void) | null
}

// What the agent's processes have shown so far
interface AgentState {
  sessionId: string | null
  // run.started has gone out
  started: boolean
  // The init line arrived, so the CLI really started (a failed --resume never gets there)
  sawInit: boolean
  // Resumed once to report an outcome
  resumed: boolean
  resumeFailed: boolean
  rateLimit: { resetsAt: string | null } | null
  runtimeError: string | null
  // Corral signalled the process outside a stop, so its signal isn't a stranger's
  signalledByCorral: boolean
  // A signal Corral didn't send killed the agent, even if a resume came after
  killedBy: string | null
  // The last agent exit code, or the turn's when a warm PM process answered it
  exitCode: number | null
  lastActivityAt: string | null
  // Usage so far, and what earlier processes of this run had reached
  usage: UsageEvent | null
  usageBase: UsageEvent | null
}

export function newAgentState(sessionId: string | null): AgentState {
  return {
    sessionId,
    started: false,
    sawInit: false,
    resumed: false,
    resumeFailed: false,
    rateLimit: null,
    runtimeError: null,
    signalledByCorral: false,
    killedBy: null,
    exitCode: null,
    lastActivityAt: null,
    usage: null,
    usageBase: null
  }
}

// Each process counts from zero, but the server stores the run's total
export function runUsage(agent: AgentState, usage: UsageEvent): UsageEvent {
  const base = agent.usageBase
  agent.usage = {
    ...usage,
    inputTokens: usage.inputTokens + (base?.inputTokens ?? 0),
    cacheReadTokens: usage.cacheReadTokens + (base?.cacheReadTokens ?? 0),
    outputTokens: usage.outputTokens + (base?.outputTokens ?? 0),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens + (base?.cacheWriteTokens ?? 0) })
  }
  return agent.usage
}
