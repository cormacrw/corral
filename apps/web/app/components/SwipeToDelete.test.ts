// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { onBeforeUnmount, ref } from 'vue'
import SwipeToDelete from './SwipeToDelete.vue'

beforeEach(() => {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
})

const pointer = (x: number) => ({ button: 0, clientX: x, clientY: 0, pointerId: 1 })

function row() {
  return mount(SwipeToDelete, { slots: { default: '<a href="/inbox/s-1">Thread</a>' }, global: { stubs: { UIcon: true } } })
}

it('deletes on the first tap of the revealed button after a touch swipe', async () => {
  const wrapper = row()
  const swipe = wrapper.get('[data-testid="swipe-row"]')
  Object.defineProperty(swipe.element, 'offsetWidth', { value: 390 })
  // A swipe that stops at the button: touch sends no click after a drag
  await swipe.trigger('pointerdown', pointer(300))
  await swipe.trigger('pointermove', pointer(250))
  await swipe.trigger('pointermove', pointer(200))
  await swipe.trigger('pointerup', pointer(200))
  expect(wrapper.html()).toContain('translateX(-88px)')

  const action = wrapper.get('button')
  await action.trigger('pointerdown', pointer(350))
  await action.trigger('pointerup', pointer(350))
  await action.trigger('click')
  expect(wrapper.emitted('delete')).toHaveLength(1)
})
