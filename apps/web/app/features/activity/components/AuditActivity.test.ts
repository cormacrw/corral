// @vitest-environment happy-dom
import type { AuditEntry } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { ROLE_LABELS, type Actor } from '@corral/core'
import AuditActivity from '~/features/activity/components/AuditActivity.vue'

afterEach(() => vi.unstubAllGlobals())

const render = (actor: Actor, agentName: string | null) => {
  vi.stubGlobal('computed', vue.computed)
  const entry: AuditEntry = { id: 1, projectId: null, taskId: null, action: 'epic.updated', detail: {}, createdAt: new Date().toISOString(), actor, agentName }
  const wrapper = mount(AuditActivity, {
    props: { entry, text: 'edited the epic' },
    global: { stubs: { NuxtLink: true, AgentAvatar: { props: ['name'], template: '<i data-testid="avatar">{{ name }}</i>' } } }
  })
  return { text: wrapper.get('[data-testid="audit-activity"]').text(), avatar: wrapper.get('[data-testid="avatar"]').text() }
}

it('attributes an agent action to the agent that acted, or its role once it is gone', () => {
  const actor: Actor = { kind: 'agent', role: 'reviewer', runId: 'r1' }
  const named = render(actor, 'Nova')
  expect(named.avatar).toBe('Nova')
  expect(named.text).toContain('Nova')
  expect(named.text).not.toContain('confirmed by you')
  expect(render(actor, null).avatar).toBe(ROLE_LABELS.reviewer)
})

it('shows an action confirmed through the PM as the PM\'s, confirmed by you', () => {
  const viaPm: Actor = { kind: 'human', userId: 'u1', viaPm: { sessionId: 's1', runId: 'r1' } }
  const named = render(viaPm, 'Juno')
  expect(named.avatar).toBe('Juno')
  expect(named.text).toContain('confirmed by you')
  expect(render(viaPm, null).avatar).toBe(ROLE_LABELS.pm)
})
