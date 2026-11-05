// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MarkdownText from '~/components/shared/MarkdownText.vue'

vi.mock('~/queries/shell', () => ({ shell: () => ({ projects: { data: { value: [{ prefix: 'COR' }, { prefix: 'TA' }] } } }) }))
vi.mock('~/features/tasks/composables/useTaskFlyout', () => ({ FLYOUT_SHEETS: Symbol(), useTaskFlyout: () => ({ open: vi.fn() }) }))
beforeEach(() => {
  vi.stubGlobal('useDevice', () => ({ isMobile: computed(() => false) }))
})

const render = (text: string) => mount(MarkdownText, { props: { text }, global: { stubs: { AppModal: true } } })

describe('MarkdownText', () => {
  it('links task refs of known project prefixes only', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)*', component: { template: '<div />' } }] })
    const wrapper = mount(MarkdownText, {
      props: { text: 'COR-3 and TA-12 use SHA-256 over UTF-8' },
      global: { plugins: [router], stubs: { AppModal: true } }
    })
    expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual(['/tasks/COR-3', '/tasks/TA-12'])
    expect(wrapper.text()).toBe('COR-3 and TA-12 use SHA-256 over UTF-8')
  })

  it('links code but preserves existing markdown link targets without nested anchors', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const wrapper = mount(MarkdownText, {
      props: { text: '`COR-12`\n\n```\nTA-9\n```\n\n[**COR-12** and `TA-9`](/elsewhere)' },
      global: { plugins: [router], stubs: { AppModal: true } }
    })
    expect(wrapper.findAll('code a').map(a => a.attributes('href'))).toEqual(['/tasks/COR-12', '/tasks/TA-9'])
    expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual(['/tasks/COR-12', '/tasks/TA-9', '/elsewhere'])
    expect(wrapper.find('a a').exists()).toBe(false)
  })

  it('renders GFM tables', () => {
    const wrapper = render('| File | Change |\n| --- | --- |\n| a.vue | b |')
    expect(wrapper.findAll('td').map(td => td.text())).toEqual(['a.vue', 'b'])
  })
})
