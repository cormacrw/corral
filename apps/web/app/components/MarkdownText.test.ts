// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import MarkdownText from './MarkdownText.vue'

const render = (text: string) => mount(MarkdownText, { props: { text }, global: { stubs: { UModal: true } } })
const classes = (el: Element | null) => el?.className.split(' ') ?? []

// Long tokens must wrap so they never widen the Plan thread on a phone (COR-99)
describe('MarkdownText', () => {
  it('links task refs of known project prefixes only', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)*', component: { template: '<div />' } }] })
    const wrapper = mount(MarkdownText, {
      props: { text: 'COR-3 and TA-12 use SHA-256 over UTF-8', taskRefs: ['COR', 'TA'] },
      global: { plugins: [router], stubs: { UModal: true } }
    })
    expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual(['/tasks/COR-3', '/tasks/TA-12'])
    expect(wrapper.text()).toBe('COR-3 and TA-12 use SHA-256 over UTF-8')
  })

  it('wraps long words and paths in prose anywhere', () => {
    const wrapper = render('See apps/web/app/components/plan/conversation/PlanConversationMessageLogWithAVeryLongName.vue')
    expect(classes(wrapper.element)).toContain('wrap-anywhere')
    expect(classes(wrapper.element)).toContain('min-w-0')
  })

  it('wraps a long inline code span anywhere', () => {
    const wrapper = render('Calls `useTaskFlyout().openPlanWithAVeryLongOptionName({ replace: true })`')
    expect(classes(wrapper.find('p code').element)).toContain('wrap-anywhere')
  })

  it('renders GFM tables, which scroll in their own box', () => {
    const wrapper = render('| File | Change |\n| --- | --- |\n| a.vue | b |')
    const table = wrapper.find('table')
    expect(table.exists()).toBe(true)
    expect(classes(table.element.parentElement)).toContain('overflow-x-auto')
    expect(wrapper.findAll('td').map(td => td.text())).toEqual(['a.vue', 'b'])
  })

  it('keeps code blocks on their lines, scrolling in their own box', () => {
    const pre = render('```ts\nconst message = await api.plan.message(id)\n```').find('pre').element
    expect(classes(pre)).toEqual(expect.arrayContaining(['overflow-x-auto', 'whitespace-pre', 'wrap-normal']))
  })
})
