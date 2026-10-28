import { describe, expect, it } from 'vitest'
import { checkPlan, diffPlans, type ProposedTask } from './plan.ts'

const task = (key: string, overrides: Partial<ProposedTask> = {}): ProposedTask => ({
  key,
  title: `Task ${key}`,
  description: 'Do the thing',
  type: 'backend',
  priority: 'medium',
  humanReview: false,
  acceptanceCriteria: ['It works'],
  dependsOn: [],
  ...overrides
})

describe('checkPlan', () => {
  it('accepts a DAG where every task has criteria', () => {
    expect(checkPlan({ title: 'Login', summary: '', tasks: [task('a'), task('b', { dependsOn: ['a'] })] })).toEqual([])
  })

  it('rejects an empty plan', () => {
    expect(checkPlan({ title: 'x', summary: '', tasks: [] })).toEqual([{ code: 'no_tasks' }])
  })

  it('reports every problem at once', () => {
    const problems = checkPlan({
      title: 'x',
      summary: '',
      tasks: [
        task('a', { acceptanceCriteria: [], dependsOn: ['b'] }),
        task('b', { title: ' ', dependsOn: ['a'] }),
        task('b', { description: '', dependsOn: ['a'] }),
        task('c', { acceptanceCriteria: [' '], dependsOn: ['zz'] })
      ]
    })
    expect(problems).toEqual(expect.arrayContaining([
      { code: 'missing_acceptance_criteria', key: 'a' },
      { code: 'missing_title', key: 'b' },
      { code: 'duplicate_key', key: 'b' },
      { code: 'missing_description', key: 'b' },
      { code: 'blank_acceptance_criterion', key: 'c' },
      { code: 'dependency', problem: { code: 'unknown_dependency', taskId: 'c', dependsOn: 'zz' } },
      { code: 'dependency', problem: { code: 'cycle', path: ['a', 'b', 'a'] } }
    ]))
  })
})

describe('diffPlans', () => {
  it('marks added, changed, unchanged and removed tasks by key', () => {
    const v1 = [task('a'), task('b'), task('c')]
    const v2 = [task('a'), task('b', { acceptanceCriteria: ['It works', 'It is fast'] }), task('d')]
    expect(diffPlans(v1, v2)).toEqual([
      { key: 'a', change: 'unchanged' },
      { key: 'b', change: 'changed' },
      { key: 'd', change: 'added' },
      { key: 'c', change: 'removed' }
    ])
  })
})
