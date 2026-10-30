import { describe, expect, it } from 'vitest'
import { checkEpicDependencies, type EpicDependencyTask } from './epic-dependencies.ts'

const titles = new Map([['a', 'Foundation'], ['b', 'Application'], ['c', 'Release']])
const task = (id: string, epicId: string | null, dependsOn: string[] = []): EpicDependencyTask => ({ type: 'task', id, epicId, dependsOn, status: 'ready' })

describe('epic dependency validation', () => {
  it('names epics in cycles and self dependencies', () => {
    expect(checkEpicDependencies(new Map([['a', ['b']], ['b', ['a']]]), [], titles))
      .toContainEqual(expect.objectContaining({ epics: ['Foundation', 'Application', 'Foundation'] }))
    expect(checkEpicDependencies(new Map([['a', ['a']]]), [], titles)[0]?.epics).toEqual(['Foundation'])
  })

  it('rejects mixed task and epic deadlocks, including indirect task paths', () => {
    const graph = new Map([['a', []], ['b', ['a']], ['c', []]])
    for (const tasks of [
      [task('one', 'a', ['two']), task('two', 'b')],
      [task('one', 'a', ['middle']), task('middle', null, ['two']), task('two', 'b')]
    ]) {
      const [problem] = checkEpicDependencies(graph, tasks, titles)
      expect(problem?.code).toBe('epic_task_deadlock')
      expect(problem?.epics).toEqual(expect.arrayContaining(['Foundation', 'Application']))
    }
  })

  it('allows task edges between epics when the actual wait graph has no cycle', () => {
    expect(checkEpicDependencies(new Map([['a', []], ['b', []]]), [
      task('a1', 'a', ['b1']), task('b1', 'b'), task('b2', 'b', ['a2']), task('a2', 'a')
    ])).toEqual([])
  })

  it('ignores deleted and merged tasks and excludes Draft and Backlog from completion', () => {
    const graph = new Map([['a', []], ['b', ['a']]])
    for (const override of [{ status: 'draft' }, { status: 'backlog' }, { status: 'merged' }, { type: 'design', status: 'approved' }, { deleted: true }] as const) {
      expect(checkEpicDependencies(graph, [{ ...task('one', 'a', ['two']), ...override }, task('two', 'b')])).toEqual([])
    }
    expect(checkEpicDependencies(graph, [task('two', 'b')])).toEqual([])
  })
})
