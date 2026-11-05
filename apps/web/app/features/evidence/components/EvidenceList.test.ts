// @vitest-environment happy-dom
import type { Evidence, Review } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import EvidenceList from '~/features/evidence/components/EvidenceList.vue'
import MarkdownText from '~/components/shared/MarkdownText.vue'

const kinds = ['screenshot', 'video', 'request', 'note', 'test_output', 'log', 'text', 'other'] as const
const evidence = (criterionId: string | null): Evidence[] => kinds.map((kind): Evidence => ({
  id: kind + criterionId, taskId: 't', criterionId, runId: 'r', round: 0,
  createdAt: new Date().toISOString(),
  ...(kind === 'note'
    ? { kind, note: '**Explained** with `code`.', fileName: null, contentType: null, url: null, size: 0 }
    : { kind, note: '', fileName: kind + '.file', contentType: kind === 'screenshot' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'text/plain', url: '/' + kind, size: 1 })
}))

const review: Review = {
  id: 'review', taskId: 't', runId: 'r', round: 0, headSha: 'abc', verdict: 'approved', summary: '',
  author: { kind: 'agent', role: 'reviewer', runId: 'r' }, createdAt: new Date().toISOString(),
  criteria: [{ criterionId: 'c', met: true, note: 'Reviewer first' }]
}
// Nuxt UI is auto-imported in the app, so stand-ins are registered here
const Stub = defineComponent({ props: { open: Boolean, title: String }, setup: (p, { slots }) => () => h('div', { 'data-open': p.open, 'data-title': p.title }, slots.body?.()) })
const render = (items = [...evidence('c'), ...evidence(null)]) => mount(EvidenceList, {
  props: { evidence: items, criteria: [{ id: 'c', text: 'Criterion', position: 0, met: true }], reviews: [review] },
  global: { components: { MarkdownText, Icon: Stub, AppModal: Stub } }
})

const fileName = (button: { text: () => string }) => kinds.find(kind => button.text().includes(kind + '.file'))

describe('EvidenceList', () => {
  it('keeps agent artifacts in a closed disclosure per group and human files outside it', () => {
    const wrapper = render()
    const disclosures = wrapper.findAll('details')
    expect(disclosures).toHaveLength(2)
    for (const details of disclosures) {
      expect(details.attributes('open')).toBeUndefined()
      expect(details.findAll('button').map(fileName).sort()).toEqual(['log', 'other', 'test_output', 'text'])
    }
    const human = wrapper.findAll('button').filter(b => !b.element.closest('details'))
    expect(human.map(fileName).sort()).toEqual(['request', 'request', 'screenshot', 'screenshot', 'video', 'video'])
  })

  it('renders notes as markdown and shows the reviewer\'s note on its criterion', () => {
    const wrapper = render()
    expect(wrapper.findAll('strong').map(n => n.text())).toEqual(['Explained', 'Explained'])
    expect(wrapper.text()).toContain('Reviewer first')
  })

  it('opens a file in the viewer', async () => {
    const wrapper = render()
    const body = () => wrapper.get('[data-testid="evidence-viewer-body"]')
    expect(body().find('img').exists()).toBe(false)
    await wrapper.findAll('button').find(b => fileName(b) === 'screenshot')!.trigger('click')
    expect(body().get('img').attributes('src')).toBe('/screenshot')
  })

  it('offers the video file for download', async () => {
    const wrapper = render(evidence('c').filter(e => e.kind === 'video'))
    await wrapper.findAll('button').find(b => fileName(b) === 'video')!.trigger('click')
    expect(wrapper.find('video').exists()).toBe(true)
    const link = wrapper.get('a[download]')
    expect(link.attributes('href')).toBe('/video')
    expect(link.attributes('download')).toBe('video.file')
  })

  it('leaves artifact-only main areas empty and distinguishes missing evidence', () => {
    const wrapper = render(evidence('c').filter(e => e.kind === 'log'))
    expect(wrapper.text()).toContain('Reviewer first')
    expect(wrapper.text()).not.toContain('No evidence attached.')
    expect(wrapper.findAll('button').every(b => b.element.closest('details'))).toBe(true)
    expect(render([]).text()).toContain('No evidence attached.')
  })
})
