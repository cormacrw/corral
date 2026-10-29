import { describe, expect, it } from 'vitest'
import { developerPrompt, pmFallbackPrompt, pmPrompt, reviewerPrompt, type PromptTask } from './prompts.ts'

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

describe('pmPrompt attachments', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'

  it('lists every attached image and says to fetch them with get_attachment', () => {
    const prompt = pmPrompt({ ...turn, text: `Build this ![login](attachment:${a}) and attachment:${b}`, fresh: false })
    expect(prompt).toBe(`(This message has 2 attached images: ${a}, ${b}. Fetch each with get_attachment before answering.)\n\nBuild this ![login](attachment:${a}) and attachment:${b}`)
  })

  it('names a single image once, after the attached task', () => {
    const prompt = pmPrompt({ ...turn, attachedTask: 'TA-3', text: `![x](attachment:${a}) again ![x](attachment:${a})`, fresh: false })
    expect(prompt.startsWith(`(About task TA-3; read it with get_task.)\n\n(This message has an attached image: ${a}. Fetch it with get_attachment before answering.)\n\n`)).toBe(true)
  })

  it('leaves a message without attachments unchanged', () => {
    expect(pmPrompt({ ...turn, text: 'see https://example.com/a.png', fresh: false })).toBe('see https://example.com/a.png')
  })
})

describe('developer and reviewer attachments', () => {
  const task: PromptTask = {
    ref: 'TA-1',
    title: 'Login',
    description: null,
    branch: 'corral/ta-1-login',
    defaultBranch: 'main',
    reviewRounds: 0,
    reviewRoundCap: 3,
    criteria: [{ id: 'c1', text: 'Works' }],
    comments: [],
    attachments: []
  }
  const review = { ...task, headSha: 'abc', prUrl: null, evidence: [], previousFeedback: null }
  const attachments = [
    { id: '11111111-1111-4111-8111-111111111111', fileName: 'mockup.png', foundIn: ['the description'] },
    { id: '22222222-2222-4222-8222-222222222222', fileName: 'bug.jpg', foundIn: ['a comment by human (2026-10-01T00:00:00.000Z)'] }
  ]
  const expected = [
    '## Attached images',
    '',
    'Images attached by the human are part of the requirements; view each with `get_attachment` before you start.',
    '',
    '- 11111111-1111-4111-8111-111111111111: "mockup.png" in the description',
    '- 22222222-2222-4222-8222-222222222222: "bug.jpg" in a comment by human (2026-10-01T00:00:00.000Z)'
  ].join('\n')

  it('lists images from the description and comments for the developer', () => {
    expect(developerPrompt({ ...task, attachments }, 'Victor')).toContain(expected)
  })

  it('lists them for the reviewer too', () => {
    expect(reviewerPrompt({ ...review, attachments }, 'Rita')).toContain(expected)
  })

  it('adds nothing when there are none', () => {
    expect(developerPrompt(task, 'Victor')).not.toContain('Attached images')
    expect(reviewerPrompt(review, 'Rita')).not.toContain('Attached images')
    expect(developerPrompt(task, 'Victor')).not.toContain('get_attachment')
  })
})

describe('pmFallbackPrompt', () => {
  it('reuses the fresh intro and carries the earlier conversation', () => {
    const prompt = pmFallbackPrompt({ ...turn, history: [{ role: 'human', text: 'earlier' }, { role: 'human', text: 'hi' }] })
    expect(prompt.startsWith(pmPrompt({ ...turn, fresh: true }))).toBe(true)
    expect(prompt).toContain('**human:** earlier')
  })
})
