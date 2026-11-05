import { describe, expect, it } from 'vitest'
import { shellTitle } from '~/features/shell/utils/shell'

const projects = [{ slug: 'corral', name: 'Corral' }]
const agents = [{ name: 'Atlas' }]
const title = (path: string) => shellTitle(path, projects, agents)

describe('shellTitle', () => {
  it('names a project, task or agent from the path', () => {
    expect(title('/projects/corral')).toBe('Corral')
    expect(title('/projects/corral/board')).toContain('Corral')
    expect(title('/tasks/COR-3')).toBe('COR-3')
    expect(title('/agents/atlas/run-1')).toBe('Atlas')
  })

  it('falls back to the slug for a project that isn\'t loaded, and never echoes an unknown agent', () => {
    expect(title('/projects/gone/backlog')).toContain('gone')
    expect(title('/agents/nobody')).not.toContain('nobody')
  })

  it('titles nested pages after their section', () => {
    expect(title('/plan/session-1')).toBe(title('/plan'))
    expect(title('/inbox/item-1')).toBe(title('/inbox'))
  })
})
