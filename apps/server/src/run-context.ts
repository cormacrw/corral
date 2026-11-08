import { isActiveRun, isUuid, type Actor } from '@corral/core'
import { schema, type Database, type Executor, type RunRow, type AgentRow, type ProjectRow, type TaskRow } from '@corral/db'
import { eq } from 'drizzle-orm'
import { ToolError } from './tool-error.ts'
import { lockTask } from './task-rows.ts'

const { agents, projects, runs, tasks } = schema

// What a run works on, which decides where its lease lives and how it ends:
// a task (developer, designer or reviewer), an epic's integration review, an
// epic fix (D29), or a PM turn (D9)
export type RunKind = 'task' | 'epic_review' | 'epic_fix' | 'pm'

function runKind(run: Pick<RunRow, 'role' | 'epicId'>): RunKind {
  if (run.role === 'pm') return 'pm'
  if (run.epicId) return run.role === 'developer' ? 'epic_fix' : 'epic_review'
  return 'task'
}

export interface RunContext {
  run: RunRow
  kind: RunKind
  agent: AgentRow
  // Null only for a PM turn in a global session
  project: ProjectRow | null
  task: TaskRow | null
}

export class RunContexts {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  async load(runId: string): Promise<RunContext | null> {
    // IDs come from the runner; a malformed one is simply unknown
    if (!isUuid(runId)) return null
    const [row] = await this.#db.select({ run: runs, agent: agents, project: projects, task: tasks })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(projects, eq(projects.id, runs.projectId))
      .leftJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId))
    if (!row) return null
    const kind = runKind(row.run)
    // Task and epic runs always have a project; only PM turns may be global.
    if (kind !== 'pm' && !row.project) return null
    return { ...row, kind }
  }

  // The run, if it's still live and still holds its lease at this epoch.
  // Anything from a stale run is ignored or rejected (fencing).
  async fenced(runId: string, leaseEpoch: number): Promise<RunContext | null> {
    const ctx = await this.load(runId)
    if (!ctx || ctx.run.leaseEpoch !== leaseEpoch) return null
    if (!isActiveRun(ctx.run.state)) return null
    if (ctx.kind === 'task' && ctx.task && (ctx.task.leaseRunId !== runId || ctx.task.leaseEpoch !== leaseEpoch)) return null
    return ctx
  }

  async lockHeld(tx: Executor, ctx: RunContext, lost = 'This run lost its lease. Stop working.') {
    const locked = await lockTask(tx, ctx.task!.id)
    if (locked.task.leaseRunId !== ctx.run.id) throw new ToolError(lost)
    return locked
  }
}

export function runActor(ctx: RunContext): Actor {
  return { kind: 'agent', role: ctx.run.role, runId: ctx.run.id, ...(ctx.run.planSessionId ? { sessionId: ctx.run.planSessionId } : {}) }
}
