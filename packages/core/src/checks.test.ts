import { describe, expect, it } from 'vitest'
import { deletionFor } from './deletion.ts'
import { checkDependencies, findCycle } from './dependencies.ts'
import { checkDefinitionOfReady } from './ready.ts'

describe('checkDefinitionOfReady', () => {
  it('passes a complete task', () => {
    expect(checkDefinitionOfReady({ title: 'T', description: 'D', acceptanceCriteria: ['C'] })).toEqual([])
  })

  it('reports every missing part', () => {
    expect(checkDefinitionOfReady({ title: ' ', description: '', acceptanceCriteria: [] }))
      .toEqual(['missing_title', 'missing_description', 'missing_acceptance_criteria'])
  })

  it('rejects a blank criterion', () => {
    expect(checkDefinitionOfReady({ title: 'T', description: 'D', acceptanceCriteria: ['C', ''] }))
      .toEqual(['blank_acceptance_criterion'])
  })
})

describe('checkDependencies', () => {
  const graph = (edges: Record<string, string[]>) => new Map(Object.entries(edges))

  it('accepts a DAG', () => {
    expect(checkDependencies(graph({ a: [], b: ['a'], c: ['a', 'b'] }))).toEqual([])
  })

  it('finds a cycle', () => {
    expect(checkDependencies(graph({ a: ['c'], b: ['a'], c: ['b'] })))
      .toEqual([{ code: 'cycle', path: ['a', 'c', 'b', 'a'] }])
  })

  it('reports self and unknown dependencies separately from cycles', () => {
    expect(checkDependencies(graph({ a: ['a', 'x'], b: ['c'], c: ['b'] }))).toEqual([
      { code: 'self_dependency', taskId: 'a' },
      { code: 'unknown_dependency', taskId: 'a', dependsOn: 'x' },
      { code: 'cycle', path: ['b', 'c', 'b'] }
    ])
  })

  it('handles a long chain without overflowing the stack', () => {
    const edges = new Map<string, string[]>()
    for (let i = 0; i < 100_000; i++) edges.set(`t${i}`, i === 0 ? [] : [`t${i - 1}`])
    expect(findCycle(edges)).toBeNull()
  })
})

describe('deletionFor', () => {
  it('follows D10', () => {
    expect(deletionFor('backlog')).toBe('hard')
    expect(deletionFor('in_progress')).toBe('soft')
    expect(deletionFor('blocked')).toBe('soft')
    expect(deletionFor('merged')).toBe('not_allowed')
  })
})
