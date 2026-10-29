import type { PullRequestStatus } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { ciCell, evidenceCell, mergeCell, rebaseCell, reviewCell } from './pull-requests.ts'

const review = (verdict: 'approved' | 'changes_requested', forHeadCommit = true): PullRequestStatus['review'] =>
  ({ verdict, headSha: 'abcdef1234', forHeadCommit, createdAt: '2026-10-29T12:00:00Z' })

describe('pull request cells', () => {
  it('shows the review verdict, and when it was for an older commit', () => {
    expect(reviewCell({ review: null }).label).toBe('Not reviewed')
    expect(reviewCell({ review: review('approved') })).toEqual({ label: 'Approved', color: 'success' })
    expect(reviewCell({ review: review('changes_requested') }).color).toBe('error')
    expect(reviewCell({ review: review('approved', false) })).toMatchObject({ color: 'neutral', detail: 'For an older commit (abcdef1)' })
  })

  it('summarises CI over the required checks', () => {
    expect(ciCell({ ci: { status: 'passing', checks: [] } }).label).toBe('No required checks')
    const checks = [{ name: 'lint', conclusion: 'success' as const, url: null }, { name: 'test', conclusion: 'failure' as const, url: null }]
    expect(ciCell({ ci: { status: 'failing', checks } })).toEqual({ label: 'Failing', color: 'error', detail: 'lint: success, test: failure' })
    expect(ciCell({ ci: { status: 'pending', checks } }).label).toBe('Pending')
  })

  it('names the rebase state', () => {
    const branch = (rebase: PullRequestStatus['branch']['rebase']) => ({ branch: { name: 'b', mergeable: true, mergeableState: 'clean', upToDate: true, rebase } })
    expect(rebaseCell(branch('not_needed')).label).toBe('Up to date')
    expect(rebaseCell(branch('needed')).label).toBe('Behind base')
    expect(rebaseCell(branch('requested')).label).toBe('Updating')
    expect(rebaseCell(branch('conflict')).label).toBe('Conflicts')
  })

  it('shows evidence completeness', () => {
    expect(evidenceCell({ evidenceComplete: true }).label).toBe('Complete')
    expect(evidenceCell({ evidenceComplete: false }).label).toBe('Incomplete')
  })

  it('says which gate blocks an ineligible PR, and lists the others', () => {
    expect(mergeCell({ merge: { eligible: false, failingGate: 'requiredChecksPassed', failedGates: ['requiredChecksPassed'] }, humanReviewOutstanding: false }))
      .toEqual({ label: 'Required checks haven’t passed', color: 'error', detail: undefined })
    expect(mergeCell({ merge: { eligible: false, failingGate: 'approvalIsForHeadCommit', failedGates: ['approvalIsForHeadCommit', 'evidenceComplete'] }, humanReviewOutstanding: false }))
      .toEqual({ label: 'No approval for the head commit', color: 'error', detail: 'Also: evidence is incomplete' })
  })

  it('shows an eligible PR as eligible, or waiting when human review is outstanding', () => {
    const merge = { eligible: true, failingGate: null, failedGates: [] }
    expect(mergeCell({ merge, humanReviewOutstanding: false })).toEqual({ label: 'Eligible', color: 'success' })
    expect(mergeCell({ merge, humanReviewOutstanding: true }).label).toBe('Waiting for human review')
  })
})
