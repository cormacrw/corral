import { describe, expect, it } from 'vitest'
import { pmFallbackPrompt, pmPrompt } from './prompts.ts'

const turn = { text: 'hi', attachedTask: null, projectName: 'Test app', prefix: 'TA' }

describe('pmPrompt', () => {
  it('only adds the intro on a fresh session', () => {
    expect(pmPrompt({ ...turn, fresh: false })).toBe('hi')
    expect(pmPrompt({ ...turn, fresh: true })).toMatch(/^You are the product-manager agent for the project "Test app"/)
  })

  it('answers simple messages directly and reads code only when needed', () => {
    const intro = pmPrompt({ ...turn, fresh: true })
    expect(intro).toContain('Answer greetings, status questions and anything you can answer from the board')
    expect(intro).toContain('without reading the repo')
    expect(intro).toContain('Read the code only when a request needs planning or code knowledge, and then only the parts that matter')
  })

  it('describes the project docs as optional', () => {
    const intro = pmPrompt({ ...turn, fresh: true })
    expect(intro).toContain('CORRAL.md or CLAUDE.md, and .corral/wiki/ if present')
    expect(intro).not.toContain('read CORRAL.md, .corral/wiki/ and the code before planning')
  })

  it('keeps the planning, review and approval rules', () => {
    const intro = pmPrompt({ ...turn, fresh: true })
    expect(intro).toContain('Task IDs look like TA-12')
    expect(intro).toContain('list_tasks shows it live')
    expect(intro).toContain('Propose work with propose_plan (one epic per separate feature, small tasks, one PR each, descriptions in markdown, verifiable acceptance criteria, explicit dependencies')
    expect(intro).toContain('To refine an existing Backlog task, read it with get_task and include it in the plan with its `ref`')
    expect(intro).toContain('humanReview true for auth, data migrations, payments, deletions and security-sensitive code')
    expect(intro).toContain('Ask with ask_question when requirements are ambiguous')
    expect(intro).toContain('only then may you call approve_plan ("ready" for the board, "backlog" for later)')
    expect(intro).toContain('Never approve on your own initiative')
    expect(intro).toContain('Keep replies short and concrete')
  })

  it('points at an attached task', () => {
    expect(pmPrompt({ ...turn, attachedTask: 'TA-3', fresh: false })).toBe('(About task TA-3; read it with get_task.)\n\nhi')
  })
})

describe('pmFallbackPrompt', () => {
  it('reuses the fresh intro and carries the earlier conversation', () => {
    const prompt = pmFallbackPrompt({ ...turn, history: [{ role: 'human', text: 'earlier' }, { role: 'human', text: 'hi' }] })
    expect(prompt.startsWith(pmPrompt({ ...turn, fresh: true }))).toBe(true)
    expect(prompt).toContain('**human:** earlier')
  })
})
