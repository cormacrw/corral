// @vitest-environment happy-dom
import type { AuditEntry } from '@corral/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { AGENT_ROLES, type Actor } from '@corral/core'
import { ROLE } from '~/utils/labels'
import AuditActivity from '~/features/activity/components/AuditActivity.vue'

afterEach(() => vi.unstubAllGlobals())

const render = (actor: Actor, agentName: string | null) => {
  vi.stubGlobal('computed', vue.computed)
  const entry: AuditEntry = { id: 1, projectId: null, taskId: null, action: 'epic.updated', detail: {}, createdAt: new Date().toISOString(), actor, agentName }
  const wrapper = mount(AuditActivity, {
    props: { entry, text: 'edited the epic' },
    global: { stubs: { NuxtLink: true, AgentAvatar: { props: ['name'], template: '<i data-testid="avatar">{{ name }}</i>' } } }
  })
  return { text: wrapper.get('[data-testid="audit-activity"] p').text().replace(/\s+/g, ' '), avatar: wrapper.get('[data-testid="avatar"]').text() }
}

it.each(AGENT_ROLES)('attributes a %s action to the agent that acted', (role) => {
  expect(render({ kind: 'agent', role, runId: 'r1' }, 'Nova')).toMatchObject({ avatar: 'Nova', text: expect.stringContaining('Nova edited the epic') })
})

it.each(AGENT_ROLES)('falls back to the %s role label when the agent is gone', (role) => {
  expect(render({ kind: 'agent', role, runId: 'r1' }, null)).toMatchObject({ avatar: ROLE[role], text: expect.stringContaining(`${ROLE[role]} edited the epic`) })
})

it('shows an action confirmed through the PM as the PM\'s, confirmed by you', () => {
  const viaPm: Actor = { kind: 'human', userId: 'u1', viaPm: { sessionId: 's1', runId: 'r1' } }
  expect(render(viaPm, 'Juno')).toMatchObject({ avatar: 'Juno', text: expect.stringContaining('Juno · confirmed by you edited the epic') })
  expect(render(viaPm, null)).toMatchObject({ avatar: 'PM', text: expect.stringContaining('PM · confirmed by you edited the epic') })
})
