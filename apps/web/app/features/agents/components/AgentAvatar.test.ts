// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import AgentAvatar from '~/features/agents/components/AgentAvatar.vue'

vi.stubGlobal('computed', vue.computed)
vi.mock('~/queries/shell', () => ({ shell: () => null }))

const AppAvatar = { props: ['size', 'class', 'text', 'src'], template: '<i />' }
const avatar = (size?: '3xl' | '4xl') => mount(AgentAvatar, {
  props: { name: 'Juno', size, src: null },
  global: { stubs: { AppAvatar } }
}).findComponent(AppAvatar).props()

describe('AgentAvatar', () => {
  it('sizes 4xl past AppAvatar\'s largest, initials included', () => {
    expect(avatar('4xl')).toMatchObject({ size: '3xl', class: 'size-24 text-5xl' })
  })

  it('leaves the other sizes to AppAvatar', () => {
    for (const [size, expected] of [['3xl', '3xl'], [undefined, 'sm']] as const) {
      const props = avatar(size)
      expect(props.size).toBe(expected)
      expect(props.class).toBeFalsy()
    }
  })
})
