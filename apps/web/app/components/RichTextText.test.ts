// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { attachmentUrl } from '@corral/core'
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

it('shows external and attachment images full width, and drops unsafe sources', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const wrapper = mount(RichTextText, { props: { doc: { type: 'doc', content: [
    { type: 'image', attrs: { src: 'https://example.com/x.png', alt: '' } },
    { type: 'image', attrs: { src: `attachment:${id}`, alt: 'Shot' } },
    { type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'Unsafe' } }
  ] } } })
  const images = wrapper.findAll('img')
  expect(images.map(image => image.attributes('src'))).toEqual(['https://example.com/x.png', attachmentUrl(id)])
  for (const image of images) expect(image.classes()).toEqual(['max-w-full', 'rounded-md'])
  expect(wrapper.text()).toBe('Unsafe')
})

it('sizes headings by level', () => {
  const wrapper = mount(RichTextText, { props: { doc: { type: 'doc', content: [1, 2, 3, 4].map(level => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'Title' }] })) } } })
  expect(wrapper.get('h1').classes()).toContain('text-lg')
  expect(wrapper.get('h2').classes()).toContain('text-base')
  expect(wrapper.get('h3').classes()).toContain('text-sm')
  expect(wrapper.get('h4').classes()).toEqual(['font-semibold', 'text-highlighted'])
})
