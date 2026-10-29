import { describe, expect, it } from 'vitest'
import { developerPrompt, isGrillRequest, pmFallbackPrompt, pmPrompt, questionText, reviewerPrompt, type PromptTask } from './prompts.ts'

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
    expect(intro).toContain('`bug` for a fix to wrong behaviour, `spike` for an investigation whose deliverable is written findings, and `task` for everything else')
    expect(intro).toContain('Propose work with propose_plan (group a multi-task feature into an epic and leave a lone small fix without one, small tasks, one PR each, descriptions in markdown, verifiable acceptance criteria, explicit dependencies')
    expect(intro).toContain('To refine an existing Backlog task, read it with get_task and include it in the plan with its `ref`')
    expect(intro).toContain('humanReview true for auth, data migrations, payments, deletions and security-sensitive code')
    expect(intro).toContain('Ask with ask_question when requirements are ambiguous')
    expect(intro).toContain('only then may you call approve_plan ("ready" for the board, "backlog" for later)')
    expect(intro).toContain('Never approve on your own initiative')
    expect(intro).toContain('Keep replies short and concrete')
  })

  it('plans a design\'s build from the spec and the codebase, across epics, pinning screens (D20)', () => {
    const intro = pmPrompt({ ...turn, fresh: true })
    expect(intro).toContain('read it with get_design')
    expect(intro).toContain('Plan from the spec and the real codebase')
    expect(intro).toContain('a reference for the look, not code to copy')
    expect(intro).toContain('split the build across several epics')
    expect(intro).toContain('pin every task that builds UI to the approved version and the screen ids')
    expect(intro).toContain('write its acceptance criteria from the spec')
  })

  it('points at an attached task', () => {
    expect(pmPrompt({ ...turn, attachedTask: 'TA-3', fresh: false })).toBe('(About task TA-3; read it with get_task.)\n\nhi')
  })
})

describe('pmPrompt grilling', () => {
  it('recognises a request to be grilled', () => {
    for (const text of ['grill me on CSV export', 'Grill me', '/grill-me', 'Can you grill-me about this?', '/grill-me CSV export']) {
      expect(isGrillRequest(text), text).toBe(true)
    }
    for (const text of ['hi', 'plan CSV export', 'add a grill to the menu', 'grilled cheese', 'grillme.com']) {
      expect(isGrillRequest(text), text).toBe(false)
    }
  })

  it('adds the grill-me instructions only when asked', () => {
    const prompt = pmPrompt({ ...turn, text: 'grill me on CSV export', fresh: false })
    expect(prompt).toContain('Follow the grill-me skill, adapted to Corral')
    expect(prompt).toContain('work through them in dependency order')
    expect(prompt).toContain('Ask exactly one question per ask_question call, always with a `recommendation`, and with `options` whenever the answer can be picked from a list')
    expect(prompt).toContain('Answer anything you can from the code or the board yourself')
    expect(prompt).toContain('call propose_plan right away, without first asking whether to plan, and list the agreed decisions in the plan summary')
    expect(prompt.endsWith('grill me on CSV export')).toBe(true)
    expect(pmPrompt({ ...turn, fresh: true })).not.toContain('grill')
  })

  it('keeps the fresh intro first and the grill instructions before the message', () => {
    const prompt = pmPrompt({ ...turn, text: '/grill-me', attachedTask: 'TA-3', fresh: true })
    expect(prompt.startsWith(pmPrompt({ ...turn, fresh: true }).replace(/hi$/, ''))).toBe(true)
    expect(prompt.endsWith('(About task TA-3; read it with get_task.)\n\n/grill-me')).toBe(true)
  })

  it('stays runtime-neutral', () => {
    const prompt = pmPrompt({ ...turn, text: 'grill me', fresh: false })
    expect(prompt).not.toMatch(/Skill tool|Claude|Codex/)
  })

  it('keeps grilling when a lost session is rebuilt mid-interview', () => {
    const history = [{ role: 'Human', text: 'grill me on exports' }, { role: 'PM (question)', text: 'Which format?' }, { role: 'Human', text: '1' }]
    expect(pmFallbackPrompt({ ...turn, text: '1', history })).toContain('Follow the grill-me skill')
    expect(pmFallbackPrompt({ ...turn, history: [{ role: 'Human', text: 'hi' }] })).not.toContain('grill')
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

describe('questionText', () => {
  it('leaves a plain question as it is', () => {
    expect(questionText({ text: 'Who uses exports?', recommendation: null, options: null })).toBe('Who uses exports?')
  })

  it('numbers the options and adds the recommendation', () => {
    expect(questionText({ text: 'Which format?', recommendation: 'CSV', options: ['CSV', 'Excel'] })).toBe('Which format?\n\nOptions:\n1. CSV\n2. Excel\n\nRecommended: CSV')
  })
})

// D19: a spike's agents work on findings, not a branch and a PR
describe('spike prompts', () => {
  const task: PromptTask = {
    ref: 'TA-2',
    title: 'Which queue?',
    description: null,
    branch: null,
    spike: true,
    defaultBranch: 'main',
    reviewRounds: 0,
    reviewRoundCap: 5,
    criteria: [{ id: 'c1', text: 'Names a queue' }],
    comments: [],
    attachments: []
  }
  const review = { ...task, headSha: 'findings-r1', prUrl: null, evidence: [], previousFeedback: null, findings: '**Answer:** Use pg-boss.' }

  it('tells the developer to investigate without changing code and report findings', () => {
    const prompt = developerPrompt(task, 'Victor')
    expect(prompt).toContain('spike TA-2: Which queue?')
    expect(prompt).toContain('Investigate; don\'t change code')
    expect(prompt).toContain('don\'t commit or push, and no PR is opened')
    expect(prompt).toContain('outcome "findings_reported"')
    expect(prompt).toContain('**Answer**')
    expect(prompt).toContain('**Evidence**')
    expect(prompt).toContain('**Recommendation**')
    expect(prompt).toContain('**Suggested follow-up tasks**')
    expect(prompt).toContain('- [c1] Names a queue')
    expect(prompt).not.toContain('pr_opened')
    expect(prompt).not.toContain('pull request')
  })

  it('asks a revision for the complete findings again', () => {
    const prompt = developerPrompt({ ...task, reviewRounds: 1 }, 'Victor')
    expect(prompt).toContain('requested changes to your findings')
    expect(prompt).toContain('they replace the earlier ones')
    expect(prompt).not.toContain('pr_updated')
  })

  it('tells the reviewer to check the findings against every criterion and the evidence, with no diff', () => {
    const prompt = reviewerPrompt(review, 'Rita')
    expect(prompt).toContain('spike TA-2')
    expect(prompt).toContain('There is no branch, diff or PR')
    expect(prompt).toContain('## Findings under review\n\n**Answer:** Use pg-boss.')
    expect(prompt).toContain('do the findings answer it')
    expect(prompt).toContain('backed by evidence')
    expect(prompt).not.toContain('git diff')
    expect(prompt).not.toContain('findings-r1')
  })

  it('leaves plain task prompts on the PR path', () => {
    const plain = { ...task, branch: 'corral/ta-2-queue', spike: false }
    expect(developerPrompt(plain, 'Victor')).toContain('outcome "pr_opened"')
    expect(developerPrompt(plain, 'Victor')).not.toContain('findings_reported')
    expect(reviewerPrompt({ ...review, ...plain, headSha: 'abc' }, 'Rita')).toContain('git diff main...HEAD')
    expect(reviewerPrompt({ ...review, ...plain, headSha: 'abc' }, 'Rita')).not.toContain('Findings under review')
  })

  it('tells the PM a finished spike’s findings can become a plan', () => {
    const intro = pmPrompt({ ...turn, fresh: true })
    expect(intro).toContain('A spike opens no PR')
    expect(intro).toContain('turn them into a plan with propose_plan')
  })
})
