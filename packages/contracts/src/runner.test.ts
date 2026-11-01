import { DEVELOPER_RUN_OUTCOMES, PM_RUN_OUTCOMES, REVIEWER_RUN_OUTCOMES, RUN_OUTCOMES } from '@corral/core'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { runLifecycleSchema } from './agents.ts'
import { epicReviewReportSchema, outcomeReportSchema, rebaseReviewReportSchema, reportOutcomeInput, runJobSchema, runnerMessageSchema, serverMessageSchema, type RunJob } from './runner.ts'

const common = {
  runId: 'run', runNumber: 1, leaseEpoch: 3, runtime: 'codex',
  projectId: 'project', repository: 'cormacrw/test-app', defaultBranch: 'main',
  agentSessionId: null, prompt: 'work', fallbackPrompt: null, model: null, timeoutSeconds: 60
}
const developer = {
  ...common, role: 'developer', taskId: 'task', taskRef: 'TA-1',
  branch: null, headSha: null, planSessionId: null
} satisfies RunJob
const pm = {
  ...common, role: 'pm', taskId: null, taskRef: null, branch: null,
  headSha: null, planSessionId: 'session'
} satisfies RunJob

// Compile-time assertions: these must remain errors.
function typeChecks() {
  // @ts-expect-error Developers require a task
  const noTask: RunJob = { ...developer, taskId: null }
  // @ts-expect-error Reviewers require a task
  const noReviewTask: RunJob = { ...developer, role: 'reviewer', taskId: null }
  // @ts-expect-error PM turns cannot carry task context
  const pmTask: RunJob = { ...pm, taskId: 'task' }
  // @ts-expect-error PM turns cannot carry a task branch
  const pmBranch: RunJob = { ...pm, baseBranch: 'task-base' }
  return [noTask, noReviewTask, pmTask, pmBranch]
}
void typeChecks

describe('runner protocol schemas', () => {
  it('preserves timings alongside stopped-work metadata on run.ended', () => {
    const ended = {
      type: 'run.ended', runId: 'run', leaseEpoch: 3,
      exit: { kind: 'signalled', signal: 'SIGTERM' }, headSha: 'head',
      lastActivityAt: '2026-10-30T12:00:00Z', wipSha: 'wip',
      timings: { totalMs: 100, phases: [{ phase: 'finish', durationMs: 100 }], tools: [{ tool: 'get_task', count: 1, totalMs: 20, maxMs: 20 }] }
    }
    expect(runnerMessageSchema.parse(ended)).toEqual(ended)
    const legacy = { ...ended }
    Reflect.deleteProperty(legacy, 'timings')
    expect(runnerMessageSchema.parse(legacy)).toEqual(legacy)
  })

  it.each(['developer', 'reviewer'])('rejects a %s assignment without a task', (role) => {
    for (const taskId of [null, undefined, '']) {
      expect(serverMessageSchema.safeParse({ type: 'run.assign', job: { ...developer, role, taskId } }).success).toBe(false)
    }
  })
  it.each([
    { taskId: 'task' }, { taskRef: 'TA-1' }, { branch: 'task' },
    { headSha: 'sha' }, { taskType: 'design' }, { designPinned: true },
    { baseBranch: 'feature' }, { epicId: 'epic' }
  ])('rejects PM task context %j', (context) => {
    expect(runJobSchema.safeParse({ ...pm, ...context }).success).toBe(false)
  })
  it('decodes legacy assignments and current designer jobs without changing them', () => {
    expect(runJobSchema.parse(developer)).toEqual(developer)
    expect(runJobSchema.parse(pm)).toEqual(pm)
    const designer = { ...developer, role: 'designer', taskType: 'design', designPinned: false }
    expect(runJobSchema.parse(designer)).toEqual(designer)
  })
  it('preserves explicit D23 epic reviews, but rejects an incomplete epic target', () => {
    const epic = { ...developer, role: 'reviewer', taskId: null, taskRef: null, epicId: 'epic', branch: 'corral/epic', headSha: 'sha' }
    expect(runJobSchema.parse(epic)).toEqual(epic)
    expect(runJobSchema.safeParse({ ...epic, headSha: null }).success).toBe(false)
  })
  it('validates nested events and both setup result branches', () => {
    const envelope = { type: 'run.events', runId: 'run', leaseEpoch: 3 }
    expect(runnerMessageSchema.safeParse({ ...envelope, events: [{ type: 'message', text: 1 }] }).success).toBe(false)
    expect(runnerMessageSchema.parse({ ...envelope, events: [{ type: 'message', text: 'hello' }] })).toMatchObject(envelope)
    for (const result of [{ kind: 'list_repos', signedIn: false }, { kind: 'list_repos', signedIn: true, repos: [] }]) {
      expect(runnerMessageSchema.parse({ type: 'job.result', jobId: 'job', ok: true, result })).toMatchObject({ result })
    }
    expect(serverMessageSchema.parse({ type: 'tool.result', callId: 'call', ok: false, error: 'stale fence' })).toMatchObject({ error: 'stale fence' })
  })
})

describe('outcome reports', () => {
  const criteria = [{ criterionId: 'c1', met: true }]
  const issues = (schema: z.ZodType, input: unknown) => {
    const parsed = schema.safeParse(input)
    return parsed.success ? [] : parsed.error.issues.map(i => [i.path.join('.'), i.message])
  }

  it.each(['approved', 'changes_requested'])('requires criteria on a task review reporting %s', (outcome) => {
    expect(issues(outcomeReportSchema, { outcome, summary: 'Checked' })).toEqual([['criteria', 'Give a verdict for every acceptance criterion']])
    expect(outcomeReportSchema.parse({ outcome, summary: 'Checked', criteria })).toMatchObject({ criteria: [{ criterionId: 'c1', met: true, note: '' }] })
  })

  it.each([outcomeReportSchema, rebaseReviewReportSchema])('rejects an unknown or missing outcome, and what only the exit can report', (schema) => {
    for (const outcome of ['looks_fine', 'rate_limited', undefined]) {
      expect(issues(schema, { outcome, summary: 'Done' })).toEqual([['outcome', expect.stringContaining('must be one of')]])
    }
  })

  it('needs no criteria on outcomes that are not reviews', () => {
    for (const outcome of ['pr_opened', 'stuck', 'blocked', 'failed']) {
      expect(outcomeReportSchema.safeParse({ outcome, summary: 'Done' }).success).toBe(true)
    }
  })

  it('needs no criteria on an approved rebase review, but does on its changes requested', () => {
    expect(rebaseReviewReportSchema.safeParse({ outcome: 'approved', summary: 'Holds' }).success).toBe(true)
    expect(issues(rebaseReviewReportSchema, { outcome: 'changes_requested', summary: 'Broken' })).toEqual([['criteria', expect.any(String)]])
  })

  it('takes only verdicts on an epic review, with no criteria', () => {
    expect(epicReviewReportSchema.safeParse({ outcome: 'approved', summary: 'Holds' }).success).toBe(true)
    expect(issues(epicReviewReportSchema, { outcome: 'failed', summary: 'Broken' })).toEqual([['outcome', 'must be one of approved, changes_requested']])
  })

  it('agrees with the tool\'s flat input on what an agent can report', () => {
    expect(reportOutcomeInput.shape.outcome.options).not.toContain('rate_limited')
    expect(reportOutcomeInput.shape.outcome.options).toHaveLength(RUN_OUTCOMES.length - 1)
  })
})

describe('run lifecycle', () => {
  const endedAt = '2026-10-30T10:00:00.000Z'
  it.each([
    { role: 'developer', state: 'running', outcome: null, endedAt: null },
    { role: 'pm', state: 'completed', outcome: null, endedAt },
    { role: 'pm', state: 'interrupted', outcome: null, endedAt },
    { role: 'developer', state: 'interrupted', outcome: null, endedAt },
    { role: 'reviewer', state: 'completed', outcome: 'approved', endedAt },
    { role: 'developer', state: 'completed', outcome: 'rate_limited', endedAt }
  ])('accepts $role $state with outcome $outcome', (run) => {
    expect(runLifecycleSchema.safeParse(run).success).toBe(true)
  })

  it.each([
    { role: 'developer', state: 'running', outcome: 'approved', endedAt },
    { role: 'developer', state: 'running', outcome: null, endedAt },
    { role: 'developer', state: 'completed', outcome: null, endedAt: null },
    { role: 'developer', state: 'completed', outcome: 'approved', endedAt },
    { role: 'pm', state: 'completed', outcome: 'stuck', endedAt }
  ])('rejects $role $state with outcome $outcome', (run) => {
    expect(runLifecycleSchema.safeParse(run).success).toBe(false)
  })
})

describe('role outcomes', () => {
  it('covers every outcome, with only the shared ones in more than one role', () => {
    expect(new Set([...DEVELOPER_RUN_OUTCOMES, ...REVIEWER_RUN_OUTCOMES, ...PM_RUN_OUTCOMES])).toEqual(new Set(RUN_OUTCOMES))
    expect(DEVELOPER_RUN_OUTCOMES.filter(o => (REVIEWER_RUN_OUTCOMES as readonly string[]).includes(o))).toEqual(PM_RUN_OUTCOMES)
  })
})

it('accepts optional structured epic findings and rejects malformed findings', () => {
  expect(epicReviewReportSchema.parse({ outcome: 'approved', summary: 'Clean' }).findings).toEqual([])
  const finding = { level: 'non_blocking', text: 'Align the docs', taskRefs: ['TA-1', 'TA-2'] }
  expect(reportOutcomeInput.parse({ outcome: 'approved', summary: 'Fits', findings: [finding] }).findings).toEqual([finding])
  expect(epicReviewReportSchema.parse({ outcome: 'approved', summary: 'Fits', findings: [finding] }).findings).toEqual([finding])
  for (const invalid of [{ ...finding, level: 'unknown' }, { ...finding, text: ' ' }, { ...finding, taskRefs: [''] }]) {
    expect(epicReviewReportSchema.safeParse({ outcome: 'approved', summary: 'Fits', findings: [invalid] }).success).toBe(false)
  }
})
