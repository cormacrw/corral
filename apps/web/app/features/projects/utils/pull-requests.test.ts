import type { PullRequestStatus } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { MERGE_GATE, mergeCell, reviewCell } from '~/features/projects/utils/pull-requests.ts'

const review = (verdict: 'approved' | 'changes_requested', forHeadCommit = true): PullRequestStatus['review'] =>
  ({ verdict, headSha: 'abcdef1234', forHeadCommit, createdAt: '2026-10-29T12:00:00Z' })

describe('pull request cells', () => {
  it('marks an approval for an older commit apart from a current one, naming the commit', () => {
    const stale = reviewCell({ review: review('approved', false) })
    expect(stale).not.toEqual(reviewCell({ review: review('approved') }))
    expect(stale.detail).toContain('abcdef1')
    expect(reviewCell({ review: review('approved') }).detail).toBeUndefined()
  })

  it('names the gate that blocks an ineligible PR, and lists only the others', () => {
    const one = mergeCell({ merge: { eligible: false, failingGate: 'requiredChecksPassed', failedGates: ['requiredChecksPassed'] }, humanReviewOutstanding: false })
    expect(one.label).toBe(MERGE_GATE.requiredChecksPassed)
    expect(one.detail).toBeUndefined()
    const two = mergeCell({ merge: { eligible: false, failingGate: 'approvalIsForHeadCommit', failedGates: ['approvalIsForHeadCommit', 'evidenceComplete'] }, humanReviewOutstanding: false })
    expect(two.label).toBe(MERGE_GATE.approvalIsForHeadCommit)
    expect(two.detail).toContain(MERGE_GATE.evidenceComplete.toLowerCase())
    expect(two.detail).not.toContain(MERGE_GATE.approvalIsForHeadCommit.toLowerCase())
  })

  it('tells an eligible PR from one still waiting on human review', () => {
    const merge = { eligible: true, failingGate: null, failedGates: [] }
    expect(mergeCell({ merge, humanReviewOutstanding: true })).not.toEqual(mergeCell({ merge, humanReviewOutstanding: false }))
  })
})
