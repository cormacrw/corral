import { describe, expect, it } from 'vitest'
import { approvedPlanSummary, checkPlan, checkPlanEpicDependencies, designPinKey, diffPlans, type DesignPinTarget, type PlanChange, type PlanRef, type ProposedTask } from './plan.ts'
import { checkDefinitionOfReady, type TaskContent } from './ready.ts'

const task = (key: string, overrides: Partial<ProposedTask> = {}): ProposedTask => ({
  key,
  epic: 'e1',
  title: `Task ${key}`,
  description: 'Do the thing',
  type: 'task',
  priority: 'medium',
  humanReview: false,
  acceptanceCriteria: ['It works'],
  dependsOn: [],
  ...overrides
})
const epics = [{ key: 'e1', title: 'Login', summary: '' }]

describe('checkPlan', () => {
  it.each([
    { title: 'Title', description: 'Description', acceptanceCriteria: ['Works'] },
    { title: ' ', description: '\n', acceptanceCriteria: [] },
    { title: '', description: '', acceptanceCriteria: ['Works', ' '] }
  ])('shares stored-task Ready problems for %j and tags each task key', (content: TaskContent) => {
    const storedProblems = checkDefinitionOfReady(content)
    const tasks = ['a', 'b'].map(key => task(key, { ...content, acceptanceCriteria: [...content.acceptanceCriteria] }))
    expect(checkPlan({ title: 'Plan', summary: '', epics, tasks })).toEqual(
      tasks.flatMap(({ key }) => storedProblems.map(code => ({ code, key })))
    )
  })

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
    ['COR-1', { kind: 'task', status: 'backlog', pickedUp: false }],
    ['COR-2', { kind: 'task', status: 'draft', pickedUp: false }],
    ['COR-3', { kind: 'task', status: 'in_progress', pickedUp: true }],
    ['COR-5', { kind: 'task', status: 'ready', pickedUp: false }],
    ['COR-6', { kind: 'task', status: 'ready', pickedUp: true }],
    ['COR-4', { kind: 'deleted' }],
    ['COR-9', { kind: 'unknown' }],
    ['WEB-1', { kind: 'other_project', project: 'Website' }]
  ])

  it('lets a task revise a Backlog task, an unclaimed Ready task or a Draft, and depend on any existing task or on a revised task by its ref', () => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [
      task('a', { ref: 'COR-1', dependsOn: ['COR-3'] }),
      task('b', { ref: 'COR-2', dependsOn: ['COR-1'] }),
      task('c', { dependsOn: ['a', 'b'] }),
      task('d', { ref: 'COR-5' })
    ] }, refs)).toEqual([])
  })

  it.each(['COR-4', 'cor-4'])('rejects ref-shaped task key %s with a clear problem', (key) => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [task(key), task('consumer', { dependsOn: ['COR-4'] })] }, refs))
      .toContainEqual({ code: 'key_shaped_like_ref', key, message: expect.stringContaining('Choose a key') })
  })

  it.each(['COR-3', 'cor-3'])('resolves existing dependency %s regardless of map key case', (dep) => {
    const plan = { title: 'x', summary: '', epics, tasks: [task('a', { dependsOn: [dep] })] }
    expect(checkPlan(plan, refs)).toEqual([])
    expect(checkPlan(plan, new Map([['cor-3', { kind: 'task', status: 'in_progress', pickedUp: true }]]))).toEqual([])
  })

  it('validates lowercase refs and detects duplicate revisions case-insensitively', () => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [task('a', { ref: 'cor-1' }), task('b', { ref: 'COR-1' })] }, refs))
      .toEqual([{ code: 'duplicate_ref', key: 'a', ref: 'cor-1' }])
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [task('a', { dependsOn: ['cor-4'] })] }, refs))
      .toEqual([expect.objectContaining({ code: 'deleted_ref', ref: 'cor-4' })])
  })

  it.each([['COR-1', 'cor-1'], ['cor-1', 'COR-1']])('finds revised-node cycles with ref %s and dependency %s', (ref, dep) => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [task('a', { ref, dependsOn: ['b'] }), task('b', { dependsOn: [dep] })] }, refs))
      .toEqual([{ code: 'dependency', problem: { code: 'cycle', path: ['a', 'b', 'a'] } }])
  })

  it('refuses a Ready task that has been picked up, pointing at update_task, but lets a task depend on it', () => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [task('a', { ref: 'COR-6' }), task('b', { dependsOn: ['COR-6'] })] }, refs)).toEqual([
      { code: 'ref_not_revisable', key: 'a', ref: 'COR-6', status: 'ready', message: expect.stringMatching(/COR-6 has already been picked up.*update_task/) }
    ])
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
      { code: 'ref_not_revisable', key: 'a', ref: 'COR-3', status: 'in_progress', message: expect.stringContaining('only Backlog and unclaimed Ready tasks can be revised') },
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

describe('checkPlan with design pins', () => {
  const designs = new Map<string, DesignPinTarget>([
    ['COR-7@v2', { kind: 'version', status: 'approved' }],
    ['COR-7@v1', { kind: 'version', status: 'superseded' }],
    ['COR-7@v3', { kind: 'version', status: 'submitted' }],
    ['COR-3@v1', { kind: 'not_design', status: 'ready' }]
  ])
  const pinned = (key: string, taskRef: string, version: number, screens = ['login']) => task(key, { design: { taskRef, version, screens } })

  it('keys pins by upper-cased ref and version', () => {
    expect(designPinKey({ taskRef: 'cor-7', version: 2 })).toBe('COR-7@v2')
  })

  it('accepts a pin to an approved version with screens', () => {
    expect(checkPlan({ title: 'x', summary: '', epics, tasks: [pinned('a', 'COR-7', 2, ['login', 'login-error'])] }, new Map(), designs)).toEqual([])
  })

  it('rejects a pin to a version that isn\'t approved, an unknown version, a non-design task, or no screens', () => {
    const problems = checkPlan({
      title: 'x',
      summary: '',
      epics,
      tasks: [pinned('a', 'COR-7', 1), pinned('b', 'COR-7', 3), pinned('c', 'COR-7', 9), pinned('d', 'COR-3', 1), pinned('e', 'COR-7', 2, [])]
    }, new Map(), designs)
    expect(problems.map(p => [p.code, 'key' in p ? p.key : null])).toEqual([
      ['design_not_approved', 'a'],
      ['design_not_approved', 'b'],
      ['design_not_found', 'c'],
      ['design_not_found', 'd'],
      ['design_without_screens', 'e']
    ])
    expect(problems[0]).toMatchObject({ design: 'COR-7 v1', status: 'superseded' })
  })
})

describe('diffPlans', () => {
  it.each(['dependsOn', 'screens'] as const)('compares %s as an unordered multiset without mutating inputs', (field) => {
    const withMembers = (members: string[]) => task('a', field === 'dependsOn'
      ? { dependsOn: members }
      : { design: { taskRef: 'COR-7', version: 2, screens: members } })
    const before = ['a', 'a']
    const after = ['a', 'b']
    expect(diffPlans([withMembers(before)], [withMembers(after)])).toEqual([{ key: 'a', change: 'changed' }])
    expect(diffPlans([withMembers(after)], [withMembers(before)])).toEqual([{ key: 'a', change: 'changed' }])
    expect(diffPlans([withMembers(['a', 'a', 'b'])], [withMembers(['a', 'b', 'b'])])).toEqual([{ key: 'a', change: 'changed' }])
    expect(diffPlans([withMembers(['a', 'b', 'a'])], [withMembers(['b', 'a', 'a'])])).toEqual([{ key: 'a', change: 'unchanged' }])
    expect(before).toEqual(['a', 'a'])
    expect(after).toEqual(['a', 'b'])
  })

  it('preserves acceptance criterion order and normalized design refs', () => {
    expect(diffPlans([task('a', { acceptanceCriteria: ['First', 'Second'] })], [task('a', { acceptanceCriteria: ['Second', 'First'] })])).toEqual([{ key: 'a', change: 'changed' }])
    const pin = { taskRef: 'COR-7', version: 2, screens: ['login'] }
    expect(diffPlans([task('a', { design: pin })], [task('a', { design: { ...pin, taskRef: 'cor-7' } })])).toEqual([{ key: 'a', change: 'unchanged' }])
  })

  it('counts a changed design pin as a change', () => {
    const pin = { taskRef: 'COR-7', version: 2, screens: ['login'] }
    expect(diffPlans([task('a', { design: pin }), task('b', { design: pin })], [task('a', { design: pin }), task('b', { design: { ...pin, screens: ['signup'] } })])).toEqual([
      { key: 'a', change: 'unchanged' },
      { key: 'b', change: 'changed' }
    ])
  })

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

describe('plan epic dependency validation', () => {
  const proposal = {
    title: 'Mobile', summary: '',
    epics: [{ key: 'e1', title: 'Mobile PWA', summary: '' }, { key: 'e2', title: 'Offline', summary: '', dependsOn: ['e1'] }],
    tasks: [task('a'), task('b', { epic: 'e2' })]
  }
  it('accepts keys and reports unknown, self and cyclic epic dependencies by title', () => {
    expect(checkPlan(proposal)).toEqual([])
    for (const [dep, code] of [['missing', 'unknown_dependency'], ['e2', 'self_dependency']] as const) {
      expect(checkPlan({ ...proposal, epics: [proposal.epics[0]!, { ...proposal.epics[1]!, dependsOn: [dep] }] })).toContainEqual({ code: 'epic_dependency', problem: expect.objectContaining({ code }), epics: expect.arrayContaining(['Offline']) })
    }
    expect(checkPlan({ ...proposal, epics: [{ ...proposal.epics[0]!, dependsOn: ['e2'] }, proposal.epics[1]!] })).toContainEqual({ code: 'epic_dependency', problem: expect.objectContaining({ code: 'cycle' }), epics: ['Mobile PWA', 'Offline', 'Mobile PWA'] })
  })
  it('rejects combined task/epic deadlocks with both epic titles', () => {
    expect(checkPlan({ ...proposal, tasks: [task('a', { dependsOn: ['b'] }), task('b', { epic: 'e2' })] })).toContainEqual({ code: 'epic_task_deadlock', path: expect.any(Array), epics: expect.arrayContaining(['Mobile PWA', 'Offline']) })
  })
  it.each(['COR-4', 'cor-4'])('overlays revised nodes and existing refs in the epic graph for %s', (dep) => {
    const context = {
      epics: new Map([['existing', [] as string[]]]), titles: new Map([['existing', 'Existing']]),
      epicIds: new Map<string, string>(), taskIds: new Map<string, string>(), refIds: new Map([['cor-4', 'existing-task']]),
      tasks: [{ type: 'task' as const, id: 'existing-task', epicId: 'existing', status: 'ready' as const, dependsOn: ['plan-task:b'] }]
    }
    const plan = { ...proposal, tasks: [task('b', { dependsOn: [dep] })], epics: [proposal.epics[0]!] }
    expect(checkPlanEpicDependencies(plan, context)).toContainEqual(expect.objectContaining({ code: 'epic_task_deadlock' }))
    // Revising COR-4 replaces its old edges instead of leaving a phantom node.
    plan.tasks.push(task('revision', { ref: 'CoR-4' }))
    expect(checkPlanEpicDependencies(plan, context)).toEqual([])
    plan.tasks[1]!.dependsOn = ['b']
    expect(checkPlanEpicDependencies(plan, context)).toContainEqual(expect.objectContaining({ code: 'epic_task_deadlock' }))
  })

  it('includes existing project tasks and epic edges in the wait graph', () => {
    const context = {
      epics: new Map([['existing', [] as string[]]]), titles: new Map([['existing', 'Existing foundation']]),
      epicIds: new Map<string, string>(), taskIds: new Map<string, string>(), refIds: new Map([['COR-1', 'existing-task']]),
      tasks: [{ type: 'task' as const, id: 'existing-task', epicId: 'existing', status: 'ready' as const, dependsOn: [] as string[] }]
    }
    const plan = { ...proposal, epics: [{ ...proposal.epics[0]!, dependsOn: ['existing'] }, proposal.epics[1]!] }
    expect(checkPlan(plan, new Map(), new Map(), context)).toEqual([])
    context.tasks[0]!.dependsOn = ['plan-task:b']
    expect(checkPlan(plan, new Map(), new Map(), context)).toContainEqual(expect.objectContaining({ code: 'epic_task_deadlock', epics: expect.arrayContaining(['Existing foundation', 'Mobile PWA', 'Offline']) }))
  })
})

describe('approvedPlanSummary', () => {
  const item = (status: string | null, change: PlanChange = 'added') => ({ change, status })

  it('says where the tasks are', () => {
    expect(approvedPlanSummary([item('ready'), item('ready')])).toBe('2 tasks on the board')
    expect(approvedPlanSummary([item('backlog')])).toBe('1 task in the Backlog')
  })

  it('does not report a revised Ready task as moved to the Backlog', () => {
    expect(approvedPlanSummary([item('backlog'), item('backlog'), item('backlog'), item('ready', 'changed')])).toBe('3 tasks in the Backlog, 1 on the board')
  })

  it('leaves out removed and deleted tasks', () => {
    expect(approvedPlanSummary([item('ready'), item('ready', 'removed'), item(null)])).toBe('1 task on the board')
  })
})
