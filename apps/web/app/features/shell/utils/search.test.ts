import type { Agent, PlanSession, Project, Task } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { highlight, mobileSearch, searchPages } from '~/features/shell/utils/search.ts'

const projects = [{ id: 'p1', slug: 'corral', name: 'Corral' }] as Project[]
const agents = [{ id: 'a1', name: 'Atlas', role: 'developer' }] as Agent[]
const tasks = [
  { id: 't1', ref: 'COR-1', title: 'Billing export' },
  { id: 't2', ref: 'COR-2', title: 'Billing page' },
  { id: 't3', ref: 'COR-3', title: 'Login form' }
] as Task[]
const planSessions = [{ id: 's1', title: 'Search filters' }] as PlanSession[]
const data = { projects, agents, tasks, epics: [], planSessions }

describe('mobileSearch', () => {
  it('offers only pages to go to before you type', () => {
    const results = mobileSearch('  ', data, 3)
    expect(results.pages).toHaveLength(3)
    expect(results.epics).toEqual([])
    expect(results.tasks).toEqual([])
    expect(results.sessions).toEqual([])
  })

  it('matches pages, tasks by title or ref, and Plan sessions case-insensitively', () => {
    expect(mobileSearch('CORRAL', data).pages.some(p => p.to === '/projects/corral/board')).toBe(true)
    expect(mobileSearch('login FORM', data).tasks.map(t => t.ref)).toEqual(['COR-3'])
    expect(mobileSearch('cor-2', data).tasks.map(t => t.ref)).toEqual(['COR-2'])
    expect(mobileSearch('search', data).sessions).toEqual(planSessions)
  })

  it('caps each group', () => {
    expect(mobileSearch('billing', data, 1).tasks).toHaveLength(1)
    expect(mobileSearch('corral', data, 2).pages).toHaveLength(2)
  })
})

describe('searchPages', () => {
  it('goes to each project\'s pages and each agent', () => {
    const to = searchPages(projects, agents).map(p => p.to)
    expect(to).toEqual(expect.arrayContaining(['/projects/corral', '/projects/corral/board', '/projects/corral/backlog', '/agents/atlas']))
  })
})

describe('highlight', () => {
  it('splits around the first match, keeping the original case', () => {
    expect(highlight('Billing settings page', 'BILL')).toEqual({ before: '', match: 'Bill', after: 'ing settings page' })
    expect(highlight('Add billing', 'bill')).toEqual({ before: 'Add ', match: 'bill', after: 'ing' })
  })

  it('leaves text without a match whole', () => {
    expect(highlight('Board', 'x')).toEqual({ before: 'Board', match: '', after: '' })
    expect(highlight('Board', '')).toEqual({ before: 'Board', match: '', after: '' })
  })
})
