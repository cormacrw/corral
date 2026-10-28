import type { Agent, Project, Run, Task } from './api.ts'
import type { RunEvent, RunnerStatus } from './runner.ts'

// Live updates the server streams to web over SSE (GET /api/events).
// The event name is `type`; the data is the whole event as JSON.
export type ServerEvent =
  | { type: 'project.created', project: Project }
  | { type: 'task.created', task: Task }
  | { type: 'task.updated', task: Task }
  | { type: 'runner.status', status: RunnerStatus }
  | { type: 'run.updated', run: Run }
  // Live transcript lines for the agent page
  | { type: 'run.events', runId: string, events: RunEvent[] }
  | { type: 'agent.updated', agent: Agent }

export type ServerEventType = ServerEvent['type']

// Sent well inside Cloudflare's ~100 s idle timeout (D12)
export const SSE_HEARTBEAT_MS = 25_000
