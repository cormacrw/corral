import { describe, expect, it } from 'vitest'
import { normalizeProposedPlan, proposedPlanInput } from './plan.ts'

const task = { key: 't1', title: ' Build ', description: ' Ship ', type: 'design', acceptanceCriteria: [' Works '], dependsOn: ['cor-2', 'cor-3'] }
const parse = (input: unknown) => normalizeProposedPlan(proposedPlanInput.parse(input))

describe('proposed plan boundary', () => {
  it('normalizes current and legacy defaults identically, preserving keys before refs', () => {
    const legacy = { title: ' Plan ', tasks: [task, { ...task, key: 'cor-3', dependsOn: [] }] }
    const current = { ...legacy, summary: '', parents: [], tasks: legacy.tasks.map(t => ({ ...t, priority: 'medium', humanReview: false })) }
    expect(parse(legacy)).toEqual(parse(current))
    expect(parse(legacy).tasks[0]).toMatchObject({ title: 'Build', description: 'Ship', priority: 'medium', humanReview: true, acceptanceCriteria: ['Works'], dependsOn: ['COR-2', 'cor-3'] })
  })

  it('retains revision semantics and normalizes design refs', () => {
    const result = parse({ title: 'Plan', parents: [{ key: 'e', title: 'Parent' }], tasks: [{ ...task, ref: ' cor-4 ', parent: '', design: { taskRef: ' cor-8 ', version: 2 } }] })
    expect(result.epics[0]!.dependsOn).toBeUndefined()
    expect(result.tasks[0]).toMatchObject({ ref: 'COR-4', epic: undefined, design: { taskRef: 'COR-8', version: 2, screens: [] } })
  })
})
