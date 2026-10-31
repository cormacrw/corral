// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import RichTextText from './RichTextText.vue'

vi.mock('~/queries/shell', () => ({ shell: () => ({ projects: { data: { value: [{ prefix: 'COR' }] } } }) }))
vi.mock('./TaskLink.vue', () => ({ default: { props: ['taskRef'], template: '<a :href="`/tasks/${taskRef}`"><slot /></a>' } }))

it('links rich descriptions without interpreting literal markdown or replacing marked links', () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [] })
  const wrapper = mount(RichTextText, {
    props: { doc: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '*literal* COR-12', marks: [{ type: 'bold' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'COR-9', marks: [{ type: 'code' }, { type: 'link', attrs: { href: '/original' } }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'COR-8 <script>bad()</script>' }] }
    ] } },
    global: { plugins: [router] }
  })
  expect(wrapper.get('strong').text()).toBe('*literal* COR-12')
  expect(wrapper.findAll('a').map(a => a.attributes('href'))).toEqual(['/tasks/COR-12', '/original', '/tasks/COR-8'])
  expect(wrapper.get('pre code a').text()).toBe('COR-8')
  expect(wrapper.find('script').exists()).toBe(false)
})
