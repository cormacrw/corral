import { describe, expect, it } from 'vitest'
import { parseIncludedResponse, toRepoSummary } from './jobs.ts'

describe('parseIncludedResponse', () => {
  it('reads the status and JSON body from `gh api --include`', () => {
    const output = 'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"number":41}'
    expect(parseIncludedResponse(output)).toEqual({ status: 201, body: { number: 41 } })
  })

  it('keeps an error body for 4xx responses', () => {
    const output = 'HTTP/2.0 422 Unprocessable Entity\nContent-Type: application/json\n\n{"message":"Validation Failed"}'
    expect(parseIncludedResponse(output)).toEqual({ status: 422, body: { message: 'Validation Failed' } })
  })

  it('handles an empty body', () => {
    expect(parseIncludedResponse('HTTP/2.0 204 No Content\n\n')).toEqual({ status: 204, body: null })
  })

  it('returns null when there is no response', () => {
    expect(parseIncludedResponse('')).toBeNull()
  })
})

describe('toRepoSummary', () => {
  const repo = { full_name: 'cormac/corral', description: null, private: true, updated_at: '2026-10-27T10:00:00Z', default_branch: 'main' }

  it('can push with write, maintain or admin access', () => {
    expect(toRepoSummary({ ...repo, permissions: { push: true } }).canPush).toBe(true)
    expect(toRepoSummary({ ...repo, permissions: { admin: true } }).canPush).toBe(true)
    expect(toRepoSummary({ ...repo, permissions: { push: false } }).canPush).toBe(false)
  })
})
