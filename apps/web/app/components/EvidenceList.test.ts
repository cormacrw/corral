// @vitest-environment happy-dom
import type { Evidence, Review } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import EvidenceList from './EvidenceList.vue'
import MarkdownText from './MarkdownText.vue'

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
const Stub = defineComponent({ props: { open: Boolean, title: String }, setup: p => () => h('div', { 'data-open': p.open, 'data-title': p.title }) })
const render = (items = [...evidence('c'), ...evidence(null)]) => mount(EvidenceList, {
  props: { evidence: items, criteria: [{ id: 'c', text: 'Criterion', position: 0, met: true }], reviews: [review] },
  global: { components: { MarkdownText, UIcon: Stub, UModal: Stub } }
})

describe('EvidenceList', () => {
  it('shows human kinds then inline markdown and collapses all agent kinds in each group', async () => {
    const wrapper = render()
    const disclosures = wrapper.findAll('details')
    expect(disclosures).toHaveLength(2)
    for (const details of disclosures) {
      expect(details.attributes('open')).toBeUndefined()
      expect(details.get('summary').text()).toBe('Agent artifacts (4)')
      expect(details.findAll('button').map(b => b.text())).toEqual(
        ['test_output', 'log', 'text', 'other'].map(kind => kind + '.file' + kind.replace('_', ' ') + ' · round 1')
      )
      // Native details controls visibility and supports pointer and keyboard activation.
      details.element.open = true
      expect(details.element.open).toBe(true)
    }
    const humanButtons = wrapper.findAll('button').filter(b => !b.element.closest('details'))
    expect(humanButtons.map(b => b.text())).toEqual(
      [...kinds.slice(0, 3), ...kinds.slice(0, 3)].map(kind => kind + '.file' + kind + ' · round 1')
    )
    expect(wrapper.findAll('strong').map(n => n.text())).toEqual(['Explained', 'Explained'])
    expect(wrapper.findAll('code').map(n => n.text())).toEqual(['code', 'code'])
    expect(wrapper.findAll('a')).toHaveLength(0)
    const html = wrapper.html()
    expect(html.indexOf('Reviewer first')).toBeLessThan(html.indexOf('screenshot.file'))
    expect(html.indexOf('request.file')).toBeLessThan(html.indexOf('Explained'))
    await humanButtons[0]!.trigger('click')
    expect(wrapper.get('[data-title="screenshot.file"]').attributes('data-open')).toBe('true')
  })

  it('leaves artifact-only main areas empty and distinguishes missing evidence', () => {
    const wrapper = render(evidence('c').filter(e => e.kind === 'log'))
    expect(wrapper.text()).toContain('Reviewer first')
    expect(wrapper.text()).not.toContain('No evidence attached.')
    expect(wrapper.findAll('button').every(b => b.element.closest('details'))).toBe(true)
    expect(render([]).text()).toContain('No evidence attached.')
  })
})
