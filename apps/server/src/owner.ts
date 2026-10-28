import type { Actor } from '@corral/core'
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
