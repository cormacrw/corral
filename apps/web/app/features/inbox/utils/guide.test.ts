import type { PullRequestDetail, PullRequestGuide } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { guideSteps, hunkCount } from './guide'

const pr = {
  number: 1, url: 'https://github.com/o/r/pull/1', title: 'T', body: '', baseBranch: 'main', headBranch: 'x', headSha: 'sha', totalFiles: 3, truncated: true,
  files: [
    { path: 'a.ts', status: 'modified', additions: 2, deletions: 0, patch: '@@ -1 +1 @@\n+a0\n@@ -9 +9 @@\n+a1' },
    { path: 'b.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+b0' }
  ]
} satisfies PullRequestDetail

const guide = (steps: PullRequestGuide['steps']): PullRequestGuide => ({ status: 'ready', headSha: 'sha', steps, error: null, generatedAt: '2026-11-05T00:00:00Z' })

describe('guideSteps', () => {
  it('puts every shown hunk in exactly one step, with the rest in Other changes', () => {
    const steps = guideSteps(pr, guide([
      { id: 's1', title: 'Core', why: 'w', criterionIds: ['c1', 'gone'], hunks: [{ path: 'a.ts', hunk: 1 }] },
      { id: 's2', title: 'Again', why: 'w', criterionIds: [], hunks: [{ path: 'a.ts', hunk: 1 }, { path: 'cut.ts', hunk: 0 }] }
    ]), [{ id: 'c1', text: 'It works' }])
    expect(steps.map(s => [s.id, s.criteria, s.hunks.map(h => [h.path, h.index, h.lines?.[1] ?? null])])).toEqual([
      ['s1', ['It works'], [['a.ts', 1, '+a1']]],
      ['s2', [], [['cut.ts', 0, null]]],
      ['other', [], [['a.ts', 0, '+a0'], ['b.ts', 0, '+b0']]]
    ])
    const shown = steps.flatMap(s => s.hunks.filter(h => h.lines).map(h => `${h.path}#${h.index}`))
    expect(shown.sort()).toEqual(['a.ts#0', 'a.ts#1', 'b.ts#0'])
    expect(hunkCount(pr)).toBe(3)
  })

  it('adds no Other changes when the steps cover every hunk', () => {
    const steps = guideSteps(pr, guide([{ id: 's1', title: 'All', why: 'w', criterionIds: [], hunks: [{ path: 'a.ts', hunk: 0 }, { path: 'a.ts', hunk: 1 }, { path: 'b.ts', hunk: 0 }] }]), [])
    expect(steps.map(s => s.id)).toEqual(['s1'])
  })
  it('marks the last hunk of a file the line cap cut partway', () => {
    // b.ts has 3 changed lines but its patch kept only the first hunk and one line of the second
    const cut = { ...pr, files: [pr.files[0]!, { path: 'b.ts', status: 'modified' as const, additions: 3, deletions: 0, patch: '@@ -1 +1 @@\n+b0\n@@ -9 +9,2 @@\n+b1' }] }
    const steps = guideSteps(cut, guide([{ id: 's1', title: 'B', why: 'w', criterionIds: [], hunks: [{ path: 'b.ts', hunk: 1 }, { path: 'b.ts', hunk: 0 }] }]), [])
    expect(steps[0]!.hunks.map(h => [h.index, h.partial])).toEqual([[1, true], [0, false]])
    expect(steps.at(-1)!.hunks.every(h => !h.partial)).toBe(true)
    expect(guideSteps({ ...cut, truncated: false }, guide([]), []).flatMap(s => s.hunks).some(h => h.partial)).toBe(false)
  })
})
