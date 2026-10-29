// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DesignPreview from './DesignPreview.vue'

describe('DesignPreview', () => {
  it('loads the bundle in a sandbox that allows scripts but not the same origin', () => {
    const iframe = mount(DesignPreview, { props: { versionId: 'v1' } }).get('iframe')
    expect(iframe.attributes('src')).toBe('/api/designs/v1/files/')
    expect(iframe.attributes('sandbox')).toBe('allow-scripts')
  })
})
