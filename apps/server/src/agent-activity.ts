import { ACTIVE_RUN_STATES, taskRef } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, desc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm'
import { listAgents } from './runs.ts'

const { epics, projects, runs, tasks } = schema

// The tool's answer has to fit in one tool response, so runs are capped per
// agent and long text is cut. Asking for one agent gets more of both.
const ACTIVE_RUN_LIMIT = 10
const RECENT_RUNS = { team: 3, agent: 20 }
const TEXT_LIMIT = { team: 200, agent: 500 }

export class UnknownAgent extends Error {}

function clip(text: string | null, limit: number): string | null {
  return text && text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

async function agentRuns(db: Executor, where: SQL | undefined, order: SQL[], limit: number, textLimit: number) {
  const rows = await db.select({ run: runs, projectName: projects.name, prefix: projects.prefix, taskNumber: tasks.number, taskTitle: tasks.title, epicTitle: epics.title }).from(runs)
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(epics, eq(epics.id, runs.epicId))
    .where(where)
    .orderBy(...order)
    .limit(limit)
  return rows.map(({ run, projectName, prefix, taskNumber, taskTitle, epicTitle }) => ({
    number: run.number,
    state: run.state,
    outcome: run.outcome,
    project: projectName ?? 'Global',
    task: taskNumber === null || prefix === null ? null : { ref: taskRef(prefix, taskNumber), title: taskTitle },
    epic: run.epicId === null ? null : { id: run.epicId, title: epicTitle },
    role: run.role,
    runner: run.runnerName,
    summary: clip(run.summary, textLimit),
    error: clip(run.error, textLimit),
    rateLimitResetAt: run.rateLimitResetAt?.toISOString() ?? null,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null
  }))
}

// What the agents are doing, across every project: agents aren't tied to one,
// so an agent busy elsewhere would otherwise look idle. A name picks one agent
// and returns more of its history.
export async function agentActivity(db: Executor, name?: string) {
  const all = await listAgents(db)
  const named = name === undefined ? undefined : all.find(a => a.name === name) ?? all.find(a => a.name.toLowerCase() === name.toLowerCase())
  if (name !== undefined && !named) throw new UnknownAgent(`There is no agent "${name}". The agents are: ${all.map(a => a.name).join(', ')}.`)
  const scope = named ? 'agent' : 'team'
  const now = new Date()
  return {
    agents: await Promise.all((named ? [named] : all).map(async (agent) => {
      const paused = agent.paused || (agent.pausedUntil !== null && new Date(agent.pausedUntil) > now)
      const [activeRuns, recentRuns] = await Promise.all([
        // Runs already working come first, so a long queue can't hide them
        agentRuns(db, and(eq(runs.agentId, agent.id), inArray(runs.state, [...ACTIVE_RUN_STATES])), [sql`${runs.startedAt} desc nulls last`, desc(runs.number)], ACTIVE_RUN_LIMIT, TEXT_LIMIT[scope]),
        agentRuns(db, and(eq(runs.agentId, agent.id), notInArray(runs.state, [...ACTIVE_RUN_STATES])), [desc(runs.number)], RECENT_RUNS[scope], TEXT_LIMIT[scope])
      ])
      return {
        name: agent.name,
        role: agent.role,
        runtime: agent.runtime,
        status: agent.activeRuns > 0 ? 'busy' : paused ? 'paused' : 'idle',
        paused: agent.paused,
        pausedUntil: agent.pausedUntil,
        // Can exceed activeRuns.length, which is capped
        activeRunCount: agent.activeRuns,
        activeRuns,
        recentRuns
      }
    }))
  }
}
