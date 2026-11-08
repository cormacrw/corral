// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MarkdownText from '~/components/shared/MarkdownText.vue'

vi.mock('~/queries/shell', () => ({ useShell: () => ({ projects: [{ prefix: 'COR' }, { prefix: 'TA' }], agents: [] }) }))
vi.mock('~/composables/useTaskFlyout', () => ({ useFlyoutHost: () => ({ docked: () => false, sheets: false }), useTaskFlyout: () => ({ open: vi.fn() }) }))
beforeEach(() => {
  vi.stubGlobal('useDevice', () => ({ isMobile: computed(() => false) }))
})

const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)*', component: { template: '<div />' } }] })
const render = (text: string) => mount(MarkdownText, { props: { text }, global: { plugins: [router()], stubs: { AppModal: true } } })

describe('MarkdownText', () => {
  it('links task refs of known project prefixes only', () => {
    const wrapper = render('COR-3 and TA-12 use SHA-256 over UTF-8')
    expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual(['/tasks/COR-3', '/tasks/TA-12'])
    expect(wrapper.text()).toBe('COR-3 and TA-12 use SHA-256 over UTF-8')
  })

  it('links code but preserves existing markdown link targets without nested anchors', () => {
    const wrapper = render('`COR-12`\n\n```\nTA-9\n```\n\n[**COR-12** and `TA-9`](/elsewhere)')
    expect(wrapper.findAll('code a').map(a => a.attributes('href'))).toEqual(['/tasks/COR-12', '/tasks/TA-9'])
    expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual(['/tasks/COR-12', '/tasks/TA-9', '/elsewhere'])
    expect(wrapper.find('a a').exists()).toBe(false)
  })

  it('renders GFM tables', () => {
    const wrapper = render('| File | Change |\n| --- | --- |\n| a.vue | b |')
    expect(wrapper.findAll('td').map(td => td.text())).toEqual(['a.vue', 'b'])
  })
})
