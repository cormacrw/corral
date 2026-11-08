import { HUMAN_DECISIONS_NOTE } from '@corral/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_INSTRUCTIONS } from './agent-instructions.ts'

// The built-in instructions are static text. These tests check the contracts
// they carry (tool and outcome names, the shared decisions note) and what they
// must leave out, not their wording.

const roles = ['designer', 'developer', 'reviewer', 'pm'] as const

describe('default role instructions', () => {
  it.each(roles)('carry the human decisions note and the attachment tool for the %s', (role) => {
    expect(DEFAULT_ROLE_INSTRUCTIONS[role]).toContain(HUMAN_DECISIONS_NOTE)
    expect(DEFAULT_ROLE_INSTRUCTIONS[role]).toContain('get_attachment')
  })

  it('name no repository\'s tools, leaving checks to the task prompt', () => {
    for (const instructions of Object.values(DEFAULT_ROLE_INSTRUCTIONS)) expect(instructions).not.toMatch(/pnpm|Turbo|Postgres/)
  })

  it('stay runtime-neutral', () => {
    for (const instructions of Object.values(DEFAULT_ROLE_INSTRUCTIONS)) expect(instructions).not.toMatch(/Claude|Codex/)
  })

  it('give the designer its outcome, and keep it out of the developer\'s', () => {
    expect(DEFAULT_ROLE_INSTRUCTIONS.designer).toContain('"design_submitted"')
    for (const text of ['submit_design', 'design_submitted', 'design.md', 'prototype', 'design/']) {
      expect(DEFAULT_ROLE_INSTRUCTIONS.developer).not.toContain(text)
    }
  })

  it.each(['developer', 'reviewer'] as const)('point the %s at agent-browser for visible evidence', (role) => {
    expect(DEFAULT_ROLE_INSTRUCTIONS[role]).toContain('agent-browser')
  })
})
