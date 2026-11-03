// @vitest-environment happy-dom
import type { Epic, EpicFixRun, EpicSync } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref } from 'vue'
import BoardEpicCard from '~/features/board/components/BoardEpicCard.vue'
import EpicFixAlert from '~/features/epics/components/EpicFixAlert.vue'
import EpicFixRuns from '~/features/epics/components/EpicFixRuns.vue'

vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('useTaskFlyout', () => ({ epic: ref(null), openEpic: vi.fn() }))

const NuxtLink = defineComponent({ props: { to: String }, setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) })
const Passthrough = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
const global = { components: { NuxtLink, BorderGlow: Passthrough, AppPopover: Passthrough, AppButton: Passthrough, Icon: Passthrough, AgentAvatar: Passthrough } }

type Fixing = Extract<EpicSync, { state: 'fixing' }>
const fixing = (over: Partial<Fixing> = {}): Fixing => ({
  state: 'fixing', fix: 'ci', reason: 'CI failed on the epic PR. lint: failed', files: [],
  developer: { agentId: 'a', name: 'Atlas', runId: 'r1', runNumber: 41 }, attempts: 0, ...over
} as Fixing)
const epic = (sync: EpicSync | null) => ({ id: 'e', title: 'Saved searches', taskCount: 2, mergedCount: 2, reviewMode: 'epic', sync, dependsOn: [] }) as unknown as Epic
const card = (sync: EpicSync) => mount(BoardEpicCard, { props: { epic: epic(sync), waitingOn: [], workingAgents: [] }, global })

it('names who is fixing an epic and why on its page', () => {
  const alert = mount(EpicFixAlert, { props: { sync: fixing({ attempts: 2 }) }, global })
  expect(alert.text()).toContain('Fixing a CI failure')
  expect(alert.text()).toContain('Atlas · run #41')
  expect(alert.text()).toContain('CI failed on the epic PR. lint: failed')
  expect(alert.text()).toContain('2 earlier attempts came to nothing')
  expect(alert.find('a').attributes('href')).toContain('r1')
})

it('says so when an epic is still waiting for a developer', () => {
  expect(mount(EpicFixAlert, { props: { sync: fixing({ developer: null }) }, global }).text()).toContain('Waiting for a developer')
})

it('names who and why on the board card', () => {
  const text = card(fixing({ fix: 'conflict', reason: 'The rebase conflicts in a.ts' })).find('[data-testid="epic-card-fix"]').text()
  expect(text).toContain('Resolving a rebase conflict')
  expect(text).toContain('Atlas')
  expect(text).toContain('The rebase conflicts in a.ts')
})

it('shows a stopped epic\'s failure on the board card', () => {
  const text = card({ state: 'failed', fix: 'ci', error: 'CI still failing after 3 fixes' } as EpicSync).find('[data-testid="epic-card-stopped"]').text()
  expect(text).toContain('Fix stopped')
  expect(text).toContain('CI still failing after 3 fixes')
})

it('shows a pending conflict as progress on the board card', () => {
  expect(card({ state: 'conflict_pending', files: ['a.ts'] }).find('[data-testid="epic-card-conflict-pending"]').text()).toContain('about to land')
})

it('lists past fixes with their reason and whether behaviour changed', () => {
  const run = (over: Partial<EpicFixRun>): EpicFixRun => ({ runId: 'r', runNumber: 7, fix: 'ci', developer: 'Atlas', reason: 'CI failed', state: 'completed', outcome: 'pr_updated', summary: 'Fixed the fixture', behaviourChanged: false, reReviewed: false, at: '2026-11-02T00:00:00.000Z', ...over })
  const rows = mount(EpicFixRuns, { props: { runs: [run({}), run({ runId: 'r2', fix: 'review', reason: 'Reviewer asked', behaviourChanged: true, reReviewed: true })] }, global }).findAll('li')
  expect(rows[0]!.text()).toContain('CI failed')
  expect(rows[0]!.text()).toContain('Fixed the fixture')
  expect(rows[0]!.text()).toContain('Behaviour unchanged · Kept approval')
  expect(rows[1]!.text()).toContain('Reviewer asked')
  expect(rows[1]!.text()).toContain('Reviewed again')
})
