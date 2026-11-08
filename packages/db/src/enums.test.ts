import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { DatabaseHandle } from './client.ts'
import * as enums from './schema/enums.ts'
import { createTestDatabase } from './testing.ts'

// The enums take their values from core, so a value added there needs a
// migration too; without one, writing it fails at runtime
let handle: DatabaseHandle
beforeAll(async () => {
  handle = await createTestDatabase('pglite')
})
afterAll(async () => {
  await handle?.close()
})

it('migrates every enum value the schema can write', async () => {
  const result = await handle.db.execute(sql`
    select t.typname as name, e.enumlabel as value
    from pg_type t join pg_enum e on e.enumtypid = t.oid`) as unknown as { rows: { name: string, value: string }[] }
  const migrated = new Map<string, string[]>()
  for (const { name, value } of result.rows) migrated.set(name, [...migrated.get(name) ?? [], value])

  const declared = Object.values(enums).filter(value => typeof value === 'function' && 'enumName' in value)
  expect(declared.length).toBeGreaterThan(0)
  for (const pgEnum of declared) {
    expect(migrated.get(pgEnum.enumName)?.sort(), pgEnum.enumName).toEqual([...pgEnum.enumValues].sort())
  }
})
