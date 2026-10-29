import { describe, expect, it } from 'vitest'
import { checkPlan, diffPlans, type PlanRef, type ProposedTask } from './plan.ts'

const task = (key: string, overrides: Partial<ProposedTask> = {}): ProposedTask => ({
  key,
  epic: 'e1',
  title: `Task ${key}`,
  description: 'Do the thing',
  type: 'backend',
  priority: 'medium',
  humanReview: false,
  acceptanceCriteria: ['It works'],
  dependsOn: [],
  ...overrides
})
const epics = [{ key: 'e1', title: 'Login', summary: '' }]

describe('checkPlan', () => {
  it('accepts a DAG where every task has criteria', () => {
    expect(checkPlan({ title: 'Login', summary: '', epics, tasks: [task('a'), task('b', { dependsOn: ['a'] })] })).toEqual([])
  })

  it('rejects an empty plan', () => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [] })).toEqual([{ code: 'no_tasks' }])
  })

  it('reports every problem at once', () => {
    const problems = checkPlan({
      title: 'x',
      summary: '',
      epics,
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

  it('checks that epics are distinct, named, used, and the ones tasks name', () => {
    const problems = checkPlan({
      title: 'x',
      summary: '',
      epics: [{ key: 'e1', title: 'Login', summary: '' }, { key: 'e1', title: ' ', summary: '' }, { key: 'e2', title: 'Billing', summary: '' }],
      tasks: [task('a'), task('b', { epic: 'e9' })]
    })
    expect(problems).toEqual([
      { code: 'duplicate_epic_key', key: 'e1' },
      { code: 'missing_epic_title', key: 'e1' },
      { code: 'empty_epic', key: 'e2' },
      { code: 'unknown_epic', key: 'b', epic: 'e9' }
    ])
  })
})

describe('checkPlan without epics', () => {
  it('accepts tasks with no epic, with or without epics in the plan', () => {
    expect(checkPlan({ title: 'Fix', summary: '', epics: [], tasks: [task('a', { epic: undefined })] })).toEqual([])
    expect(checkPlan({ title: 'Login', summary: '', epics, tasks: [task('a'), task('b', { epic: undefined })] })).toEqual([])
  })

  it('still rejects an unknown epic key and an epic no task names', () => {
    expect(checkPlan({ title: 'x', summary: '', epics: [], tasks: [task('a', { epic: 'e9' })] })).toEqual([{ code: 'unknown_epic', key: 'a', epic: 'e9' }])
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [task('a', { epic: undefined })] })).toEqual([{ code: 'empty_epic', key: 'e1' }])
  })
})

describe('checkPlan with refs', () => {
  const refs = new Map<string, PlanRef>([
    ['COR-1', { kind: 'task', status: 'backlog' }],
    ['COR-2', { kind: 'task', status: 'draft' }],
    ['COR-3', { kind: 'task', status: 'in_progress' }],
    ['COR-4', { kind: 'deleted' }],
    ['COR-9', { kind: 'unknown' }],
    ['WEB-1', { kind: 'other_project', project: 'Website' }]
  ])

  it('lets a task revise a Backlog task or a Draft, and depend on any existing task or on a revised task by its ref', () => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [
      task('a', { ref: 'COR-1', dependsOn: ['COR-3'] }),
      task('b', { ref: 'COR-2', dependsOn: ['COR-1'] }),
      task('c', { dependsOn: ['a', 'b'] })
    ] }, refs)).toEqual([])
  })

  it('says why each ref it can\'t revise is wrong', () => {
    const problems = checkPlan({ title: 'x', summary: '', epics, tasks: [
      task('a', { ref: 'COR-3' }),
      task('b', { ref: 'COR-4' }),
      task('c', { ref: 'COR-9' }),
      task('d', { ref: 'WEB-1' }),
      task('e', { ref: 'COR-1' }),
      task('f', { ref: 'COR-1' })
    ] }, refs)
    expect(problems).toEqual([
      { code: 'ref_not_revisable', key: 'a', ref: 'COR-3', status: 'in_progress', message: expect.stringContaining('only Backlog tasks can be revised') },
      { code: 'deleted_ref', key: 'b', ref: 'COR-4', message: expect.stringContaining('COR-4 was deleted') },
      { code: 'unknown_ref', key: 'c', ref: 'COR-9', message: expect.stringContaining('There is no task COR-9 in this project') },
      { code: 'ref_in_other_project', key: 'd', ref: 'WEB-1', project: 'Website', message: expect.stringContaining('belongs to the project "Website"') },
      { code: 'duplicate_ref', key: 'e', ref: 'COR-1' }
    ])
  })

  it('rejects a dependency on a deleted or unknown task, and finds cycles through a revised task\'s ref', () => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [task('a', { dependsOn: ['COR-4', 'COR-9'] })] }, refs)).toEqual([
      expect.objectContaining({ code: 'deleted_ref', key: 'a', ref: 'COR-4' }),
      expect.objectContaining({ code: 'unknown_ref', key: 'a', ref: 'COR-9' })
    ])
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [task('a', { ref: 'COR-1', dependsOn: ['b'] }), task('b', { dependsOn: ['COR-1'] })] }, refs))
      .toEqual([{ code: 'dependency', problem: { code: 'cycle', path: ['a', 'b', 'a'] } }])
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

  it('counts a move to another epic as a change', () => {
    expect(diffPlans([task('a')], [task('a', { epic: 'e2' })])).toEqual([{ key: 'a', change: 'changed' }])
    expect(diffPlans([task('a')], [task('a', { epic: undefined })])).toEqual([{ key: 'a', change: 'changed' }])
    expect(diffPlans([task('a', { epic: undefined })], [task('a', { epic: undefined })])).toEqual([{ key: 'a', change: 'unchanged' }])
  })
})
