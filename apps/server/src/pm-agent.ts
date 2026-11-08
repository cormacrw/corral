import { schema, type Executor } from '@corral/db'
import { asc, eq } from 'drizzle-orm'

const { agents } = schema

// The PM agent: the oldest, should there ever be more than one
export async function findPmAgent(db: Executor) {
  const [pm] = await db.select().from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).limit(1)
  return pm ?? null
}
