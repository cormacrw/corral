import { describe, expect, it } from 'vitest'
import { agents, epics, planSessions, projects, tasks } from '../prototype/fixtures.ts'
import { highlight, mobileSearch, searchPages } from './search.ts'

const data = { projects, agents, tasks, epics, planSessions }

describe('mobileSearch', () => {
  it('offers only pages to go to before you type', () => {
    const results = mobileSearch('  ', data, 3)
    expect(results.pages.map(p => p.label)).toEqual(['Plan', 'Inbox', 'Settings'])
    expect(results.epics).toEqual([])
    expect(results.tasks).toEqual([])
    expect(results.sessions).toEqual([])
  })

  it('matches pages, epics, tasks and Plan sessions case-insensitively', () => {
    const project = projects[0]!
    const epic = epics[0]!
    const session = planSessions[0]!
    const someTask = tasks[0]!
    expect(mobileSearch(project.name.toUpperCase(), data).pages.some(p => p.to === `/projects/${project.slug}/board`)).toBe(true)
    expect(mobileSearch(epic.title.toLowerCase(), data).epics).toContainEqual(epic)
    expect(mobileSearch(session.title, data).sessions).toContainEqual(session)
    expect(mobileSearch(someTask.title, data).tasks).toContainEqual(someTask)
  })

  it('finds a task by its ref', () => {
    const someTask = tasks[0]!
    expect(mobileSearch(someTask.ref.toLowerCase(), data).tasks[0]?.ref).toBe(someTask.ref)
  })

  it('caps each group', () => {
    expect(mobileSearch('·', data, 2).pages).toHaveLength(2)
  })
})

describe('searchPages', () => {
  it('goes to each project\'s pages and each agent', () => {
    const pages = searchPages(projects, agents)
    expect(pages.filter(p => p.to.startsWith('/projects/'))).toHaveLength(projects.length * 4)
    expect(pages.filter(p => p.to.startsWith('/agents/'))).toHaveLength(agents.length)
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
