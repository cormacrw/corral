// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import AppDrawer from './AppDrawer.vue'
import AppModal from './AppModal.vue'

const mounted = (component: typeof AppDrawer | typeof AppModal, open: ReturnType<typeof ref<boolean>>, props = {}) => mount(defineComponent({
  setup: () => () => h(component, { 'title': 'Close this thread?', 'description': 'Drafts are discarded', 'open': open.value, 'onUpdate:open': (v: boolean) => {
    open.value = v
  }, ...props }, { default: () => h('button', { 'data-trigger': '' }), body: () => h('p', { 'data-body': '' }), footer: () => h('p', { 'data-footer': '' }) })
}), { attachTo: document.body })

describe('AppDrawer', () => {
  it('renders the trigger, and matches AppModal with a visible header, body and footer', async () => {
    const wrapper = mounted(AppDrawer, ref(true))
    await flushPromises()
    expect(wrapper.find('[data-trigger]').exists()).toBe(true)
    for (const selector of ['[data-body]', '[data-footer]']) expect(document.querySelector(selector)).not.toBeNull()
    expect(document.body.textContent).toContain('Drafts are discarded')
    expect(document.querySelector('[data-slot="drawer-header"]')?.className).not.toContain('sr-only')
    wrapper.unmount()
  })
})

describe.each([['AppDrawer', AppDrawer], ['AppModal', AppModal]] as const)('%s dismissal', (_name, component) => {
  it('ignores Escape while not dismissible', async () => {
    const open = ref<boolean | undefined>(true)
    const wrapper = mounted(component, open, { dismissible: false })
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(open.value).toBe(true)
    wrapper.unmount()
  })

  it('closes on Escape otherwise', async () => {
    const open = ref<boolean | undefined>(true)
    const wrapper = mounted(component, open)
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(open.value).toBe(false)
    wrapper.unmount()
  })
})
