// @vitest-environment happy-dom
import type { TaskInboxItem } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import type { InboxPanelContext } from '~/composables/useInboxPanel'
import { testQueryClient } from '~/queries/mount-with-query'
import { inbox } from '~/prototype/fixtures'
import InboxPanel from './InboxPanel.vue'
import TaskRefText from './TaskRefText.vue'

vi.mock('~/queries/shell', () => ({ shell: () => ({ projects: { data: { value: [{ prefix: 'COR' }] } } }) }))
vi.mock('./TaskLink.vue', () => ({ default: { props: ['taskRef'], template: '<a :href="`/tasks/${taskRef}`"><slot /></a>' } }))

afterEach(() => {
  vi.unstubAllGlobals()
})

it('links known refs in the TL;DR of an item with no message', () => {
  for (const name of ['ref', 'computed'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useRouter', () => ({ resolve: (path: string) => ({ href: path }) }))
  const item = { ...inbox().needsYou.find(i => i.taskRef)!, message: undefined, body: '## Why\n\nBlocked on COR-12, not XX-3.\n\nMore detail.' } as TaskInboxItem
  const ctx = { item, task: null, evidence: [], reviews: [], actions: [], tab: 'overview' } as unknown as InboxPanelContext
  const wrapper = mount(InboxPanel, {
    props: { ctx },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
      components: { TaskRefText },
      stubs: { InboxPanelMeta: true, InboxPanelVerdict: true, InboxPanelActions: true, InboxPanelArtifacts: true, InboxPanelDetails: true, InboxPanelTray: true, InboxPanelThumbBar: true, EvidenceViewer: true, UButton: true, UAlert: true, UTabs: true, USkeleton: true, UIcon: true }
    }
  })
  const tldr = wrapper.get('p.line-clamp-2')
  expect(tldr.text()).toBe('TL;DR Blocked on COR-12, not XX-3.')
  expect(tldr.get('.text-muted a[href="/tasks/COR-12"]').text()).toBe('COR-12')
  expect(tldr.findAll('a')).toHaveLength(1)
})
