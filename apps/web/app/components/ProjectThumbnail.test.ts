// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ProjectThumbnail from './ProjectThumbnail.vue'

const project = { name: 'Marketing site', thumbnailColor: '#8b5cf6', thumbnailUrl: '/thumbnail.png' }

describe('ProjectThumbnail', () => {
  it('names the image and replaces a failed image with the colour and initial', async () => {
    const wrapper = mount(ProjectThumbnail, { props: { project, size: 44 } })
    expect(wrapper.get('img').attributes('alt')).toBe(project.name)
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('MS')
    expect(wrapper.attributes('style')).toContain('background: #8b5cf6')
    // A new upload must be attempted even after the previous one failed.
    await wrapper.setProps({ project: { ...project, thumbnailUrl: '/replacement.png' } })
    expect(wrapper.get('img').attributes('src')).toBe('/replacement.png')
    await wrapper.setProps({ project: { ...project, thumbnailUrl: null } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('MS')
  })
})
