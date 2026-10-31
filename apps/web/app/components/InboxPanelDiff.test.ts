// @vitest-environment happy-dom
import type { PullRequestDetail } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import InboxPanelDiff from './InboxPanelDiff.vue'

afterEach(() => {
  vi.unstubAllGlobals()
})

const alertStub = vue.defineComponent({
  name: 'UAlert',
  props: ['title', 'actions'],
  setup: props => () => vue.h('div', { 'data-alert': true }, [props.title, ...(props.actions ?? []).map((a: { label: string, to: string }) => vue.h('a', { href: a.to }, a.label))])
})
const pr: PullRequestDetail = {
  number: 7, url: 'https://github.com/o/r/pull/7', title: 'T', body: '', baseBranch: 'main', headBranch: 'corral/x',
  files: [
    { path: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-old\n+new\n+more' },
    { path: 'logo.png', status: 'added', additions: 0, deletions: 0, patch: '' }
  ],
  totalFiles: 2, truncated: false
}
function mountDiff(fields: Partial<PullRequestDetail> = {}) {
  for (const name of ['ref', 'computed', 'watch'] as const) vi.stubGlobal(name, vue[name])
  return mount(InboxPanelDiff, {
    props: { pr: { ...pr, ...fields } },
    global: { components: { UAlert: alertStub }, stubs: { UButton: true, UIcon: true } }
  })
}

it('lists each file with its counts, the first open with its diff', async () => {
  const wrapper = mountDiff()
  const files = wrapper.findAll('[data-testid="inbox-diff-file"]')
  expect(files).toHaveLength(2)
  expect(files[0]!.text()).toContain('a.ts')
  expect(files[0]!.text()).toContain('+2 −1')
  expect(files[0]!.text()).toContain('+new')
  expect(files[1]!.text()).not.toContain('No text diff')
  await files[1]!.get('button').trigger('click')
  expect(files[1]!.text()).toContain('No text diff')
  expect(wrapper.find('[data-alert]').exists()).toBe(false)
})

it('keeps which files are open when the PR refreshes', async () => {
  const wrapper = mountDiff()
  await wrapper.findAll('[data-testid="inbox-diff-file"] button')[0]!.trigger('click')
  await wrapper.setProps({ pr: { ...pr, title: 'Renamed' } })
  expect(wrapper.text()).not.toContain('+new')
})

it('says how much of a capped diff is shown and links to the PR', () => {
  const alert = mountDiff({ totalFiles: 34, truncated: true }).get('[data-alert]')
  expect(alert.text()).toContain('Showing 2 of 34 files, up to 1,000 changed lines')
  expect(alert.get('a').attributes('href')).toBe(`${pr.url}/files`)
})

it('says when every file is here but the last was cut', () => {
  expect(mountDiff({ truncated: true }).get('[data-alert]').text()).toContain('Showing all 2 files, the last one cut')
})
