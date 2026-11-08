// @vitest-environment happy-dom
import type { TaskInboxItem } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import type { InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'
import { testQueryClient } from '~/queries/mount-with-query'
import { taskItem } from '~/features/inbox/test-items'
import InboxPanel from '~/features/inbox/components/InboxPanel.vue'
import TaskRefText from '~/components/shared/TaskRefText.vue'

enableAutoUnmount(afterEach)

vi.mock('~/queries/shell', () => ({ useShell: () => ({ projects: [{ prefix: 'COR' }], agents: [] }) }))
vi.mock('~/components/shared/TaskLink.vue', () => ({ default: { props: ['taskRef'], template: '<a :href="`/tasks/${taskRef}`"><slot /></a>' } }))

afterEach(() => {
  vi.unstubAllGlobals()
})

it('links known refs in the TL;DR of an item with no message', () => {
  for (const name of ['ref', 'computed'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useRouter', () => ({ resolve: (path: string) => ({ href: path }) }))
  const item: TaskInboxItem = { ...taskItem('COR-5', 'blocked'), message: undefined, body: '## Why\n\nBlocked on COR-12, not XX-3.\n\nMore detail.' }
  const ctx = { item, task: null, evidence: [], reviews: [], actions: [], tab: 'overview' } as unknown as InboxPanelContext
  const wrapper = mount(InboxPanel, {
    props: { ctx },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
      components: { TaskRefText },
      stubs: { InboxPanelMeta: true, InboxPanelVerdict: true, InboxPanelActions: true, InboxPanelArtifacts: true, InboxPanelDetails: true, InboxPanelTray: true, InboxPanelThumbBar: true, EvidenceViewer: true, AppButton: true, AppAlert: true, AppTabs: true, UiSkeleton: true, Icon: true }
    }
  })
  expect(wrapper.text()).toContain('Blocked on COR-12, not XX-3.')
  expect(wrapper.text()).not.toContain('More detail.')
  expect(wrapper.findAll('a').map(a => [a.attributes('href'), a.text()])).toEqual([['/tasks/COR-12', 'COR-12']])
})
