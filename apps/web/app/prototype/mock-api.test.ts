import { describe, expect, it } from 'vitest'
import { mockCall } from './mock-api'

describe('prototype mock API', () => {
  it('answers everything the shell loads at startup', async () => {
    for (const path of ['/projects', '/agents', '/runner', '/status', '/inbox', '/plan/sessions', '/me']) {
      await expect(mockCall('GET', path), path).resolves.toBeTruthy()
    }
  })
})
