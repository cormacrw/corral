// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import AppDrawer from './AppDrawer.vue'
import AppModal from './AppModal.vue'

enableAutoUnmount(afterEach)

const mounted = (component: typeof AppDrawer | typeof AppModal, open: ReturnType<typeof ref<boolean>>, props = {}) => mount(defineComponent({
  setup: () => () => h(component, { 'title': 'Close this thread?', 'description': 'Drafts are discarded', 'open': open.value, 'onUpdate:open': (v: boolean) => {
    open.value = v
  }, ...props }, { default: () => h('button', { 'data-trigger': '' }), body: () => h('p', { 'data-body': '' }), footer: () => h('p', { 'data-footer': '' }) })
}), { attachTo: document.body })

describe('AppDrawer', () => {
  it('renders the trigger, description, body and footer like AppModal', async () => {
    const wrapper = mounted(AppDrawer, ref(true))
    await flushPromises()
    expect(wrapper.find('[data-trigger]').exists()).toBe(true)
    for (const selector of ['[data-body]', '[data-footer]']) expect(document.querySelector(selector)).not.toBeNull()
    expect(document.body.textContent).toContain('Drafts are discarded')
  })
})

describe.each([['AppDrawer', AppDrawer], ['AppModal', AppModal]] as const)('%s dismissal', (_name, component) => {
  it('ignores Escape while not dismissible', async () => {
    const open = ref<boolean | undefined>(true)
    mounted(component, open, { dismissible: false })
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(open.value).toBe(true)
  })

  it('closes on Escape otherwise', async () => {
    const open = ref<boolean | undefined>(true)
    mounted(component, open)
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(open.value).toBe(false)
  })
})
