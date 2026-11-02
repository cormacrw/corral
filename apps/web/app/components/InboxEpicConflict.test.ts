// @vitest-environment happy-dom
import type { EpicConflictItem } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref } from 'vue'
import InboxEpicConflict from './InboxEpicConflict.vue'
import { testQueryClient } from '~/queries/mount-with-query'

const review = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })))
vi.mock('~/composables/useApi', () => ({ api: { epics: { review } } }))
vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)

const Button = defineComponent({ props: { label: String }, emits: ['click'], setup: (p, { emit }) => () => h('button', { onClick: () => emit('click') }, p.label) })
const Header = defineComponent({ props: { badge: String }, setup: (p, { slots }) => () => h('header', [p.badge, slots.default?.()]) })
const stopped = { id: 'e', epicId: 'e', headSha: 'h', subject: 'Saved searches', targetBranch: 'main', files: [], project: { name: 'App' }, prUrl: 'https://x', stopped: { error: 'CI still failing after 3 fixes', fix: 'ci' } } as unknown as EpicConflictItem
const render = () => mount(InboxEpicConflict, { props: { item: stopped }, global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { UButton: Button, UAlert: Button, UIcon: Button, UTextarea: Button, InboxEpicHeader: Header, InboxMessage: Button, InboxEpicDecision: Button } } })

it('shows a stopped epic\'s failure as a decision for the human, not a conflict', () => {
  const text = render().text()
  expect(text).toContain('Fix stopped · Needs you')
  expect(text).toContain('CI still failing after 3 fixes')
  expect(text).not.toContain('can\'t rebase')
  expect(text).not.toContain('conflicting')
})

it('retries through the epic\'s Retry action', async () => {
  const wrapper = render()
  await wrapper.get('footer button').trigger('click')
  await flushPromises()
  expect(review).toHaveBeenCalledWith('e', { action: 'rebase', headSha: 'h' })
})
