import { describe, expect, it } from 'vitest'
import { failedMergeGates, MERGE_GATES, type MergeGateFacts } from './merge-gates.ts'

const passing: MergeGateFacts = {
  approvalIsForHeadCommit: true,
  requiredChecksPassed: true,
  evidenceComplete: true,
  mergeable: true
}

describe('failedMergeGates', () => {
  it('returns nothing when every gate passes', () => {
    expect(failedMergeGates(passing)).toEqual([])
  })

  it('reports equal facts the same way whatever their key order', () => {
    const facts: MergeGateFacts = { ...passing, approvalIsForHeadCommit: false, evidenceComplete: false, mergeable: false }
    const reversed = Object.fromEntries(Object.entries(facts).reverse()) as unknown as MergeGateFacts

    expect(Object.keys(reversed)).not.toEqual(Object.keys(facts))
    expect(failedMergeGates(reversed)).toEqual(['approvalIsForHeadCommit', 'evidenceComplete', 'mergeable'])
    expect(failedMergeGates(reversed)).toEqual(failedMergeGates(facts))
  })

  it('lists each gate exactly once', () => {
    expect([...MERGE_GATES].sort()).toEqual(Object.keys(passing).sort())
  })
})
