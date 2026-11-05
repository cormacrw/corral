import { schema, type Executor } from '@corral/db'
import type { Actor } from '@corral/core'
import { asc, eq, inArray } from 'drizzle-orm'

const { agents, runs } = schema
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Audit actors keep only the role and run. The PM is found by its role, as
// the project overview does, and other agents by their run's agent; an action
// the human confirmed through the PM is the PM's. Null when the agent can't be
// found, and the caller shows the role label.
export async function actorNames(db: Executor, actors: Actor[]): Promise<(actor: Actor) => string | null> {
  const runIds = [...new Set(actors.flatMap(a => a.kind === 'agent' && a.role !== 'pm' && UUID.test(a.runId) ? [a.runId] : []))]
  const needsPm = actors.some(a => (a.kind === 'agent' && a.role === 'pm') || (a.kind === 'human' && a.viaPm))
  const [pmRows, runRows] = await Promise.all([
    needsPm ? db.select({ name: agents.name }).from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).limit(1) : [],
    runIds.length > 0 ? db.select({ id: runs.id, name: agents.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).where(inArray(runs.id, runIds)) : []
  ])
  const pm = pmRows[0]?.name ?? null
  const byRun = new Map(runRows.map(r => [r.id, r.name]))
  return (actor) => {
    if (actor.kind === 'human') return actor.viaPm ? pm : null
    if (actor.kind === 'agent') return actor.role === 'pm' ? pm : byRun.get(actor.runId) ?? null
    return null
  }
}
