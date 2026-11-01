import { expect, it } from 'vitest'
import { inbox } from '~/prototype/fixtures'
import { inboxTabs } from './useInboxView'

it('lists decisions by default and informational items under Activity, newest first', () => {
  const server = inbox()
  const tabs = inboxTabs(server)
  expect(tabs.needsYou).toHaveLength(server.count)
  expect(tabs.needsYou.some(i => i.type === 'release_notes')).toBe(false)
  expect(tabs.needsYou.map(i => i.id)).toEqual(expect.arrayContaining(['s-1', 's-2']))
  expect(tabs.activity.map(i => i.id)).toEqual(expect.arrayContaining(['release-demo', 'activity-merged']))
  expect(tabs.activity.map(i => i.at)).toEqual(tabs.activity.map(i => i.at).sort().reverse())
  expect([...tabs.needsYou, ...tabs.activity].some(i => i.id === 's-5')).toBe(false)
  expect(tabs.resolved).toEqual(server.resolved)
})

it('has empty tabs before the Inbox loads', () => {
  expect(inboxTabs(null)).toEqual({ needsYou: [], activity: [], resolved: [] })
})
