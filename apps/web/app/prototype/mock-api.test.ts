import { describe, expect, it } from 'vitest'
import { mockCall } from './mock-api'

describe('prototype mock API', () => {
  it('answers everything the shell loads at startup', async () => {
    for (const key of ['GET /projects', 'GET /agents', 'GET /runner', 'GET /status', 'GET /inbox', 'GET /plan/sessions', 'GET /me'] as const) {
      await expect(mockCall(key), key).resolves.toBeTruthy()
    }
  })
})
