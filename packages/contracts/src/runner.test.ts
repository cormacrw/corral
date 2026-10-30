import { describe, expect, it } from 'vitest'
import { runJobSchema, runnerMessageSchema, serverMessageSchema, type RunJob } from './runner.ts'

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
    const designer = { ...developer, taskType: 'design', designPinned: false }
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
