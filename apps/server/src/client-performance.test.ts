import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp('pglite')
})
afterAll(async () => {
  await t?.close()
})

it('accepts a beacon batch and rejects invalid batches atomically', async () => {
  const sessionId = crypto.randomUUID()
  const sample = { name: '/tasks/[ref]', metric: 'navigation', value: 123.5 }
  const valid = { sessionId, samples: [sample] }
  expect((await t.request('POST', '/api/perf/client', valid)).status).toBe(204)
  await t.performance.flush()
  const pages = () => t.db.select().from(schema.perfSamples).where(eq(schema.perfSamples.kind, 'page'))
  expect(await pages()).toMatchObject([{ name: '/tasks/[ref]', metric: 'navigation', durationMs: 123.5, sessionId }])
  for (const body of [
    { ...valid, samples: [sample, { ...sample, value: -1 }] },
    { ...valid, samples: [{ ...sample, name: '/tasks/SECRET-1' }] },
    { ...valid, samples: Array.from({ length: 51 }, () => sample) },
    { ...valid, extra: 'x'.repeat(33 * 1024) },
    new Blob(['{broken'], { type: 'application/json' })
  ]) {
    expect((await t.request('POST', '/api/perf/client', body)).status).toBe(400)
    await t.performance.flush()
    expect(await pages()).toHaveLength(1)
    expect(await t.db.select().from(schema.perfSamples)).toHaveLength(1)
  }
})
