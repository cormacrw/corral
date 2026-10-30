import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from './client.ts'
import { createTestDatabase } from './testing.ts'

const migrationFailure = vi.hoisted(() => ({ error: null as Error | null }))

vi.mock('drizzle-orm/node-postgres/migrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('drizzle-orm/node-postgres/migrator')>()
  return {
    migrate: (...args: Parameters<typeof real.migrate>) =>
      migrationFailure.error ? Promise.reject(migrationFailure.error) : real.migrate(...args)
  }
})
vi.mock('drizzle-orm/pglite/migrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('drizzle-orm/pglite/migrator')>()
  return {
    migrate: (...args: Parameters<typeof real.migrate>) =>
      migrationFailure.error ? Promise.reject(migrationFailure.error) : real.migrate(...args)
  }
})

const realUrl = process.env.CORRAL_DATABASE_URL!

async function databases(): Promise<string[]> {
  const admin = new pg.Client({ connectionString: realUrl })
  await admin.connect()
  try {
    const { rows } = await admin.query<{ datname: string }>('select datname from pg_database')
    return rows.map(row => row.datname)
  } finally {
    await admin.end()
  }
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: realUrl })
  await admin.connect()
  try {
    await admin.query(sql)
  } finally {
    await admin.end()
  }
}

async function failureOf(work: Promise<unknown>): Promise<Error> {
  const error: unknown = await work.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

// Everything an error would print, nested errors included
function printed(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const nested = [error.cause, ...(error instanceof AggregateError ? error.errors : [])]
  return [JSON.stringify(error), error.message, error.stack, ...nested.map(printed)].join('\n')
}

// Really ends the pool, so the forced drop doesn't kill its idle connections
function failPoolEnd() {
  const end = pg.Pool.prototype.end as (this: pg.Pool) => Promise<void>
  return vi.spyOn(pg.Pool.prototype, 'end').mockImplementation(async function (this: pg.Pool) {
    await end.call(this)
    throw new Error('close failed')
  } as never)
}

function generatedName(error: Error): string {
  const name = /corral_test_[0-9a-f]{32}/.exec(error.message)?.[0]
  expect(name).toBeDefined()
  return name!
}

beforeEach(() => {
  migrationFailure.error = null
})
afterEach(() => {
  vi.restoreAllMocks()
  process.env.CORRAL_DATABASE_URL = realUrl
})

describe('openDatabase failures', () => {
  it.each([
    { driver: 'postgres' as const, location: { driver: 'postgres' as const, url: realUrl }, close: () => vi.spyOn(pg.Pool.prototype, 'end') },
    { driver: 'pglite' as const, location: { driver: 'pglite' as const, dataDir: null }, close: async () => {
      const { PGlite } = await import('@electric-sql/pglite')
      return vi.spyOn(PGlite.prototype, 'close')
    } }
  ])('keeps the $driver migration failure as the cause when closing also fails', async ({ location, close }) => {
    const migration = new Error('relation already exists')
    migrationFailure.error = migration
    const closeFailure = new Error('close failed')
    vi.mocked(await close()).mockRejectedValue(closeFailure)

    const error = await failureOf(openDatabase(location))

    expect(error.cause).toBe(migration)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([migration, closeFailure])
    expect(error.message).toContain('Migrating the')
    expect(error.message).toContain('relation already exists')
    expect(error.message).toContain('close failed')
  })

  it('scrubs the password from errors that quote the connection string', async () => {
    const url = 'postgres://corral:s3cret%40pw@127.0.0.1:1/corral'
    const driverError = new Error(`could not connect to ${url}`, { cause: new Error('auth failed for s3cret@pw') })
    migrationFailure.error = driverError

    const error = await failureOf(openDatabase({ driver: 'postgres', url }))

    expect(error.cause).toBe(driverError)
    expect(printed(error)).not.toContain('s3cret')
    expect(error.message).toContain('postgres://corral:***@127.0.0.1:1/corral')
  })
})

// Creating databases is slow while other test files do the same
describe('createTestDatabase failures', { timeout: 60_000 }, () => {
  it('drops only its generated database when initialisation fails', async () => {
    const bystander = `corral_test_bystander_${randomUUID().replaceAll('-', '')}`
    await adminQuery(`create database ${bystander}`)
    migrationFailure.error = new Error('migration failed')

    const error = await failureOf(createTestDatabase('postgres'))

    expect(printed(error)).toContain('migration failed')
    const remaining = await databases()
    expect(remaining).not.toContain(generatedName(error))
    expect(remaining).toContain(bystander)
    expect(remaining).toContain(new URL(realUrl).pathname.slice(1))
    await adminQuery(`drop database ${bystander}`)
  })

  it('drops the database on a failed initialisation even when closing fails', async () => {
    migrationFailure.error = new Error('migration failed')
    failPoolEnd()

    const error = await failureOf(createTestDatabase('postgres'))

    expect(printed(error)).toContain('migration failed')
    expect(printed(error)).toContain('close failed')
    expect(await databases()).not.toContain(generatedName(error))
  })

  it('still drops the database when close fails', async () => {
    const handle = await createTestDatabase('postgres')
    const name = await currentDatabase(handle!)
    const end = failPoolEnd()

    const error = await failureOf(handle!.close())

    expect(end).toHaveBeenCalled()
    expect(error.message).toContain('close failed')
    expect(await databases()).not.toContain(name)
  })

  it('still closes when the drop fails', async () => {
    const handle = await createTestDatabase('postgres')
    const name = await currentDatabase(handle!)
    const end = vi.spyOn(pg.Pool.prototype, 'end')
    const query = pg.Client.prototype.query as (sql: string) => Promise<unknown>
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, sql: string) {
      if (sql.startsWith('drop database')) return Promise.reject(new Error('drop failed'))
      return query.call(this, sql)
    } as never)

    const error = await failureOf(handle!.close())

    expect(end).toHaveBeenCalledOnce()
    expect(error.message).toContain('drop failed')
    spy.mockRestore()
    await adminQuery(`drop database ${name} with (force)`)
  })

  it('reports both failures when close and drop both fail', async () => {
    const handle = await createTestDatabase('postgres')
    const name = await currentDatabase(handle!)
    failPoolEnd()
    const query = pg.Client.prototype.query as (sql: string) => Promise<unknown>
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, sql: string) {
      if (sql.startsWith('drop database')) return Promise.reject(new Error('drop failed'))
      return query.call(this, sql)
    } as never)

    const error = await failureOf(handle!.close())

    expect(error.message).toContain('close failed')
    expect(error.message).toContain('drop failed')
    spy.mockRestore()
    await adminQuery(`drop database ${name} with (force)`)
  })

  it('ends the admin client when it cannot connect, without the password in the error', async () => {
    process.env.CORRAL_DATABASE_URL = 'postgres://corral:s3cretpw@127.0.0.1:1/corral'
    const end = vi.spyOn(pg.Client.prototype, 'end')

    const error = await failureOf(createTestDatabase('postgres'))

    expect(end).toHaveBeenCalledOnce()
    expect(error.message).toContain('Creating test database')
    expect(printed(error)).not.toContain('s3cretpw')
  })

  it('keeps a failing admin end from hiding the connection failure', async () => {
    process.env.CORRAL_DATABASE_URL = 'postgres://corral:s3cretpw@127.0.0.1:1/corral'
    vi.spyOn(pg.Client.prototype, 'end').mockRejectedValue(new Error('end failed'))

    const error = await failureOf(createTestDatabase('postgres'))

    expect(printed(error)).toContain('ECONNREFUSED')
    expect(printed(error)).toContain('end failed')
  })

  it('does not leak the password of a URL it cannot parse', async () => {
    process.env.CORRAL_DATABASE_URL = 'postgres://corral:s3cret pw@not a host/corral'

    const error = await failureOf(createTestDatabase('postgres'))

    expect(printed(error)).not.toContain('s3cret pw')
    const input = (error.cause as { input?: string }).input
    expect(input).toBe('postgres://corral:***@not a host/corral')
  })
})

async function currentDatabase(handle: NonNullable<Awaited<ReturnType<typeof createTestDatabase>>>): Promise<string> {
  const { sql } = await import('drizzle-orm')
  const { rows } = await handle.db.execute(sql`select current_database() as name`) as unknown as { rows: { name: string }[] }
  return rows[0]!.name
}
