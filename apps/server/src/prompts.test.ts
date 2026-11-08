import { HUMAN_DECISIONS_NOTE } from '@corral/core'
import { describe, expect, it } from 'vitest'
import { cappedBranchDiff, designerPrompt, designerRevisionPrompt, developerCheckScope, developerPrompt, developerRevisionPrompt, epicFixCheckScope, epicFixPrompt, epicReviewCiSection, epicReviewPrompt, isGrillRequest, pmFallbackPrompt, pmPrompt, questionText, reviewerPrompt, type PmHistoryMessage, type PromptTask } from './prompts.ts'

// These tests check what a prompt is built from: the data it carries, and which
// conditional sections it has. The wording itself is left free to change.

const guidance = pmPrompt({ text: '', attachedTask: null, projectName: null, prefix: null, fresh: false })
const turn = { text: 'hi', attachedTask: null, projectName: 'Test app', prefix: 'TA' }

const task: PromptTask = {
  ref: 'TA-1', title: 'Login', description: null, branch: 'corral/ta-1-login', defaultBranch: 'main',
  reviewRounds: 0, reviewRoundCap: 3, criteria: [{ id: 'c1', text: 'Works' }], comments: [], attachments: []
}
const review = { ...task, headSha: 'abc', prUrl: null, evidence: [], previousFeedback: null, requiredChecks: ['ci'] }

describe('pmPrompt', () => {
  it('adds only the role guidance to a resumed session, and the project on a fresh one', () => {
    expect(pmPrompt({ ...turn, fresh: false })).toBe(`${guidance}hi`)
    const fresh = pmPrompt({ ...turn, fresh: true })
    expect(fresh).toContain('"Test app"')
    expect(pmPrompt({ ...turn, projectName: null, prefix: null, fresh: true })).not.toContain('Test app')
  })

  it.each([
    { projectName: 'Test app', prefix: 'TA' },
    { projectName: 'Another project', prefix: 'OTHER' }
  ])('names $projectName and its task prefix on a fresh session', (project) => {
    const intro = pmPrompt({ ...turn, ...project, fresh: true })
    expect(intro).toContain(project.projectName)
    expect(intro).toContain(`${project.prefix}-`)
  })

  it.each([
    ['new project session', pmPrompt({ ...turn, fresh: true })],
    ['resumed project session', pmPrompt({ ...turn, fresh: false })],
    ['new global session', pmPrompt({ ...turn, projectName: null, prefix: null, fresh: true })],
    ['resumed global session', pmPrompt({ ...turn, projectName: null, prefix: null, fresh: false })],
    ['lost session', pmFallbackPrompt({ ...turn, history: [{ role: 'human', kind: 'message', text: 'hi' }] })]
  ])('gives a %s the role guidance and ends with the message', (_name, prompt) => {
    expect(prompt).toContain(guidance)
    expect(prompt.endsWith('hi')).toBe(true)
  })

  it('points at an attached task before the message', () => {
    const prompt = pmPrompt({ ...turn, attachedTask: 'TA-3', fresh: false })
    expect(prompt.startsWith(guidance)).toBe(true)
    expect(prompt).toContain('TA-3')
    expect(prompt).toContain('get_task')
    expect(prompt.endsWith('hi')).toBe(true)
  })

  // People see tasks and subtasks; literal branch names keep their identifiers
  it.each([
    { fresh: true, projectName: 'Test app', prefix: 'TA' },
    { fresh: true, projectName: null, prefix: null },
    { fresh: false, projectName: 'Test app', prefix: 'TA' }
  ])('keeps "epic" out of the PM prompt: %o', (turn) => {
    const prompt = pmPrompt({ text: 'Hello', attachedTask: null, ...turn })
    expect(prompt.replaceAll('corral/epic-', '')).not.toMatch(/\bepics?\b|update_epic/i)
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
    const text = 'grill me on CSV export'
    const prompt = pmPrompt({ ...turn, text, fresh: false })
    expect(prompt.startsWith(guidance)).toBe(true)
    expect(prompt.endsWith(text)).toBe(true)
    expect(prompt.length).toBeGreaterThan(guidance.length + text.length)
    expect(prompt).toContain('grill-me')
    expect(pmPrompt({ ...turn, fresh: true })).not.toContain('grill')
  })

  it('keeps the fresh intro first, then the grill instructions, then the attached task and message', () => {
    const prompt = pmPrompt({ ...turn, text: '/grill-me', attachedTask: 'TA-3', fresh: true })
    expect(prompt.startsWith(pmPrompt({ ...turn, fresh: true }).replace(/hi$/, ''))).toBe(true)
    expect(prompt.lastIndexOf('grill-me skill')).toBeLessThan(prompt.indexOf('TA-3'))
    expect(prompt.endsWith('/grill-me')).toBe(true)
  })

  it('stays runtime-neutral', () => {
    expect(pmPrompt({ ...turn, text: 'grill me', fresh: false })).not.toMatch(/Skill tool|Claude|Codex/)
  })

  it('keeps grilling when a lost session is rebuilt mid-interview', () => {
    const history = [{ role: 'human', kind: 'message', text: 'grill me on exports' }, { role: 'pm', kind: 'question', text: 'Which format?' }, { role: 'human', kind: 'message', text: '1' }] satisfies PmHistoryMessage[]
    expect(pmFallbackPrompt({ ...turn, text: '1', history })).toContain('grill-me')
    expect(pmFallbackPrompt({ ...turn, history: [{ role: 'human', kind: 'message', text: 'hi' }] })).not.toContain('grill')
  })
})

describe('pmPrompt attachments', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  const count = (text: string, part: string) => text.split(part).length - 1

  it('lists every attached image before the message', () => {
    const text = `Build this ![login](attachment:${a}) and attachment:${b}`
    const prompt = pmPrompt({ ...turn, text, fresh: false })
    const note = prompt.slice(guidance.length, -text.length)
    expect(note).toContain(a)
    expect(note).toContain(b)
    expect(note).toContain('get_attachment')
    expect(prompt.endsWith(text)).toBe(true)
  })

  it('names a repeated image once, after the attached task', () => {
    const text = `![x](attachment:${a}) again ![x](attachment:${a})`
    const prompt = pmPrompt({ ...turn, attachedTask: 'TA-3', text, fresh: false })
    const note = prompt.slice(guidance.length, -text.length)
    expect(count(note, a)).toBe(1)
    expect(note.indexOf('TA-3')).toBeLessThan(note.indexOf(a))
  })

  it('leaves a message without attachments unchanged', () => {
    expect(pmPrompt({ ...turn, text: 'see https://example.com/a.png', fresh: false })).toBe(`${guidance}see https://example.com/a.png`)
  })
})

describe('pmFallbackPrompt', () => {
  it('reuses the fresh intro and carries the earlier conversation', () => {
    const prompt = pmFallbackPrompt({ ...turn, history: [{ role: 'human', kind: 'message', text: 'earlier' }, { role: 'human', kind: 'message', text: 'hi' }] })
    expect(prompt.startsWith(pmPrompt({ ...turn, fresh: true }))).toBe(true)
    expect(prompt).toContain('earlier')
  })
})

describe('questionText', () => {
  it('leaves a plain question as it is', () => {
    expect(questionText({ text: 'Who uses exports?', recommendation: null, options: null })).toBe('Who uses exports?')
  })

  it('numbers the options and adds the recommendation', () => {
    const text = questionText({ text: 'Which format?', recommendation: 'CSV', options: ['CSV', 'Excel'] })
    expect(text.startsWith('Which format?')).toBe(true)
    expect(text).toMatch(/1\. CSV\n2\. Excel/)
    expect(text).not.toBe(questionText({ text: 'Which format?', recommendation: null, options: ['CSV', 'Excel'] }))
  })
})

describe('implementation plan', () => {
  const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const planned = { description: doc('Let people sign in.'), implementationPlan: doc('Edit src/login.ts and keep the session cookie.') }

  it.each([
    ['developer', developerPrompt({ ...task, ...planned }, 'Victor')],
    ['reviewer', reviewerPrompt({ ...review, ...planned }, 'Rita')]
  ])('follows the task description in the %s prompt', (_name, prompt) => {
    const description = prompt.indexOf('Let people sign in.')
    const heading = prompt.indexOf('## Implementation plan')
    expect(description).toBeGreaterThan(-1)
    expect(heading).toBeGreaterThan(description)
    expect(prompt.indexOf('Edit src/login.ts and keep the session cookie.')).toBeGreaterThan(heading)
  })

  it.each([null, { type: 'doc', content: [] }])('is left out when the task has none (%j)', (implementationPlan) => {
    expect(developerPrompt({ ...task, implementationPlan }, 'Victor')).not.toContain('## Implementation plan')
    expect(reviewerPrompt({ ...review, implementationPlan }, 'Rita')).not.toContain('## Implementation plan')
  })
})

describe('developer and reviewer attachments', () => {
  const attachments = [
    { id: '11111111-1111-4111-8111-111111111111', fileName: 'mockup.png', foundIn: ['the description'] },
    { id: '22222222-2222-4222-8222-222222222222', fileName: 'bug.jpg', foundIn: ['a comment by human (2026-10-01T00:00:00.000Z)'] }
  ]

  it.each([
    ['developer', developerPrompt({ ...task, attachments }, 'Victor')],
    ['reviewer', reviewerPrompt({ ...review, attachments }, 'Rita')]
  ])('lists each image with where it was found for the %s', (_name, prompt) => {
    for (const attachment of attachments) {
      expect(prompt).toContain(attachment.id)
      expect(prompt).toContain(`"${attachment.fileName}"`)
      expect(prompt).toContain(attachment.foundIn[0])
    }
    expect(prompt).toContain('get_attachment')
  })

  it('adds nothing when there are none', () => {
    expect(developerPrompt(task, 'Victor')).not.toContain('get_attachment')
    expect(reviewerPrompt(review, 'Rita')).not.toContain('get_attachment')
  })

  describe('pinned human comments', () => {
    const comments = [
      { author: 'Human', body: 'Use the existing API', pinned: true, createdAt: new Date('2026-10-01T00:00:00.000Z') },
      { author: 'Rita', body: 'Pinned by the reviewer', pinned: true, createdAt: new Date('2026-10-02T00:00:00.000Z') }
    ]

    it.each([
      ['task', reviewerPrompt({ ...review, comments }, 'Rita')],
      ['rebase', reviewerPrompt({ ...review, comments, rebaseOnly: true, approvedHeadSha: 'old' }, 'Rita')],
      ['spike', reviewerPrompt({ ...review, comments, spike: true, branch: null }, 'Rita')],
      ['design', reviewerPrompt({ ...review, comments, design: { version: 1 } }, 'Rita')]
    ])('are context, not instructions, for the %s reviewer', (_name, prompt) => {
      for (const fact of ['Human', '2026-10-01T00:00:00.000Z', 'Use the existing API', 'Rita', 'Pinned by the reviewer']) expect(prompt).toContain(fact)
      expect(prompt).not.toContain('## Human instructions')
    })

    it.each([
      ['developer', developerPrompt({ ...task, comments }, 'Victor')],
      ['resumed developer', developerRevisionPrompt({ ...task, comments }, [])],
      ['designer', designerPrompt({ ...task, comments, design: { version: null } }, 'Dee')],
      ['resumed designer', designerRevisionPrompt({ ...task, comments, design: { version: 1 } }, [])]
    ])('are instructions for the %s', (_name, prompt) => {
      expect(prompt).toContain('## Human instructions')
      expect(prompt).toContain('Use the existing API')
    })
  })
})

// D19: a spike's agents work on findings, not a branch and a PR
describe('spike prompts', () => {
  const spike: PromptTask = { ...task, ref: 'TA-2', title: 'Which queue?', branch: null, spike: true, reviewRoundCap: 5, criteria: [{ id: 'c1', text: 'Names a queue' }] }
  const spikeReview = { ...spike, headSha: 'findings-r1', prUrl: null, evidence: [], previousFeedback: null, requiredChecks: ['ci'], findings: '**Answer:** Use pg-boss.' }

  it('has the developer report findings against the criteria, with no PR', () => {
    const prompt = developerPrompt(spike, 'Victor')
    expect(prompt).toContain('TA-2')
    expect(prompt).toContain('Which queue?')
    expect(prompt).toContain('[c1] Names a queue')
    expect(prompt).toContain('"findings_reported"')
    expect(prompt).not.toContain('pr_opened')
  })

  it('changes a revision round without moving it onto the PR path', () => {
    const revision = developerPrompt({ ...spike, reviewRounds: 1 }, 'Victor')
    expect(revision).not.toBe(developerPrompt(spike, 'Victor'))
    expect(revision).not.toContain('pr_updated')
  })

  it('shows the reviewer the findings, with no diff or head', () => {
    const prompt = reviewerPrompt(spikeReview, 'Rita')
    expect(prompt).toContain('TA-2')
    expect(prompt).toContain('**Answer:** Use pg-boss.')
    expect(prompt).not.toContain('git diff')
    expect(prompt).not.toContain('findings-r1')
  })

  it('leaves plain task prompts on the PR path', () => {
    const plain = { ...spike, branch: 'corral/ta-2-queue', spike: false }
    expect(developerPrompt(plain, 'Victor')).toContain('"pr_opened"')
    expect(developerPrompt(plain, 'Victor')).not.toContain('findings_reported')
    const plainReview = reviewerPrompt({ ...spikeReview, ...plain, headSha: 'abc' }, 'Rita')
    expect(plainReview).toContain('main...HEAD')
    expect(plainReview).not.toContain('Use pg-boss')
  })
})

describe('reviewer evidence list', () => {
  it('shows the text of a note inline, and files by name (D21)', () => {
    const prompt = reviewerPrompt({
      ...review,
      criteria: [{ id: 'c1', text: 'Login works as before' }, { id: 'c2', text: 'Shows the form' }],
      evidence: [
        { id: 'e1', criterionId: 'c1', kind: 'note', note: 'No behaviour change: only moved code.\nSee src/login.ts:12.', fileName: null },
        { id: 'e2', criterionId: 'c2', kind: 'screenshot', note: 'The form', fileName: 'form.png' }
      ]
    }, 'Rita')
    expect(prompt).toContain('No behaviour change: only moved code.')
    expect(prompt).toContain('See src/login.ts:12.')
    expect(prompt).toMatch(/e2\b.*form\.png.*c2/)
  })
})

describe('reviewer gates (D26)', () => {
  it('names the required checks when the project has them', () => {
    const prompt = reviewerPrompt({ ...review, requiredChecks: ['ci', 'e2e'] }, 'Rita')
    expect(prompt).toContain('e2e')
    expect(reviewerPrompt(review, 'Rita')).not.toContain('e2e')
  })

  it('gives a different gates section with no required CI, naming no tools', () => {
    const none = reviewerPrompt({ ...review, requiredChecks: [] }, 'Rita')
    expect(none).not.toBe(reviewerPrompt(review, 'Rita'))
    expect(none).not.toMatch(/pnpm|TURBO/)
  })

  it('stays out of spikes and designs, which have no diff to gate', () => {
    for (const extra of [{ spike: true }, { design: { version: 1 } }]) {
      expect(reviewerPrompt({ ...review, ...extra, requiredChecks: [] }, 'Rita')).not.toContain('## Gates')
    }
    expect(reviewerPrompt({ ...review, requiredChecks: [] }, 'Rita')).toContain('## Gates')
  })
})

describe('how much a developer checks locally', () => {
  it('follows the project\'s required checks', () => {
    expect(developerCheckScope([], false)).toBeNull()
    expect(developerCheckScope([], true)).toBeNull()
    expect(developerCheckScope(['ci'], false)).toBe('targeted')
    expect(developerCheckScope(['ci'], true)).toBe('none')
    expect(epicFixCheckScope('conflict', ['ci'])).toBe('none')
    expect(epicFixCheckScope('ci', ['ci'])).toBe('targeted')
    expect(epicFixCheckScope('review', ['ci'])).toBe('targeted')
    expect(epicFixCheckScope('conflict', [])).toBeNull()
  })

  it('gives each scope its own instructions, on first attempts and revision rounds', () => {
    const scopes = [null, 'targeted', 'none'] as const
    const first = scopes.map(checkScope => developerPrompt({ ...task, checkScope }, 'Tam'))
    const revision = scopes.map(checkScope => developerRevisionPrompt({ ...task, checkScope, reviewRounds: 2 }, []))
    expect(new Set(first).size).toBe(3)
    expect(new Set(revision).size).toBe(3)
  })

  it('starts a CI fix round from what failed', () => {
    const failure = [{ name: 'Unit tests', url: null, step: 'Test', excerpt: 'FAIL src/a.test.ts' }]
    const prompt = developerRevisionPrompt({ ...task, checkScope: 'targeted', reviewRounds: 1, ciFailures: failure }, [])
    expect(prompt).toContain('FAIL src/a.test.ts')
  })

  it('gives a spike the same instructions whatever the scope', () => {
    const spike = { ...task, spike: true }
    expect(developerPrompt({ ...spike, checkScope: 'targeted' }, 'Tam')).toBe(developerPrompt({ ...spike, checkScope: null }, 'Tam'))
  })

  it('changes a task fix only when the project has required CI', () => {
    const input = { agentName: 'Tam', epicTitle: 'E', goal: '', brief: '', branch: 'c', epicBranch: 'e', target: 'main', ontoSha: 'abc', files: [], failures: [], decisions: [] }
    expect(epicFixPrompt({ ...input, fix: 'ci', requiredChecks: [] })).not.toBe(epicFixPrompt({ ...input, fix: 'ci', requiredChecks: ['ci'] }))
  })

  it('never names a repository\'s tools', () => {
    for (const checkScope of [null, 'targeted', 'none'] as const) {
      for (const prompt of [developerPrompt({ ...task, checkScope }, 'Tam'), developerRevisionPrompt({ ...task, checkScope, reviewRounds: 1 }, []), developerPrompt({ ...task, checkScope, rebaseOnly: true }, 'Tam'), developerPrompt({ ...task, checkScope, squashRebase: true }, 'Tam')]) {
        expect(prompt).not.toMatch(/pnpm|Postgres|Turbo/)
      }
    }
  })
})

describe('task rebase prompts', () => {
  const parent: PromptTask = { ...task, ref: 'TA-9', title: 'Rebase task: Search', branch: 'corral/epic-1-search', defaultBranch: 'develop' }

  it.each([
    ['fresh', developerPrompt({ ...parent, squashRebase: true }, 'Tam')],
    ['resumed', developerRevisionPrompt({ ...parent, squashRebase: true, reviewRounds: 1 }, [])]
  ])('updates the task\'s PR from a %s session', (_name, prompt) => {
    expect(prompt).toContain('corral/epic-1-search')
    expect(prompt).toContain('"pr_updated"')
    expect(prompt).not.toContain('pr_opened')
  })

  it('rebases onto the target, and names the submission trailers only on a task rebase', () => {
    expect(developerPrompt({ ...parent, squashRebase: true }, 'Tam')).toContain('origin/develop')
    expect(developerPrompt({ ...parent, squashRebase: true }, 'Tam')).toContain('Corral-Submission:')
    expect(developerPrompt(parent, 'Tam')).not.toContain('Corral-Submission')
  })
})

describe('rebase-only developer prompts', () => {
  it('limits fresh and resumed sessions to the rebase, even after revision rounds', () => {
    const rebase = { ...task, rebaseOnly: true, approvedHeadSha: 'approved-head', reviewRounds: 3, defaultBranch: 'epic/release' }
    for (const prompt of [developerPrompt(rebase, 'Tam'), developerRevisionPrompt(rebase, [])]) {
      expect(prompt).toContain('approved-head')
      expect(prompt).toContain('origin/epic/release')
      expect(prompt).toContain('pr_rebased')
      expect(prompt).toContain('conflictedFiles')
      expect(prompt).toContain('trivial')
      expect(prompt).toContain('needs_review')
      expect(prompt).not.toContain('pr_updated')
    }
  })
})

describe('rebase review prompts', () => {
  const rebase = { ...review, ref: 'TA-2', branch: 'corral/ta-2', rebaseOnly: true, approvedHeadSha: 'approved-head', headSha: 'new-head', criteria: [] }

  it('shows a resolution reviewer each target-only file, in a fence its diff can\'t close', () => {
    const epicResolution = { oldHead: 'old', ontoSha: 'onto', conflictFiles: ['a.ts'], approvedHeadSha: null, decisions: [] }
    const prompt = reviewerPrompt({ ...rebase, rebaseOnly: false, epicResolution: { ...epicResolution, targetFiles: [{ path: 'b.md', diff: '+```\n+`````', truncated: true }] } }, 'Rita')
    expect(prompt).toContain('- `b.md`')
    expect(prompt).toContain('``````diff\n+```\n+`````\n``````')
    expect(prompt).toContain('`preservesApproval: false`')
    expect(reviewerPrompt({ ...rebase, rebaseOnly: false, epicResolution: { ...epicResolution, targetFiles: [] } }, 'Rita')).not.toContain('b.md')
  })

  it('gives the developer\'s choice and conflicted files', () => {
    const prompt = reviewerPrompt({ ...rebase, rebaseReport: { review: 'trivial', conflictedFiles: ['app.ts'] } }, 'Rita')
    expect(prompt).toContain('trivial')
    expect(prompt).toContain('app.ts')
  })

  it('names each failed server check and its files', () => {
    const plain = reviewerPrompt(rebase, 'Rita')
    const prompt = reviewerPrompt({ ...rebase, rebaseCheckFailures: [
      { condition: 'changes_outside_conflicts', files: ['billing.ts'] },
      { condition: 'project_docs_changed', files: ['docs/decisions.md', 'CLAUDE.md'] }
    ] }, 'Rita')
    for (const file of ['`billing.ts`', '`docs/decisions.md`, `CLAUDE.md`']) {
      expect(prompt).toContain(file)
      expect(plain).not.toContain(file)
    }
  })
})

describe('continuing a stopped run', () => {
  const stoppedRun = { number: 12, reason: 'The run hit its time limit of 60 minutes', wipSha: 'abc123def' }

  it('says nothing after a run that reported', () => {
    expect(developerPrompt(task, 'Dev')).not.toContain('stopped')
    expect(developerRevisionPrompt(task, [])).not.toContain('stopped')
  })

  it.each([
    ['developer', developerPrompt({ ...task, stoppedRun }, 'Dev')],
    ['designer', designerPrompt({ ...task, stoppedRun, design: { version: null } }, 'Dev')],
    ['resumed developer', developerRevisionPrompt({ ...task, stoppedRun }, [])],
    ['resumed designer', designerRevisionPrompt({ ...task, stoppedRun, design: { version: 1 } }, [])]
  ])('names the run, the stop reason and the WIP commit for the %s', (_name, prompt) => {
    expect(prompt).toContain('#12')
    expect(prompt).toContain(stoppedRun.reason)
    expect(prompt).toContain('`abc123def`')
  })

  it('names no commit when the stopped run saved none', () => {
    const prompt = developerPrompt({ ...task, stoppedRun: { ...stoppedRun, wipSha: null } }, 'Dev')
    expect(prompt).toContain(stoppedRun.reason)
    expect(prompt).not.toContain('abc123def')
  })
})

describe('human decisions contract (D11)', () => {
  const decisions = { ...task, ref: 'TA-2', branch: 'corral/ta-2', approvedHeadSha: 'approved-head', criteria: [] }

  it.each([
    ['PM', pmPrompt({ ...turn, fresh: true })],
    ['developer', developerPrompt(decisions, 'Tam')],
    ['spike developer', developerPrompt({ ...decisions, spike: true, branch: null }, 'Tam')],
    ['designer', designerPrompt({ ...decisions, design: { version: null } }, 'Dee')],
    ['task rebase developer', developerPrompt({ ...decisions, squashRebase: true }, 'Tam')],
    ['rebase developer', developerRevisionPrompt({ ...decisions, rebaseOnly: true }, [])],
    ['PR-free rebase developer', developerRevisionPrompt({ ...decisions, rebaseOnly: true, prFree: true }, [])],
    ['rebase reviewer', reviewerPrompt({ ...review, ...decisions, headSha: 'new-head', rebaseOnly: true }, 'Rae')]
  ])('is in the %s prompt', (_name, prompt) => {
    expect(prompt).toContain(HUMAN_DECISIONS_NOTE)
  })
})

describe('integration review prompts', () => {
  const input = { agentName: 'Vera', title: 'Saved searches', context: { epicId: 'e' }, target: 'main', headSha: 'abc123', requiredChecks: ['ci'], targetFiles: [], lastReview: null }

  it('changes the gates with the project\'s required CI', () => {
    expect(epicReviewPrompt({ ...input, requiredChecks: [] })).not.toBe(epicReviewPrompt(input))
  })

  it('covers the whole task the first time, and what changed since on a repeat', () => {
    expect(epicReviewPrompt(input)).toContain('git diff origin/main...HEAD')
    const repeat = epicReviewPrompt({ ...input, lastReview: { headSha: 'old999', summary: 'The UI sends the wrong field', outcome: 'changes_requested', fixes: ['Renamed the field'] } })
    expect(repeat).toContain('The UI sends the wrong field')
    expect(repeat).toContain('git diff old999..HEAD')
    expect(repeat).not.toContain('git diff origin/main...HEAD')
  })

  it('shows the files only the target changed', () => {
    const adapted = epicReviewPrompt({ ...input, lastReview: { headSha: 'old999', summary: 'Fine', outcome: 'changes_requested', fixes: [] }, targetFiles: [{ path: 'src/main-only.ts', diff: '+adapted', truncated: true }] })
    expect(adapted).toContain('+adapted')
    expect(adapted).toContain('src/main-only.ts')
    expect(epicReviewPrompt(input)).not.toContain('src/main-only.ts')
  })

  it('reads CI for the head under review', () => {
    const section = epicReviewCiSection({ read: true, passed: ['lint'], pending: [], failures: [{ name: 'test', url: 'https://x/job/1', step: 'Run tests', excerpt: 'FAIL a.test.ts' }] })
    expect(section).toContain('lint')
    expect(section).toContain('Run tests')
  })
})

describe('cappedBranchDiff', () => {
  it('keeps every file that fits and names those that do not', () => {
    const diff = cappedBranchDiff([
      { filename: 'small.ts', patch: '+small' },
      { filename: 'huge.ts', patch: '+'.repeat(40_000) },
      { filename: 'after.ts', patch: '+after' }
    ])
    expect(diff).toContain('+small')
    expect(diff).not.toContain('+++')
    expect(diff).toContain('+after')
    expect(diff).toContain('\n- huge.ts')
    expect(diff).not.toContain('\n- after.ts')
  })
})
