import { schema, type Executor } from '@corral/db'
import { isUuid, isViaPm, type Actor } from '@corral/core'
import { eq, inArray } from 'drizzle-orm'
import { findPmAgent } from './pm-agent.ts'

const { agents, runs } = schema
// Audit actors keep only the role and run. The PM is found by its role, as
// the project overview does, and other agents by their run's agent; an action
// the human confirmed through the PM is the PM's. Null when the agent can't be
// found, and the caller shows the role label.
export async function actorNames(db: Executor, actors: Actor[]): Promise<(actor: Actor) => string | null> {
  const runIds = [...new Set(actors.flatMap(a => a.kind === 'agent' && a.role !== 'pm' && isUuid(a.runId) ? [a.runId] : []))]
  const needsPm = actors.some(isViaPm)
  const [pmAgent, runRows] = await Promise.all([
    needsPm ? findPmAgent(db) : null,
    runIds.length > 0 ? db.select({ id: runs.id, name: agents.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).where(inArray(runs.id, runIds)) : []
  ])
  const pm = pmAgent?.name ?? null
  const byRun = new Map(runRows.map(r => [r.id, r.name]))
  return (actor) => {
    if (actor.kind === 'human') return actor.viaPm ? pm : null
    if (actor.kind === 'agent') return actor.role === 'pm' ? pm : byRun.get(actor.runId) ?? null
    return null
  }
}
