import { describe, expect, it } from 'vitest'
import { shellTitle } from './shell'

const projects = [{ slug: 'corral', name: 'Corral' }]
const agents = [{ name: 'Atlas' }]

describe('shellTitle', () => {
  it.each([
    ['/home', 'Home'],
    ['/plan/session-1', 'Plan'],
    ['/inbox/item-1', 'Inbox'],
    ['/projects', 'Projects'],
    ['/projects/corral', 'Corral'],
    ['/projects/corral/board', 'Corral · Board'],
    ['/projects/corral/pull-requests', 'Corral · Pull requests'],
    ['/projects/gone/backlog', 'gone · Backlog'],
    ['/tasks/COR-3', 'COR-3'],
    ['/epics/e-1', 'Epic'],
    ['/agents/atlas', 'Atlas'],
    ['/agents/atlas/run-1', 'Atlas'],
    ['/agents/nobody', 'Agent'],
    ['/settings/profile', 'Settings'],
    ['/', 'Corral']
  ])('names %s', (path, title) => {
    expect(shellTitle(path, projects, agents)).toBe(title)
  })
})
