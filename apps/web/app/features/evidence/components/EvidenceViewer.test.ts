// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import EvidenceViewer, { type ViewerFile } from '~/features/evidence/components/EvidenceViewer.vue'

const shot = (id: string): ViewerFile => ({ id, fileName: `${id}.png`, kind: 'screenshot', createdAt: new Date().toISOString(), note: '', url: `/${id}`, contentType: 'image/png' })
const files = ['a', 'b', 'c'].map(shot)
const Modal = defineComponent({ setup: (_, { slots }) => () => h('div', slots.body?.()) })
const Button = defineComponent({ emits: ['click'], setup: (_, { emit, attrs }) => () => h('button', { ...attrs, onClick: () => emit('click') }) })

enableAutoUnmount(afterEach)
afterEach(() => vi.useRealTimers())

function render(open: ViewerFile | null, list?: ViewerFile[], captions?: Record<string, string>) {
  const wrapper = mount(EvidenceViewer, {
    props: { 'modelValue': open, 'files': list, 'captions': captions, 'onUpdate:modelValue': (f: ViewerFile | null) => wrapper.setProps({ modelValue: f }) },
    global: { components: { AppModal: Modal, AppButton: Button }, stubs: { AppLoadError: true, UiSkeleton: true } },
    attachTo: document.body
  })
  return wrapper
}
const body = (w: ReturnType<typeof render>) => w.get('[data-testid="evidence-viewer-body"]')
const shown = (w: ReturnType<typeof render>) => body(w).get('img').attributes('src')

describe('EvidenceViewer', () => {
  it('flips through the files with its arrows, wrapping at the ends', async () => {
    const wrapper = render(files[0]!, files)
    await wrapper.get('[aria-label="Next file"]').trigger('click')
    expect(shown(wrapper)).toBe('/b')
    await wrapper.get('[aria-label="Previous file"]').trigger('click')
    await wrapper.get('[aria-label="Previous file"]').trigger('click')
    expect(shown(wrapper)).toBe('/c')
  })

  it('flips with the arrow keys and a sideways swipe, not a vertical one', async () => {
    const wrapper = render(files[1]!, files)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()
    expect(shown(wrapper)).toBe('/c')
    const swipe = async (dx: number, dy: number) => {
      await body(wrapper).trigger('touchstart', { touches: [{ clientX: 200, clientY: 200 }] })
      await body(wrapper).trigger('touchend', { changedTouches: [{ clientX: 200 + dx, clientY: 200 + dy }] })
    }
    await swipe(120, 10)
    expect(shown(wrapper)).toBe('/b')
    await swipe(20, 150)
    expect(shown(wrapper)).toBe('/b')
    await swipe(-120, 0)
    expect(shown(wrapper)).toBe('/c')
  })

  it('shows what each file proves under it', async () => {
    const plain = render(files[0]!, files)
    expect(plain.find('[data-testid="evidence-viewer-caption"]').exists()).toBe(false)
    plain.unmount()
    const wrapper = render(files[0]!, files, { a: 'Expired codes show why', b: 'Task as a whole' })
    expect(wrapper.get('[data-testid="evidence-viewer-caption"]').text()).toContain('Expired codes show why')
    await wrapper.get('[aria-label="Next file"]').trigger('click')
    expect(wrapper.get('[data-testid="evidence-viewer-caption"]').text()).toContain('Task as a whole')
  })

  it('zooms an image with a double tap and swipes no further while zoomed', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const wrapper = render(files[1]!, files)
    // Its touch listeners attach once it has rendered
    await nextTick()
    const tap = async () => {
      await body(wrapper).trigger('touchstart', { touches: [{ clientX: 0, clientY: 0 }] })
      await body(wrapper).trigger('touchend', { touches: [], changedTouches: [{ clientX: 0, clientY: 0 }] })
    }
    const zoomed = () => (body(wrapper).get('img').attributes('style') ?? '').includes('scale(2)')
    // Two taps too far apart are not a double tap
    await tap()
    vi.advanceTimersByTime(400)
    await tap()
    expect(zoomed()).toBe(false)
    vi.advanceTimersByTime(400)
    await tap()
    vi.advanceTimersByTime(100)
    await tap()
    expect(zoomed()).toBe(true)
    // A one-finger drag now pans the image instead of changing file
    await body(wrapper).trigger('touchstart', { touches: [{ clientX: 200, clientY: 200 }] })
    await body(wrapper).trigger('touchend', { touches: [], changedTouches: [{ clientX: 80, clientY: 200 }] })
    expect(shown(wrapper)).toBe('/b')
    // Another file starts unzoomed
    await wrapper.get('[aria-label="Next file"]').trigger('click')
    expect(zoomed()).toBe(false)
  })

  it.each([
    ['one file', () => render(files[0]!)],
    ['a one-file list', () => render(files[0]!, [files[0]!])],
    ['a file outside the list', () => render(shot('z'), files)]
  ])('has no paging for %s', async (_name, mountViewer) => {
    const wrapper = mountViewer()
    const before = shown(wrapper)
    expect(wrapper.find('[aria-label="Next file"]').exists()).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()
    expect(shown(wrapper)).toBe(before)
  })
})
