import { afterEach, expect, it, vi } from 'vitest'
import { requireDatabase } from './testing.ts'

afterEach(() => vi.unstubAllEnvs())

it('reads opt-in at execution even when imported before the URL changes', () => {
  const context = { skip: vi.fn<(_: string | boolean | undefined) => never>(() => {
    throw new Error('skipped')
  }) }
  vi.stubEnv('CORRAL_DATABASE_URL', undefined)
  expect(() => requireDatabase('postgres', context)).toThrow('skipped')
  expect(context.skip).toHaveBeenCalledOnce()
  context.skip.mockClear()
  vi.stubEnv('CORRAL_DATABASE_URL', 'postgres://localhost/ci')
  requireDatabase('postgres', context)
  expect(context.skip).not.toHaveBeenCalled()
  vi.stubEnv('CORRAL_DATABASE_URL', undefined)
  requireDatabase('pglite', context)
  expect(context.skip).not.toHaveBeenCalled()
})
