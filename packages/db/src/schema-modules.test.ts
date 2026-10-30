import { is, Table } from 'drizzle-orm'
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const modulesFolder = join(import.meta.dirname, 'schema')

// The table modules import each other in cycles (see schema.ts), so each one
// has to work as the first module loaded, whichever way the cycle unwinds
describe('schema modules', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it.each(readdirSync(modulesFolder))('resolve every foreign key when %s loads first', async (file) => {
    await import(/* @vite-ignore */ join(modulesFolder, file))
    const schema = await import('./schema.ts')

    const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, Table))
    expect(tables).not.toHaveLength(0)
    for (const table of tables) {
      for (const foreignKey of getTableConfig(table).foreignKeys) {
        const { foreignTable, foreignColumns } = foreignKey.reference()
        expect(tables).toContain(foreignTable)
        expect(foreignColumns).not.toHaveLength(0)
      }
    }
  })
})
