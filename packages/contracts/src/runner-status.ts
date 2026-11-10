import { AGENT_ROLES, type AgentRole, type CliId } from '@corral/core'

// Runners as the server and the web app see them. Free of zod: the web app
// imports it through /client.

// What a runner takes on, sent in its hello. The server only assigns a run
// to a runner that takes its role, has its runtime and has a free slot.
export type SlotSource = { kind: 'explicit' } | {
  kind: 'derived'
  cpus: number
  memoryBytes: number
  slotCpus: number
  slotMemoryBytes: number
}

export interface RunnerCapacity {
  // Optional for runners deployed before resource-based sizing.
  slotSource?: SlotSource | undefined
  // Most agent runs the machine runs at once (CORRAL_RUNNER_SLOTS)
  slots: number
  // Runtime ids with a signed-in CLI, e.g. 'claude-code', 'codex'
  runtimes: string[]
  // Agent roles it takes (CORRAL_RUNNER_ROLES); design runs are designer
  // runs on design tasks (D23), taken only with 'design'
  roles: RunnerRole[]
}

export type RunnerRole = AgentRole | 'design'
export const RUNNER_ROLES: readonly RunnerRole[] = [...AGENT_ROLES.filter(role => role !== 'designer'), 'design']

export function runnerRoleFor(role: AgentRole): RunnerRole {
  return role === 'designer' ? 'design' : role
}

// CLIs sign in inside the runner container (D12, D18); Corral never sees the credentials
const inRunner = (command: string) => `docker exec -it corral-runner ${command}`
export const GH_LOGIN_COMMAND = inRunner('gh auth login')
export function cliLoginCommand(id: CliId): string {
  return inRunner(id === 'codex' ? 'codex login --device-auth' : 'claude')
}

export interface RunnerInfo extends RunnerCapacity {
  // Set while its agent tools differ from the server's; see toolContractReason
  toolContractReason?: string | null
  activeRunCount?: number
  updateState?: string
  updateError?: string
  commit: string
  serverCommit: string
  behind: boolean
  draining: boolean
  updateRequested: boolean
  id: string
  name: string
  online: boolean
  // Agent runs on this runner right now, out of `slots`
  slotsInUse: number
  // The protocol its last hello spoke. A runner on another version than the
  // server's was turned away (RUNNER_CLOSE_CODES.protocol) and needs updating.
  protocol: number
  needsUpdate: boolean
  connectedAt: string
  lastHeartbeatAt: string
}

export interface RunnerStatus {
  runners: RunnerInfo[]
  // The protocol version this server speaks (RUNNER_PROTOCOL_VERSION)
  protocol: number
  // Aggregate compatibility fields for the shell: online means any runner.
  online: boolean
  runnerId: string | null
  name: string | null
  connectedAt: string | null
  lastHeartbeatAt: string | null
}

// How long a runner kept from work may show no update attempt before a human
// hears about it. The host updater's timer ticks every minute.
export const RUNNER_UPDATE_GRACE_MS = 5 * 60_000

// What a human has to look at for this runner, or null. A failed attempt says
// why. A runner kept from work that shows no attempt has nothing updating it:
// tools that differ, or a protocol the server refused, whose runner is offline.
export function runnerUpdateProblem(runner: RunnerInfo, now = Date.now()): string | null {
  if (!runner.behind && !runner.toolContractReason && !runner.needsUpdate) return null
  if (runner.updateState === 'failed') return runner.updateError || 'The host updater failed without saying why.'
  if (runner.updateState || now - Date.parse(runner.connectedAt) <= RUNNER_UPDATE_GRACE_MS) return null
  const fix = 'Check the host updater timer (corral-runner-update), or update it by hand.'
  if (runner.needsUpdate) return `The server refuses its protocol version (${runner.protocol}), and no update attempt has started. ${fix}`
  if (runner.toolContractReason && runner.online) return `No update attempt since it connected. ${runner.toolContractReason} ${fix}`
  return null
}

// A runner's id in the Inbox, kept stable so the row survives reconnects
export const runnerItemId = (runnerId: string) => `runner-${runnerId}`
