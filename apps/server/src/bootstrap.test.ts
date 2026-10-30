import { schema } from '@corral/db'
import { createTestDatabase } from '@corral/db/testing'
import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { ensureAgents } from './bootstrap.ts'
import { actorLabel } from './orchestrator.ts'

it('adds a Claude designer to existing agents and preserves it on restart', async () => {
  const handle = await createTestDatabase('pglite')
  try {
    const [custom] = await handle.db.insert(schema.agents).values({ name: 'My builder', role: 'developer', runtime: 'codex' }).returning()
    await ensureAgents(handle.db)
    const before = await handle.db.select().from(schema.agents)
    expect(before.filter(a => a.role === 'designer')).toMatchObject([{ name: 'Iris', runtime: 'claude-code' }])
    expect(before.find(a => a.id === custom!.id)).toEqual(custom)
    await ensureAgents(handle.db)
    expect(await handle.db.select().from(schema.agents)).toEqual(before)
    // A customized designer satisfies bootstrap, regardless of name or runtime.
    await handle.db.update(schema.agents).set({ name: 'Custom designer', runtime: 'codex' }).where(eq(schema.agents.role, 'designer'))
    await ensureAgents(handle.db)
    expect((await handle.db.select().from(schema.agents)).filter(a => a.role === 'designer')).toMatchObject([{ name: 'Custom designer', runtime: 'codex' }])
  } finally {
    await handle.close()
  }
}, 30_000) // Opening and migrating PGlite here, as in hooks (hookTimeout)

it('labels a designer actor for run comments and audit context', () => {
  expect(actorLabel({ kind: 'agent', role: 'designer', runId: 'design-run' })).toBe('Designer')
})

it('seeds the missing designer even when another role already uses its default name', async () => {
  const handle = await createTestDatabase('pglite')
  try {
    await handle.db.insert(schema.agents).values({ name: 'Iris', role: 'developer' })
    await ensureAgents(handle.db)
    const before = await handle.db.select().from(schema.agents)
    expect(before.filter(a => a.role === 'designer')).toMatchObject([{ name: 'Iris 2', runtime: 'claude-code' }])
    await ensureAgents(handle.db)
    expect(await handle.db.select().from(schema.agents)).toEqual(before)
  } finally {
    await handle.close()
  }
})
