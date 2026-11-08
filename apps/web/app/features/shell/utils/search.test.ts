import type { Agent, Project } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { searchPages } from '~/features/shell/utils/search.ts'

const projects = [{ id: 'p1', slug: 'corral', name: 'Corral' }] as Project[]
const agents = [{ id: 'a1', name: 'Atlas', role: 'developer' }] as Agent[]

describe('searchPages', () => {
  it('goes to each project\'s pages and each agent', () => {
    const to = searchPages(projects, agents).map(p => p.to)
    expect(to).toEqual(expect.arrayContaining(['/projects/corral', '/projects/corral/board', '/projects/corral/backlog', '/agents/atlas']))
  })
})
