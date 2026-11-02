import type { Project, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ciExcerpt, MAX_EXCERPT_CHARS } from './ci-output.ts'
import { flowMetrics } from './flow-metrics.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

// What the developer reports decides whether a round is reviewed again (D29)
let t: TestApp
let runner: FakeRunner
let project: Project

beforeAll(async () => {
  t = await createTestApp('pglite', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 20, wakeIntervalSeconds: null })
  runner = await FakeRunner.connect(t.server!.url)
  project = await t.createProject({ repository: 'cormacrw/test-app', defaultBranch: 'main' })
  await t.db.update(schema.projects).set({ requiredChecks: ['lint'] }).where(eq(schema.projects.id, project.id))
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})

const taskRow = async (id: string) => (await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
const reviewerRuns = async (id: string) => (await t.db.select().from(schema.runs).where(eq(schema.runs.taskId, id))).filter(r => r.role === 'reviewer' && r.state !== 'completed')

// An approved task in Ready to merge with an open PR, whose required check failed
async function ciRound(options: { humanCheck?: boolean } = {}): Promise<{ task: Awaited<ReturnType<TestApp['createTask']>>, dev: RunJob, branch: string }> {
  const task = await t.createTask(project.slug, { humanReview: false, acceptanceCriteria: ['Works', ...options.humanCheck ? [{ text: 'On a phone', checkedByHuman: true }] : []] })
  const branch = `corral/${task.ref.toLowerCase()}`
  const head = `head-${task.number}`
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
  const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'reviewer', state: 'completed', outcome: 'approved', endedAt: new Date() }).returning()
  const criteria = task.acceptanceCriteria.map(c => c.checkedByHuman ? { criterionId: c.id, met: null, note: 'Needs human check' } : { criterionId: c.id, met: true, note: 'Proven' })
  await t.db.insert(schema.reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: head, verdict: 'approved', summary: 'Checked', criteria, author: t.actor })
  await t.db.insert(schema.evidence).values(criteria.map(c => ({ taskId: task.id, runId: run!.id, criterionId: c.criterionId, round: 0, kind: 'note' as const, size: 0, note: 'Proof' })))
  t.github.setBranch(project.repository, branch, head)
  const pr = await t.github.openPullRequest(project.repository, { head: branch, base: 'main', title: task.title, body: '' })
  t.github.pulls.get(pr.number)!.mergeable = true
  await t.db.update(schema.tasks).set({ status: 'ready_to_merge', branch, headSha: head, prNumber: pr.number, prUrl: pr.url }).where(eq(schema.tasks.id, task.id))
  t.github.setChecks(head, [{ name: 'lint', conclusion: 'failure', url: `https://github.com/cormacrw/test-app/actions/runs/1/job/${task.number}` }])
  await t.orchestrator.merges.tick()
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
  return { task, dev, branch }
}

describe('a round started by a CI failure', () => {
  it('gives the developer CI\'s output, marked untrusted', async () => {
    t.github.ciLogs.set('lint', { step: 'Run lint', log: 'setup\n  error  no-unused-vars\n##[error]Process completed with exit code 1.\nPost job cleanup.' })
    const { dev } = await ciRound()
    t.github.ciLogs.clear()
    expect(dev.prompt).toContain('Run lint')
    expect(dev.prompt).toContain('no-unused-vars')
    expect(dev.prompt).toContain('untrusted output')
    expect(dev.prompt).not.toContain('Post job cleanup')
  })

  it('still starts when the log can\'t be read, saying so and linking the run', async () => {
    const { dev, task } = await ciRound()
    expect(dev.prompt).toContain('unavailable')
    expect(dev.prompt).toContain(`actions/runs/1/job/${task.number}`)
  })

  it('needs the developer to say whether behaviour changed', async () => {
    const { dev, branch } = await ciRound()
    t.github.setBranch(project.repository, branch, 'fixed')
    expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', note: 'Fixed', summary: 'Fixed lint', headSha: 'fixed' })).toMatchObject({ ok: false, error: expect.stringContaining('behaviourChanged') })
  })

  it('carries approval to Ready to merge with no reviewer when behaviour is unchanged, and merges only once CI passes on the new head', async () => {
    const { dev, task, branch } = await ciRound()
    const fixed = `fixed-${task.number}`
    t.github.setBranch(project.repository, branch, fixed)
    expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', behaviourChanged: false, note: 'Fixed the lint rule', summary: 'Fixed lint', headSha: fixed })).toMatchObject({ ok: true })
    await t.orchestrator.schedule()
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge', headSha: fixed, ciFix: null })
    expect(await reviewerRuns(task.id)).toEqual([])
    const reviews = await t.db.select().from(schema.reviews).where(eq(schema.reviews.taskId, task.id))
    expect(reviews.some(r => r.headSha === fixed && r.verdict === 'approved')).toBe(true)

    await t.mergePass()
    expect((await taskRow(task.id)).status).toBe('ready_to_merge')
    t.github.setChecks(fixed, [{ name: 'lint', conclusion: 'success', url: null }])
    await t.mergePass()
    expect((await taskRow(task.id)).status).toBe('merged')

    const comments = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))
    expect(comments.map(c => c.body)).toEqual(expect.arrayContaining([expect.stringContaining('did not change')]))
  })

  it('goes to Agent review when behaviour changed', async () => {
    const { dev, task, branch } = await ciRound()
    t.github.setBranch(project.repository, branch, `changed-${task.number}`)
    expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', behaviourChanged: true, note: 'Changed the code', summary: 'Changed', headSha: `changed-${task.number}` })).toMatchObject({ ok: true })
    expect((await taskRow(task.id)).status).toBe('agent_review')
    const comments = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))
    expect(comments.map(c => c.body)).toEqual(expect.arrayContaining([expect.stringContaining('behaviour changed')]))
  })

  it('keeps going to Human review with an open human check', async () => {
    const { dev, task, branch } = await ciRound({ humanCheck: true })
    t.github.setBranch(project.repository, branch, `checked-${task.number}`)
    expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', behaviourChanged: false, note: 'Fixed', summary: 'Fixed', headSha: `checked-${task.number}` })).toMatchObject({ ok: true })
    expect((await taskRow(task.id)).status).toBe('human_review')
  })
})

describe('a rebase-only round', () => {
  // The same approved task, with its base having moved under it
  async function rebaseRound() {
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const task = await t.createTask(project.slug, { humanReview: false, acceptanceCriteria: ['Works'] })
    const branch = `corral/${task.ref.toLowerCase()}`
    const head = `approved-${task.number}`
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
    const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'reviewer', state: 'completed', outcome: 'approved', endedAt: new Date() }).returning()
    const criteria = task.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Proven' }))
    await t.db.insert(schema.reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: head, verdict: 'approved', summary: 'Checked', criteria, author: t.actor })
    await t.db.insert(schema.evidence).values(criteria.map(c => ({ taskId: task.id, runId: run!.id, criterionId: c.criterionId, round: 0, kind: 'note' as const, size: 0, note: 'Proof' })))
    t.github.setBranch(project.repository, branch, head)
    await t.db.update(schema.tasks).set({ status: 'in_progress', branch, headSha: head, approvedHeadSha: head, rebaseOnly: true }).where(eq(schema.tasks.id, task.id))
    await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
    await t.orchestrator.schedule()
    const dev = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
    const rebased = `rebased-${task.number}`
    t.github.setBranch(project.repository, branch, rebased)
    t.github.setBranch(project.repository, 'main', `main-${task.number}`)
    const change = (patch: string) => ({ filename: 'app.ts', status: 'modified', sha: 'x', patch })
    return { task, dev, head, rebased, compare: (before: string, after: string, other: string) => {
      t.github.setComparison(`main-${task.number}`, head, { mergeBase: 'old-base', files: [change(before), { filename: 'other.ts', status: 'modified', sha: 'y', patch: 'same' }] })
      t.github.setComparison(`main-${task.number}`, rebased, { mergeBase: 'new-base', files: [change(after), { filename: 'other.ts', status: 'modified', sha: 'y', patch: other }] })
      t.github.setComparison('old-base', 'new-base', { mergeBase: 'old-base', files: [] })
    } }
  }
  const report = (dev: RunJob, headSha: string, behaviourChanged: boolean, review = 'trivial') => runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_rebased', behaviourChanged, review, conflictedFiles: ['app.ts'], headSha, note: 'Resolved app.ts', summary: 'Kept both sides' })

  it('goes to Agent review when reported as changing behaviour, even if marked trivial', async () => {
    const { dev, task, rebased } = await rebaseRound()
    expect(await report(dev, rebased, true)).toMatchObject({ ok: true })
    expect((await taskRow(task.id)).status).toBe('agent_review')
  })

  it('goes to Agent review when differences go beyond the conflicted files, whatever the developer reports', async () => {
    const { dev, task, rebased, compare } = await rebaseRound()
    compare('a', 'b', 'changed')
    expect(await report(dev, rebased, false)).toMatchObject({ ok: true })
    expect((await taskRow(task.id)).status).toBe('agent_review')
  })

  it('keeps the server-checked path for an unchanged trivial rebase', async () => {
    const { dev, task, rebased, compare } = await rebaseRound()
    compare('a', 'b', 'same')
    expect(await report(dev, rebased, false)).toMatchObject({ ok: true })
    expect((await taskRow(task.id)).status).toBe('ready_to_merge')
  })
})

describe('the CI excerpt', () => {
  it('keeps the failing lines at the end of a very long log, within its bound', () => {
    const log = `${'noise line\n'.repeat(50_000)}FAIL src/app.test.ts\n##[error]Process completed with exit code 1.\n${'Post job cleanup\n'.repeat(5_000)}`
    const excerpt = ciExcerpt(log)
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 60)
    expect(excerpt).toContain('FAIL src/app.test.ts')
    expect(excerpt.endsWith('##[error]Process completed with exit code 1.')).toBe(true)
    expect(excerpt).toContain('earlier characters cut')
  })

  it('strips terminal colours', () => {
    expect(ciExcerpt('\u001B[31mred\u001B[0m')).toBe('red')
  })
})

describe('rework metrics', () => {
  it('counts fixes, reviews per epic and tokens over the window', async () => {
    const p = await t.createProject()
    const [dev] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'developer'))
    const [reviewer] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
    const [epic] = await t.db.insert(schema.epics).values({ projectId: p.id, title: 'E', createdBy: t.actor }).returning()
    const task = await t.createTask(p.slug, {})
    const now = new Date()
    const ended = { state: 'completed' as const, endedAt: now, projectId: p.id }
    await t.db.insert(schema.runs).values([
      { ...ended, agentId: dev!.id, role: 'developer', taskId: task.id, outcome: 'pr_opened', inputTokens: 100, cacheReadTokens: 0, outputTokens: 10 },
      { ...ended, agentId: dev!.id, role: 'developer', taskId: task.id, outcome: 'pr_updated', fixKind: 'ci', behaviourChanged: false, reReviewed: false, inputTokens: 20, outputTokens: 5 },
      { ...ended, agentId: dev!.id, role: 'developer', epicId: epic!.id, outcome: 'pr_updated', fixKind: 'review', behaviourChanged: true, reReviewed: true, inputTokens: 30, outputTokens: 5 },
      { ...ended, agentId: reviewer!.id, role: 'reviewer', epicId: epic!.id, outcome: 'approved' },
      { ...ended, agentId: reviewer!.id, role: 'reviewer', epicId: epic!.id, outcome: 'changes_requested' },
      { ...ended, agentId: dev!.id, role: 'developer', epicId: epic!.id, outcome: 'pr_updated', fixKind: 'ci', reReviewed: false, endedAt: new Date(now.getTime() - 40 * 86_400_000) }
    ])
    const metrics = await flowMetrics(t.db, p, '30d', new Date(now.getTime() + 1000))
    expect(metrics.fixes).toEqual({ reReviewed: 1, skippedReview: 1, epicDeveloperRuns: 1 })
    expect(metrics.epicReviews).toEqual({ reviews: 2, epics: 1, perEpic: 2 })
    expect(metrics.tokens).toEqual({ firstBuild: 110, followUp: 60 })
    expect((await flowMetrics(t.db, p, '90d', new Date(now.getTime() + 1000))).fixes.epicDeveloperRuns).toBe(2)
  })
})
