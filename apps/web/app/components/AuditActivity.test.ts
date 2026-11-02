// @vitest-environment happy-dom
import type { AuditEntry } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { AGENT_ROLES } from '@corral/core'
import { ROLE } from '~/utils/labels'
import AuditActivity from './AuditActivity.vue'

afterEach(() => vi.unstubAllGlobals())

it.each(AGENT_ROLES)('attributes a %s action to its role', (role) => {
  vi.stubGlobal('computed', vue.computed)
  const entry = { id: 1, action: 'epic.updated', detail: {}, createdAt: new Date().toISOString(), actor: { kind: 'agent', role, runId: 'r1' } } as unknown as AuditEntry
  const wrapper = mount(AuditActivity, {
    props: { entry, text: 'edited the epic' },
    global: { stubs: { AgentAvatar: true, NuxtLink: true } }
  })
  expect(wrapper.get('span.font-medium').text()).toBe(ROLE[role])
})
