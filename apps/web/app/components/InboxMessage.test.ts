// @vitest-environment happy-dom
import type { Evidence, InboxArtifact } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import InboxMessage from './InboxMessage.vue'
import MarkdownText from './MarkdownText.vue'

const screenshot: InboxArtifact = { id: 'new', kind: 'screenshot', name: 'fixed.png', url: '/api/evidence/new/file', taskRef: 'TA-1', at: '2026-10-30T12:00:00Z' }
const modal = defineComponent({
  props: ['open', 'title'],
  setup: (props, { slots }) => () => h('div', { 'data-open': props.open, 'data-title': props.title }, slots.body?.())
})
const render = (message: string | undefined = 'Ready for your review.', newArtifacts: InboxArtifact[] = [screenshot], evidence: Evidence[] = []) => mount(InboxMessage, {
  props: { item: { message, body: '## Findings\n\nThe complete investigation.', newArtifacts }, evidence },
  global: { components: { MarkdownText, UModal: modal }, stubs: { UIcon: true, UAlert: true, USkeleton: true } }
})

describe('InboxMessage', () => {
  it('shows prose first, only supplied new artifacts next, and full findings in closed details', async () => {
    const wrapper = render('Ready with **literal** text.')
    expect(wrapper.get('p').text()).toBe('Ready with **literal** text.')
    expect(wrapper.get('p').find('strong').exists()).toBe(false)
    expect(wrapper.get('section').element.children[1]?.getAttribute('aria-label')).toBe('New artifacts')
    expect(wrapper.findAll('button')).toHaveLength(1)
    expect(wrapper.get('button').text()).toContain('TA-1')
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.get('summary').text()).toBe('Full message')
    expect(wrapper.get('details h3').text()).toBe('Findings')
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('[data-title="fixed.png"]').attributes('data-open')).toBe('true')
    expect(wrapper.get('[data-title="fixed.png"] img').attributes('src')).toBe(screenshot.url)
  })

  it('does not recreate a New row from older evidence or render one when the list is empty', () => {
    const wrapper = render('No new files.', [], [{ id: 'old' } as Evidence])
    expect(wrapper.find('[aria-label="New artifacts"]').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('links the submitted design version directly to its preview', () => {
    const wrapper = render('Updated design.', [{ ...screenshot, kind: 'design', name: 'Design v2', url: '/api/designs/v2/files/' }])
    expect(wrapper.get('a').attributes('href')).toBe('/api/designs/v2/files/')
    expect(wrapper.get('a').text()).toBe('Design v2 · Preview')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('keeps the previous markdown body without disclosures for items without a message', () => {
    const wrapper = render('')
    expect(wrapper.get('h3').text()).toBe('Findings')
    expect(wrapper.find('details').exists()).toBe(false)
    expect(wrapper.find('[aria-label="New artifacts"]').exists()).toBe(false)
  })

  it('offers an unknown file as a download, never in an iframe', async () => {
    const wrapper = render('New report.', [{ ...screenshot, kind: 'other', name: 'report.html' }])
    await wrapper.get('button').trigger('click')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('[data-title="report.html"] a').attributes('href')).toBe(screenshot.url)
    expect(wrapper.get('[data-title="report.html"] a').attributes('download')).toBe('report.html')
  })

  it('shows no HTML evidence in an iframe even with its real type, and keeps PDFs viewable', async () => {
    const evidence = (contentType: string) => [{ id: 'new', fileName: 'report', contentType, url: screenshot.url, kind: 'other', note: '', createdAt: screenshot.at } as Evidence]
    const html = render('New report.', [{ ...screenshot, kind: 'other' }], evidence('TEXT/HTML'))
    await html.get('button').trigger('click')
    expect(html.find('iframe').exists()).toBe(false)
    const pdf = render('New report.', [{ ...screenshot, kind: 'other' }], evidence('application/pdf'))
    await pdf.get('button').trigger('click')
    expect(pdf.get('iframe').attributes('src')).toBe(screenshot.url)
  })

  it('has no Full message control when there is no body', () => {
    const wrapper = mount(InboxMessage, {
      props: { item: { message: 'Blocked.', body: '' } },
      global: { components: { MarkdownText, UModal: modal }, stubs: { UIcon: true } }
    })
    expect(wrapper.get('p').text()).toBe('Blocked.')
    expect(wrapper.find('details').exists()).toBe(false)
  })

  it('uses actual evidence MIME metadata for file viewing', async () => {
    const wrapper = render('New recording.', [{ ...screenshot, kind: 'other', name: 'recording.bin' }], [{
      id: 'new', fileName: 'recording.bin', contentType: 'video/webm', url: '/recording', kind: 'other', note: '', createdAt: screenshot.at
    } as Evidence])
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('video').attributes('src')).toBe('/recording')
  })
})
