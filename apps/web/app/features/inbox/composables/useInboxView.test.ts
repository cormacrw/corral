import { expect, it } from 'vitest'
import { inbox } from '~/prototype/fixtures'
import { inboxTabs } from '~/features/inbox/composables/useInboxView'

it('lists decisions by default and leaves informational items out, newest first', () => {
  const server = inbox()
  const tabs = inboxTabs(server)
  expect(tabs.needsYou).toHaveLength(server.count)
  expect(tabs.needsYou.some(i => i.type === 'release_notes')).toBe(false)
  expect(tabs.needsYou.map(i => i.id)).toEqual(expect.arrayContaining(['s-1', 's-2']))
  expect(Object.keys(tabs)).toEqual(['needsYou', 'resolved'])
  expect(tabs.needsYou.some(i => i.id === 's-5' || i.id === 'release-demo' || i.id === 'activity-merged')).toBe(false)
  expect(tabs.resolved).toEqual(server.resolved)
})

it('has empty tabs before the Inbox loads', () => {
  expect(inboxTabs(null)).toEqual({ needsYou: [], resolved: [] })
})
