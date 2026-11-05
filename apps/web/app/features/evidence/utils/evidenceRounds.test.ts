import type { Evidence } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { currentEvidence, evidenceRounds } from '~/features/evidence/utils/evidenceRounds'

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute)).toISOString()
const item = (id: string, criterionId: string | null, runId: string, round: number, minute: number): Evidence =>
  ({ id, taskId: 't', criterionId, runId, round, note: id, createdAt: at(minute), kind: 'note', fileName: null, contentType: null, size: 0, url: null })
const ids = (items: Evidence[]) => items.map(e => e.id)

describe('evidenceRounds', () => {
  it('shows the latest run per criterion and keeps older items by round, newest first', () => {
    const rounds = evidenceRounds([
      item('a1', 'a', 'r1', 0, 0), item('b1', 'b', 'r1', 0, 1), item('t1', null, 'r1', 0, 2),
      item('a2', 'a', 'r2', 1, 10), item('t2', null, 'r2', 1, 11),
      item('a3', 'a', 'r3', 2, 20)
    ])
    expect(rounds.group('a')).toMatchObject({ carriedFrom: null, earlierCount: 2 })
    expect(ids(rounds.group('a').current)).toEqual(['a3'])
    expect(rounds.group('a').earlier.map(r => [r.round, ids(r.items)])).toEqual([[1, ['a2']], [0, ['a1']]])
    // The latest run attached nothing here: round 1's stays, marked as such
    expect(rounds.group('b')).toMatchObject({ carriedFrom: 0, earlierCount: 0 })
    expect(ids(rounds.group('b').current)).toEqual(['b1'])
    expect(rounds.group(null)).toMatchObject({ carriedFrom: 1, earlierCount: 1 })
    expect(ids(rounds.current)).toEqual(['b1', 't2', 'a3'])
  })

  it('treats two runs in one round as separate submissions', () => {
    const evidence = [item('old', 'a', 'r1', 1, 0), item('new', 'a', 'r2', 1, 5)]
    const group = evidenceRounds(evidence).group('a')
    expect(ids(group.current)).toEqual(['new'])
    expect(group.earlier.map(r => [r.round, ids(r.items)])).toEqual([[1, ['old']]])
    expect(ids(currentEvidence(evidence))).toEqual(['new'])
  })

  it('orders runs by when they attached, not by the order given', () => {
    const group = evidenceRounds([item('new', 'a', 'r2', 1, 9), item('old', 'a', 'r1', 0, 1)]).group('a')
    expect(ids(group.current)).toEqual(['new'])
  })

  it('leaves a single run as it is', () => {
    const evidence = [item('a', 'a', 'r', 0, 0), item('b', 'b', 'r', 0, 1)]
    const rounds = evidenceRounds(evidence)
    expect(rounds.group('a')).toMatchObject({ carriedFrom: null, earlierCount: 0, earlier: [] })
    expect(ids(rounds.current)).toEqual(['a', 'b'])
    expect(rounds.group('missing').current).toEqual([])
  })
})
