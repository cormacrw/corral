import type { Agent, GlobalStatus, Run } from './agents.ts'
import type { Deployment } from './deployments.ts'
import type { Epic } from './epics.ts'
import type { DraftSession, Plan, PlanMessage, PlanSession } from './plans.ts'
import type { Profile } from './profile.ts'
import type { Project } from './projects.ts'
import type { RunEvent } from './runner.ts'
import type { RunnerStatus } from './runner-status.ts'
import type { Comment, Task } from './tasks.ts'

// Sent well inside Cloudflare's ~100 s idle timeout (D12)
export const SSE_HEARTBEAT_MS = 25_000

// Live updates the server streams to web over SSE (GET /api/events).
// The event name is `type`; the data is the whole event as JSON.
export type ServerEvent =
  | { type: 'project.created', project: Project }
  | { type: 'task.created', task: Task }
  | { type: 'task.updated', task: Task }
  | { type: 'runner.status', status: RunnerStatus }
  | { type: 'run.updated', run: Run }
  // Live transcript lines for the agent page. `offset` is where the first one
  // sits in the run's transcript, so web can tell a line it already fetched
  // from one it missed.
  | { type: 'run.events', runId: string, offset: number, events: RunEvent[] }
  | { type: 'agent.updated', agent: Agent }
  | { type: 'task.deleted', taskId: string, projectId: string }
  | { type: 'comment.created', comment: Comment }
  | { type: 'project.updated', project: Project }
  | { type: 'project.deleted', projectId: string }
  | { type: 'global.status', status: GlobalStatus }
  // markedRead: only the unread flag changed, so clients needn't refetch the
  // Inbox: reading never changes what's listed or its count.
  | { type: 'plan.session', session: PlanSession, markedRead?: true }
  | { type: 'plan.message', message: PlanMessage }
  | { type: 'plan.updated', plan: Plan }
  // A project's Drafts changed by plan: proposed, approved or discarded
  | { type: 'plan.drafts', projectId: string, sessions: DraftSession[] }
  | { type: 'epic.updated', epic: Epic }
  | { type: 'profile.updated', profile: Profile }
  // A deployment's release notes were written. markedRead: only its read time changed
  | { type: 'deployment.updated', deployment: Deployment, markedRead?: true }
  // The human opened an Inbox item (POST /inbox/read). Only its unread flag changed
  | { type: 'inbox.read', itemType: string, id: string }

export type ServerEventType = ServerEvent['type']
