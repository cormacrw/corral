// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { usePlanThreadScroll } from '~/features/plan/composables/usePlanThreadScroll'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
})

async function open(cached = true, question = false) {
  let resize = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  const state = reactive({ threadId: cached ? 'one' : undefined as string | undefined, messageId: 'last', questionId: question ? 'last' : undefined as string | undefined, human: false, revision: 0 })
  let top = 0
  let height = 2000
  const wrapper = mount(defineComponent({
    setup() {
      const { log, content, onLogScroll } = usePlanThreadScroll(() => state)
      return () => h('div', {
        ref: (el) => {
          if (!el) return
          const node = el as HTMLElement
          Object.defineProperties(node, {
            scrollHeight: { configurable: true, get: () => height },
            clientHeight: { configurable: true, value: 400 },
            scrollTop: { configurable: true, get: () => top, set: value => top = Math.max(0, Math.min(value, height - 400)) }
          })
          node.getBoundingClientRect = () => ({ top: 0 } as DOMRect)
          log.value = node
        },
        onScroll: onLogScroll
      }, [h('div', { ref: content }, [h('div', {
        'data-message-id': 'last',
        'ref': (el) => {
          if (el) (el as HTMLElement).getBoundingClientRect = () => ({ top: 1000 - top } as DOMRect)
        }
      })])])
    }
  }))
  cleanups.push(() => wrapper.unmount())
  await nextTick()
  return { state, wrapper, disconnect, resize: () => resize(), grow: () => {
    height += 600
    resize()
  }, top: () => top, scroll: async (to: number) => {
    top = to
    await wrapper.trigger('scroll')
  } }
}

it.each([false, true])('opens at the bottom with cached=%s, even on a question, and switches there', async (cached) => {
  const t = await open(cached, true)
  if (!cached) {
    t.state.threadId = 'one'
    await nextTick()
  }
  expect(t.top()).toBe(1600)
  await t.scroll(100)
  t.state.threadId = 'two'
  await nextTick()
  expect(t.top()).toBe(1600)
})

it('holds the bottom as late content grows, until the reader scrolls up', async () => {
  const t = await open()
  t.grow()
  expect(t.top()).toBe(2200)
  await t.scroll(100)
  t.grow()
  t.state.revision++
  t.state.messageId = 'pm-update'
  await nextTick()
  expect(t.top()).toBe(100)
})

it('follows PM updates, anchors only a new question and resumes after a human message', async () => {
  const t = await open()
  t.state.messageId = 'pm-update'
  await nextTick()
  expect(t.top()).toBe(1600)
  await t.scroll(100)
  t.state.messageId = 'last'
  t.state.questionId = 'last'
  await nextTick()
  expect(t.top()).toBe(984)
  await t.wrapper.trigger('scroll') // our own scroll event must not cancel the anchor
  t.state.revision++
  t.grow()
  await nextTick()
  expect(t.top()).toBe(984)
  await t.scroll(200)
  t.resize()
  expect(t.top()).toBe(200)
  t.state.messageId = 'human'
  t.state.human = true
  t.state.questionId = undefined
  await nextTick()
  expect(t.top()).toBe(2200)
  t.wrapper.unmount()
  expect(t.disconnect).toHaveBeenCalled()
})
