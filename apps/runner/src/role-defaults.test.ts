import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_INSTRUCTIONS } from './role-defaults.ts'

describe('pm role defaults', () => {
  const pm = DEFAULT_ROLE_INSTRUCTIONS.pm

  it('replies directly and reads only what a request needs', () => {
    expect(pm).toContain('Answer greetings, status questions and anything the board can answer directly, without reading the repo')
    expect(pm).toContain('read only the relevant parts')
  })

  it('describes the project docs as optional', () => {
    expect(pm).toContain('CORRAL.md or CLAUDE.md, and .corral/wiki/ if present')
    expect(pm).not.toContain('Read CORRAL.md, the wiki')
  })
})

describe('developer role defaults', () => {
  it('leaves the git identity to the runner', () => {
    expect(DEFAULT_ROLE_INSTRUCTIONS.developer).toContain('Don\'t set or change the git identity')
  })

  it('captures visible evidence with agent-browser', () => {
    const developer = DEFAULT_ROLE_INSTRUCTIONS.developer
    expect(developer).toContain('use agent-browser')
    expect(developer).toContain('run `agent-browser skills get core` once')
    expect(developer).toContain('capture screenshots or video with it and attach them with attach_evidence')
    expect(developer).toContain('run `agent-browser close`')
  })
})

describe('reviewer role defaults', () => {
  it('reproduces visible criteria with agent-browser', () => {
    const reviewer = DEFAULT_ROLE_INSTRUCTIONS.reviewer
    expect(reviewer).toContain('To reproduce a visible criterion, start the app and use agent-browser')
    expect(reviewer).toContain('run `agent-browser skills get core` once')
    expect(reviewer).toContain('run `agent-browser close`')
  })
})

describe('attachments in role defaults', () => {
  it('tells every role to view attached images', () => {
    for (const role of ['developer', 'reviewer', 'pm'] as const) {
      expect(DEFAULT_ROLE_INSTRUCTIONS[role]).toContain('Images attached by the human are part of the requirements; view them with get_attachment.')
    }
  })
})
