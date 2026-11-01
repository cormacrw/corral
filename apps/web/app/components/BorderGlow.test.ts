// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, createSSRApp, h, nextTick, onMounted, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import BorderGlow from './BorderGlow.vue'

// Nuxt auto-imports these in the app; this test also renders on the server.
vi.stubGlobal('computed', computed)
vi.stubGlobal('onMounted', onMounted)
vi.stubGlobal('ref', ref)
afterEach(() => vi.restoreAllMocks())

it('hydrates the server delay before choosing independent phases without changing lap duration', async () => {
  const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.75)
  const render = () => h('section', [h(BorderGlow, { duration: 8 }), h(BorderGlow, { duration: 8 })])
  const html = await renderToString(createSSRApp({ render }))
  expect(random).not.toHaveBeenCalled()
  expect(html.match(/animation-delay:0s/g)).toHaveLength(2)
  const container = document.createElement('div')
  container.innerHTML = html
  const warn = vi.spyOn(console, 'warn')
  const error = vi.spyOn(console, 'error')
  const app = createSSRApp({ render })
  app.mount(container)
  await nextTick()
  const glows = Array.from(container.querySelectorAll<HTMLElement>('section > div'))
  expect(glows.map(el => el.style.animationDelay)).toEqual(['-2s', '-6s'])
  expect(glows.map(el => el.style.animationDuration)).toEqual(['8s', '8s'])
  expect(warn).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  app.unmount()
})
