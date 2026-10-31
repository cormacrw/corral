// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { testQueryClient } from '~/queries/mount-with-query'

vi.stubGlobal('useDarkNeutral', () => ({ palette: ref('default') }))
vi.stubGlobal('useColorMode', () => ({ value: 'light' }))
vi.stubGlobal('watch', watch)
vi.stubGlobal('nextTick', nextTick)
vi.stubGlobal('useHead', () => {})
vi.stubGlobal('useSeoMeta', () => {})
vi.stubGlobal('useLive', () => ({ connect: vi.fn() }))
vi.stubGlobal('useDevice', () => ({ isMobile: ref(true) }))
vi.stubGlobal('useRoute', () => ({ meta: {} }))
vi.stubGlobal('computed', computed)
vi.stubGlobal('onMounted', onMounted)
vi.stubGlobal('onUnmounted', onUnmounted)

const { default: App } = await import('./app.vue')
const global = { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] as [never], stubs: { UApp: { template: '<div><slot /></div>' }, NuxtLayout: true, NuxtPage: true, InstallSheet: true } }

function gesture(type: string): boolean {
  return document.dispatchEvent(new Event(type, { cancelable: true, bubbles: true }))
}

afterEach(() => vi.restoreAllMocks())

describe('app shell gesture zoom protection', () => {
  it.each([
    { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 },
    { userAgent: 'iPad desktop user agent', platform: 'MacIntel', maxTouchPoints: 5 }
  ])('cancels iOS gestures on $userAgent and cleans up on unmount', ({ userAgent, platform, maxTouchPoints }) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(maxTouchPoints)
    const wrapper = mount(App, { global })
    expect(gesture('gesturestart')).toBe(false)
    expect(gesture('gesturechange')).toBe(false)
    // Normal scrolling events are not canceled.
    expect(gesture('touchmove')).toBe(true)
    wrapper.unmount()
    expect(gesture('gesturestart')).toBe(true)
    expect(gesture('gesturechange')).toBe(true)
  })

  it('leaves desktop gestures and browser zoom shortcuts alone', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(0)
    const wrapper = mount(App, { global })
    expect(gesture('gesturestart')).toBe(true)
    expect(gesture('gesturechange')).toBe(true)
    for (const key of ['+', '-', '0']) {
      expect(document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true }))).toBe(true)
      expect(document.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true }))).toBe(true)
    }
    wrapper.unmount()
  })
})
