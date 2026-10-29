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

  it('does not restate a proposed plan the panel already shows', () => {
    expect(pm).toContain('The human sees the proposed plan in a panel beside the chat, so after propose_plan don\'t restate its tasks as a table or list')
    expect(pm).toContain('reply with only what the panel doesn\'t show')
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
  it('requires independent checks without the Turbo cache or an explanation', () => {
    const reviewer = DEFAULT_ROLE_INSTRUCTIONS.reviewer
    expect(reviewer).toContain('Run the project\'s lint, typecheck and tests yourself before reporting')
    for (const check of ['lint', 'typecheck', 'test']) {
      expect(reviewer).toContain(`TURBO_FORCE=1 pnpm run ${check}`)
    }
    expect(reviewer).toContain('A cache hit replays the developer\'s results and does not verify the change')
    expect(reviewer).toContain('If you cannot run a check without the cache, explain which check and why in your outcome')
  })

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
