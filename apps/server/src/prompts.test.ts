import { describe, expect, it } from 'vitest'
import { designRevisionPrompt, developerPrompt, developerRevisionPrompt, isGrillRequest, pmFallbackPrompt, pmPrompt, questionText, reviewerPrompt, type PromptTask } from './prompts.ts'

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

  it('tells the PM not to restate a proposed plan the panel already shows', () => {
    const intro = pmPrompt({ ...turn, fresh: true })
    expect(intro).toContain('The human sees the proposed plan in a panel beside the chat')
    expect(intro).toContain('after propose_plan don\'t restate its tasks as a table or list')
    expect(intro).toContain('reply with only what the panel doesn\'t show, such as open questions, assumptions or trade-offs, in a sentence or two')
    expect(pmPrompt({ ...turn, fresh: false })).not.toContain('propose_plan')
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
  const review = { ...task, headSha: 'abc', prUrl: null, evidence: [], previousFeedback: null, requiredChecks: ['ci'] }
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
  const review = { ...task, headSha: 'findings-r1', prUrl: null, evidence: [], previousFeedback: null, requiredChecks: ['ci'], findings: '**Answer:** Use pg-boss.' }

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

describe('reviewer evidence list', () => {
  const task = {
    ref: 'TA-1',
    title: 'Refactor login',
    description: null,
    branch: 'corral/ta-1-refactor',
    defaultBranch: 'main',
    reviewRounds: 0,
    reviewRoundCap: 3,
    criteria: [{ id: 'c1', text: 'Login works as before' }, { id: 'c2', text: 'Shows the form' }],
    comments: [],
    attachments: [],
    headSha: 'abc',
    prUrl: null,
    previousFeedback: null,
    requiredChecks: ['ci']
  }

  it('shows the text of a note inline, and files by name (D21)', () => {
    const prompt = reviewerPrompt({
      ...task,
      evidence: [
        { id: 'e1', criterionId: 'c1', kind: 'note', note: 'No behaviour change: only moved code.\nSee src/login.ts:12.', fileName: null },
        { id: 'e2', criterionId: 'c2', kind: 'screenshot', note: 'The form', fileName: 'form.png' }
      ]
    }, 'Rita')
    expect(prompt).toContain([
      '- e1: note (no file; judge the explanation) for [c1]:',
      '  No behaviour change: only moved code.',
      '  See src/login.ts:12.',
      '- e2: screenshot "form.png" for [c2] — The form'
    ].join('\n'))
  })
})

describe('reviewer gates (D26)', () => {
  const task = {
    ref: 'TA-1',
    title: 'Login',
    description: null,
    branch: 'corral/ta-1-login',
    defaultBranch: 'main',
    reviewRounds: 0,
    reviewRoundCap: 3,
    criteria: [{ id: 'c1', text: 'Works' }],
    comments: [],
    attachments: [],
    headSha: 'abc',
    prUrl: null,
    evidence: [],
    previousFeedback: null
  }

  it('leaves the gates to required CI and points the reviewer at the diff', () => {
    const prompt = reviewerPrompt({ ...task, requiredChecks: ['ci', 'e2e'] }, 'Rita')
    expect(prompt).toContain('This project has required CI checks: `ci`, `e2e`')
    expect(prompt).toContain('don\'t rerun the project\'s lint, typecheck, tests or build')
    expect(prompt).toContain('security, efficiency and logic problems')
    expect(prompt).toContain('A cached result never counts as verification')
    expect(prompt).not.toContain('TURBO_FORCE')
    expect(prompt).not.toContain('Check the project\'s lint, typecheck and tests pass')
  })

  it('has the reviewer run the gates without the cache when nothing else does', () => {
    const prompt = reviewerPrompt({ ...task, requiredChecks: [] }, 'Rita')
    expect(prompt).toContain('This project has no required CI checks')
    expect(prompt).toContain('Run the project\'s lint, typecheck, tests and build yourself before reporting, without the cache')
    for (const check of ['lint', 'typecheck', 'test', 'build']) {
      expect(prompt).toContain(`TURBO_FORCE=1 pnpm run ${check}`)
    }
    expect(prompt).toContain('If you cannot run a check without the cache, explain which check and why in your outcome')
  })

  it('stays out of spikes and designs, which have no diff to gate', () => {
    for (const extra of [{ spike: true }, { design: { version: 1 } }]) {
      const prompt = reviewerPrompt({ ...task, ...extra, requiredChecks: [] }, 'Rita')
      expect(prompt).not.toContain('## Gates')
      expect(prompt).not.toContain('TURBO_FORCE')
    }
  })
})

describe('D21 evidence guidance', () => {
  const task: PromptTask = {
    ref: 'TA-1', title: 'Refactor', description: null, branch: 'corral/ta-1',
    defaultBranch: 'main', reviewRounds: 0, reviewRoundCap: 3,
    criteria: [{ id: 'c1', text: 'Preserves behaviour' }], comments: [], attachments: []
  }

  it('keeps checks as gates and explains when a developer can use a note', () => {
    const prompt = developerPrompt(task, 'Tam')
    expect(prompt).toContain('Run the project\'s lint, typecheck and tests before reporting')
    expect(prompt).toContain('screenshots or video for anything visible, real requests and responses for APIs')
    expect(prompt).toContain('Use kind `note` only when there is nothing to show')
    expect(prompt).toContain('what changed and how it was checked, with file and line references')
    expect(prompt).toContain('never attach their output as criterion evidence')
    expect(prompt).not.toContain('test output otherwise')
  })

  it('requires concrete reviewer notes and rejects unsuitable proof on every review path', () => {
    for (const extra of [{}, { spike: true }, { design: { version: 1 } }]) {
      const prompt = reviewerPrompt({
        ...task, ...extra, headSha: 'abc', prUrl: null, evidence: [], previousFeedback: null, requiredChecks: ['ci']
      }, 'Rita')
      expect(prompt).toContain('Give every criterion a concrete note explaining why it is met or not')
      expect(prompt).toContain('the human reads it next to the evidence')
      expect(prompt).toContain('Request changes when a visibly testable criterion is proven only by a note')
      expect(prompt).toContain('when a criterion\'s only proof is test output')
      expect(prompt).not.toContain('each criterion note is a few words')
    }
  })

  it('lets spike findings cite relevant command excerpts in a note', () => {
    expect(developerPrompt({ ...task, spike: true, branch: null }, 'Tam'))
      .toContain('Findings may cite command output: attach it as a note with the relevant excerpt rather than a full log where possible')
  })

  it('asks the PM for observable behaviour instead of passing gates', () => {
    const prompt = pmPrompt({ ...turn, fresh: true })
    expect(prompt).toContain('Write acceptance criteria as observable behaviour')
    expect(prompt).toContain('Do not write criteria that only restate lint, typecheck, tests or build passing')
    expect(prompt).toContain('the gates already cover those checks')
  })
})

describe('rebase-only developer prompts', () => {
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
  it('limits both fresh and resumed sessions to the rebase, even after revision rounds', () => {
    const rebase = { ...task, rebaseOnly: true, approvedHeadSha: 'approved-head', reviewRounds: 3, defaultBranch: 'epic/release' }
    for (const prompt of [developerPrompt(rebase, 'Tam'), developerRevisionPrompt(rebase, [])]) {
      expect(prompt).toContain('rebase-only round from approved head approved-head')
      expect(prompt).toContain('origin/epic/release')
      expect(prompt).toContain('Make no other changes')
      expect(prompt).toContain('main\'s')
      expect(prompt).toContain('lint, typecheck, tests and build')
      expect(prompt).toContain('git merge-tree --write-tree HEAD origin/epic/release')
      expect(prompt).toContain('pr_rebased')
      expect(prompt).toContain('naming every conflicted file and how each was resolved')
      expect(prompt).not.toContain('pr_updated')
      expect(prompt).not.toContain('requested changes')
    }
  })
})

describe('continuing a stopped run', () => {
  const task: PromptTask = {
    ref: 'TA-1', title: 'Add login', description: null, branch: 'corral/ta-1', defaultBranch: 'main', reviewRounds: 0, reviewRoundCap: 3, criteria: [], comments: [], attachments: []
  }
  const stoppedRun = { number: 12, reason: 'The run hit its time limit of 60 minutes', wipSha: 'abc123def' }

  it('says nothing after a run that reported', () => {
    expect(developerPrompt(task, 'Dev')).not.toContain('stopped')
    expect(developerRevisionPrompt(task, [])).not.toContain('stopped')
  })

  it('names the run, the stop reason and the WIP commit in every developer prompt', () => {
    const prompts = [
      developerPrompt({ ...task, stoppedRun }, 'Dev'),
      developerPrompt({ ...task, stoppedRun, design: { version: null } }, 'Dev'),
      developerRevisionPrompt({ ...task, stoppedRun }, []),
      designRevisionPrompt({ ...task, stoppedRun, design: { version: 1 } }, [])
    ]
    for (const prompt of prompts) {
      expect(prompt).toContain('## Continuing a stopped run')
      expect(prompt).toContain('You are continuing run #12, which stopped before it reported an outcome. Stop reason: The run hit its time limit of 60 minutes')
      expect(prompt).toContain('WIP commit `abc123def`')
    }
  })

  it('names no commit when the stopped run saved none', () => {
    const prompt = developerPrompt({ ...task, stoppedRun: { ...stoppedRun, wipSha: null } }, 'Dev')
    expect(prompt).toContain('Stop reason: The run hit its time limit')
    expect(prompt).toContain('No WIP commit was saved')
  })
})
