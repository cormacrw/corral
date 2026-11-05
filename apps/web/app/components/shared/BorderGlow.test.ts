// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, createSSRApp, h, nextTick, onMounted, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import BorderGlow from '~/components/shared/BorderGlow.vue'

// Nuxt auto-imports these in the app; this test also renders on the server.
vi.stubGlobal('computed', computed)
vi.stubGlobal('onMounted', onMounted)
vi.stubGlobal('ref', ref)
afterEach(() => vi.restoreAllMocks())

it('hydrates without a mismatch, then gives each glow its own phase', async () => {
  const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.75)
  const render = () => h('section', [h(BorderGlow, { duration: 8 }), h(BorderGlow, { duration: 8 })])
  const html = await renderToString(createSSRApp({ render }))
  // The server picks no phase, so the client's first render matches it
  expect(random).not.toHaveBeenCalled()
  const container = document.createElement('div')
  container.innerHTML = html
  const warn = vi.spyOn(console, 'warn')
  const error = vi.spyOn(console, 'error')
  const app = createSSRApp({ render })
  app.mount(container)
  await nextTick()
  expect(warn).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  const delays = Array.from(container.querySelectorAll<HTMLElement>('section > div'), el => el.style.animationDelay)
  expect(delays).toHaveLength(2)
  expect(new Set(delays).size).toBe(2)
  app.unmount()
})
