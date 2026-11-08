import { AGENT_ROLES, DEFAULT_AGENT_RUNTIME, type Actor, type AgentRole } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { asc } from 'drizzle-orm'

// Who a web request acts as. Corral has no login of its own in this phase:
// Cloudflare Access sits in front (D12) and there is one user. Requests are
// attributed to that user, created on first start; onboarding names them.
// Mapping the Access identity to a user replaces this when there are more (D1).
export async function ensureOwner(db: Database): Promise<Actor> {
  const [existing] = await db.select().from(schema.users).orderBy(asc(schema.users.createdAt)).limit(1)
  const user = existing ?? (await db.insert(schema.users).values({ name: 'Owner' }).returning())[0]!
  return { kind: 'human', userId: user.id }
}

// The global agents, one per role (D13, D23). Onboarding names them; until
// then these defaults let the scheduler and PM run.
const DEFAULT_NAMES: Record<AgentRole, string> = { pm: 'Juno', developer: 'Atlas', designer: 'Iris', reviewer: 'Vera' }

export async function ensureAgents(db: Database): Promise<void> {
  const existing = await db.select({ role: schema.agents.role, name: schema.agents.name }).from(schema.agents)
  const missing = AGENT_ROLES.filter(role => !existing.some(a => a.role === role))
  const names = new Set(existing.map(a => a.name))
  if (missing.length > 0) {
    await db.insert(schema.agents).values(missing.map((role) => {
      const preferred = DEFAULT_NAMES[role]
      let name = preferred
      for (let suffix = 2; names.has(name); suffix++) name = `${preferred} ${suffix}`
      names.add(name)
      return { name, role, runtime: DEFAULT_AGENT_RUNTIME }
    })).onConflictDoNothing()
  }
}
