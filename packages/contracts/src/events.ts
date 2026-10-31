import type { Agent, Comment, Deployment, DraftSession, Epic, GlobalStatus, Plan, PlanMessage, PlanSession, Profile, Project, Run, Task } from './api.ts'
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
  | { type: 'task.deleted', taskId: string, projectId: string }
  | { type: 'comment.created', comment: Comment }
  | { type: 'project.updated', project: Project }
  | { type: 'project.deleted', projectId: string }
  | { type: 'global.status', status: GlobalStatus }
  // markedRead: only the unread flag changed, so clients needn't refetch the
  // Inbox. It carries the server's new count.
  | { type: 'plan.session', session: PlanSession, markedRead?: { inboxCount: number } }
  | { type: 'plan.message', message: PlanMessage }
  | { type: 'plan.updated', plan: Plan }
  // A project's Drafts changed by plan: proposed, approved or discarded
  | { type: 'plan.drafts', projectId: string, sessions: DraftSession[] }
  | { type: 'epic.updated', epic: Epic }
  | { type: 'profile.updated', profile: Profile }
  // A deployment's release notes were written. markedRead: only its read time changed
  | { type: 'deployment.updated', deployment: Deployment, markedRead?: true }

export type ServerEventType = ServerEvent['type']

// Sent well inside Cloudflare's ~100 s idle timeout (D12)
export const SSE_HEARTBEAT_MS = 25_000
