// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import EvidenceViewer, { type ViewerFile } from '~/features/evidence/components/EvidenceViewer.vue'

const shot = (id: string): ViewerFile => ({ id, fileName: `${id}.png`, kind: 'screenshot', createdAt: new Date().toISOString(), note: '', url: `/${id}`, contentType: 'image/png' })
const files = ['a', 'b', 'c'].map(shot)
const Modal = defineComponent({ props: { open: Boolean, title: String, hideHeader: Boolean }, setup: (p, { slots }) => () => h('div', { 'data-open': p.open, 'data-title': p.title, 'data-hide-header': p.hideHeader }, slots.body?.()) })
const Button = defineComponent({ emits: ['click'], setup: (p, { emit, attrs }) => () => h('button', { ...attrs, onClick: () => emit('click') }) })

function render(open: ViewerFile | null, list?: ViewerFile[], captions?: Record<string, string>) {
  const wrapper = mount(EvidenceViewer, {
    props: { 'modelValue': open, 'files': list, 'captions': captions, 'onUpdate:modelValue': (f: ViewerFile | null) => wrapper.setProps({ modelValue: f }) },
    global: { components: { AppModal: Modal, AppButton: Button }, stubs: { AppLoadError: true, UiSkeleton: true } },
    attachTo: document.body
  })
  return wrapper
}
const title = (w: ReturnType<typeof render>) => w.get('[data-title]').attributes('data-title')

describe('EvidenceViewer', () => {
  it('flips through the files with its arrows, wrapping at the ends', async () => {
    const wrapper = render(files[0]!, files)
    expect(wrapper.text()).toContain('1 of 3')
    await wrapper.get('[aria-label="Next file"]').trigger('click')
    expect(title(wrapper)).toBe('b.png')
    expect(wrapper.get('img').attributes('src')).toBe('/b')
    await wrapper.get('[aria-label="Previous file"]').trigger('click')
    await wrapper.get('[aria-label="Previous file"]').trigger('click')
    expect(title(wrapper)).toBe('c.png')
    expect(wrapper.text()).toContain('3 of 3')
    wrapper.unmount()
  })

  it('flips with the arrow keys and a sideways swipe, not a vertical one', async () => {
    const wrapper = render(files[1]!, files)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await wrapper.vm.$nextTick()
    expect(title(wrapper)).toBe('c.png')
    const body = wrapper.get('[data-testid="evidence-viewer-body"]')
    const swipe = async (dx: number, dy: number) => {
      await body.trigger('touchstart', { touches: [{ clientX: 200, clientY: 200 }] })
      await body.trigger('touchend', { changedTouches: [{ clientX: 200 + dx, clientY: 200 + dy }] })
    }
    await swipe(120, 10)
    expect(title(wrapper)).toBe('b.png')
    await swipe(20, 150)
    expect(title(wrapper)).toBe('b.png')
    await swipe(-120, 0)
    expect(title(wrapper)).toBe('c.png')
    wrapper.unmount()
  })

  it('puts what a file proves under it, in place of its name up top', async () => {
    const plain = render(files[0]!, files)
    expect(plain.find('[data-testid="evidence-viewer-caption"]').exists()).toBe(false)
    expect(plain.get('[data-title]').attributes('data-hide-header')).toBe('false')
    plain.unmount()
    const wrapper = render(files[0]!, files, { a: 'Expired codes show why', b: 'Task as a whole' })
    expect(wrapper.get('[data-testid="evidence-viewer-caption"]').text()).toContain('Expired codes show why')
    expect(wrapper.get('[data-title]').attributes('data-hide-header')).toBe('true')
    await wrapper.get('[aria-label="Next file"]').trigger('click')
    expect(wrapper.get('[data-testid="evidence-viewer-caption"]').text()).toContain('Task as a whole')
    wrapper.unmount()
  })

  it('zooms an image with a double tap and swipes no further while zoomed', async () => {
    const wrapper = render(files[1]!, files)
    // Its touch listeners attach once it has rendered
    await wrapper.vm.$nextTick()
    const body = wrapper.get('[data-testid="evidence-viewer-body"]')
    // Two taps in quick succession
    const tap = async () => {
      await body.trigger('touchstart', { touches: [{ clientX: 0, clientY: 0 }] })
      await body.trigger('touchend', { touches: [], changedTouches: [{ clientX: 0, clientY: 0 }] })
    }
    await tap()
    await tap()
    expect(wrapper.get('img').attributes('style')).toContain('scale(2)')
    // A one-finger drag now pans the image instead of changing file
    await body.trigger('touchstart', { touches: [{ clientX: 200, clientY: 200 }] })
    await body.trigger('touchend', { touches: [], changedTouches: [{ clientX: 80, clientY: 200 }] })
    expect(title(wrapper)).toBe('b.png')
    // Another file starts unzoomed
    await wrapper.get('[aria-label="Next file"]').trigger('click')
    expect(wrapper.get('img').attributes('style') ?? '').not.toContain('scale')
    wrapper.unmount()
  })

  it('has no paging for one file or a file outside the list', () => {
    for (const wrapper of [render(files[0]!), render(files[0]!, [files[0]!]), render(shot('z'), files)]) {
      expect(wrapper.find('[aria-label="Next file"]').exists()).toBe(false)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
      expect(title(wrapper)).toBe(wrapper.props('modelValue')!.fileName)
      wrapper.unmount()
    }
  })
})
