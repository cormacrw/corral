import type { Project, PullRequestDetail, PullRequestFile, PullRequestStatus, Task } from '@corral/contracts'
import { failedMergeGates, type TaskStatus } from '@corral/core'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitHubError } from './github.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { agents, evidence, reviews, runs, tasks } = schema

// GET /projects/:slug/pull-requests, with tasks seeded straight into the
// database and their PRs in FakeGitHub
describe('project pull requests', () => {
  let t: TestApp
  let project: Project

  beforeAll(async () => {
    t = await createTestApp('pglite')
    project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { requiredChecks: ['lint', 'test'], paused: true })
  })

  afterAll(async () => {
    await t?.close()
  })

  // A task with a PR on `sha`, optionally approved and evidenced for it
  async function withPr(title: string, sha: string, options: { status?: TaskStatus, approved?: boolean, evidence?: boolean, humanReview?: boolean } = {}): Promise<{ task: Task, number: number }> {
    const task = await t.createTask(project.slug, { title, ...(options.humanReview !== undefined && { humanReview: options.humanReview }) })
    const branch = `corral/${task.ref.toLowerCase()}`
    t.github.setBranch(project.repository, branch, sha)
    const pr = await t.github.openPullRequest(project.repository, { head: branch, base: 'main', title, body: '' })
    await t.db.update(tasks).set({ status: options.status ?? 'ready_to_merge', branch, prNumber: pr.number, prUrl: pr.url, headSha: sha }).where(eq(tasks.id, task.id))
    const [developer] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
    const [run] = await t.db.insert(runs).values({ agentId: developer!.id, projectId: project.id, taskId: task.id, role: 'developer', state: 'completed', endedAt: new Date() }).returning()
    if (options.evidence !== false) {
      for (const criterion of task.acceptanceCriteria) {
        await t.db.insert(evidence).values({ taskId: task.id, criterionId: criterion.id, runId: run!.id, round: 0, kind: 'test_output', blob: 'x', fileName: 't.txt', contentType: 'text/plain', size: 2 })
      }
    }
    if (options.approved !== false) {
      await t.db.insert(reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: sha, verdict: 'approved', summary: 'Looks right', author: { kind: 'system', component: 'server' } })
    }
    return { task, number: pr.number }
  }

  async function list(): Promise<PullRequestStatus[]> {
    const res = await t.request('GET', `/api/projects/${project.slug}/pull-requests`)
    expect(res.status).toBe(200)
    return res.json() as Promise<PullRequestStatus[]>
  }

  it('lists only tasks with an open PR, with gates matching the orchestrator', async () => {
    const eligible = await withPr('Eligible', 'sha-eligible')
    t.github.setChecks('sha-eligible', [{ name: 'lint', conclusion: 'success', url: 'https://ci/1' }, { name: 'test', conclusion: 'success', url: null }])

    const blocked = await withPr('Blocked', 'sha-blocked', { approved: false, evidence: false, status: 'human_review', humanReview: true })
    t.github.setChecks('sha-blocked', [{ name: 'lint', conclusion: 'failure', url: 'https://ci/2' }])
    t.github.pulls.get(blocked.number)!.mergeableState = 'behind'

    const closed = await withPr('Closed', 'sha-closed')
    t.github.pulls.get(closed.number)!.state = 'closed'
    await t.createTask(project.slug, { title: 'No PR' })

    const body = await list()
    expect(body.map(p => p.taskTitle)).toEqual(['Eligible', 'Blocked'])

    const [ok, bad] = body as [PullRequestStatus, PullRequestStatus]
    expect(ok).toMatchObject({
      taskRef: eligible.task.ref,
      pr: { number: eligible.number, state: 'open', headSha: 'sha-eligible' },
      review: { verdict: 'approved', forHeadCommit: true },
      ci: { status: 'passing' },
      branch: { upToDate: true, rebase: 'not_needed' },
      evidenceComplete: true,
      humanReviewOutstanding: false,
      merge: { eligible: true, failingGate: null, failedGates: [] }
    })
    expect(bad).toMatchObject({
      taskRef: blocked.task.ref,
      review: null,
      ci: { status: 'failing', checks: [{ name: 'lint', conclusion: 'failure', url: 'https://ci/2' }, { name: 'test', conclusion: 'missing', url: null }] },
      branch: { upToDate: false, rebase: 'needed' },
      evidenceComplete: false,
      humanReviewOutstanding: true,
      merge: { eligible: false, failingGate: 'approvalIsForHeadCommit', failedGates: ['approvalIsForHeadCommit', 'requiredChecksPassed', 'evidenceComplete'] }
    })

    // The same answer the merge orchestrator's gate check gives
    for (const status of body) {
      const [row] = await t.db.select().from(tasks).where(eq(tasks.title, status.taskTitle))
      const [projectRow] = await t.db.select().from(schema.projects).where(eq(schema.projects.id, project.id))
      const report = await t.orchestrator.merges.gates(row!, projectRow!)
      expect(status.merge.failedGates).toEqual(failedMergeGates(report.facts))
    }
  })

  it('marks an approval for an older commit as not for the head', async () => {
    const moved = await withPr('Moved', 'sha-old')
    t.github.setBranch(project.repository, `corral/${moved.task.ref.toLowerCase()}`, 'sha-new')
    const status = (await list()).find(p => p.taskTitle === 'Moved')!
    expect(status.review).toMatchObject({ headSha: 'sha-old', forHeadCommit: false })
    expect(status.merge.failedGates).toContain('approvalIsForHeadCommit')
  })

  it('leads with the first failed gate in core order however the facts were built', async () => {
    await withPr('Reordered', 'sha-reordered', { approved: false, evidence: false })
    const gates = t.orchestrator.merges.gates.bind(t.orchestrator.merges)
    const spy = vi.spyOn(t.orchestrator.merges, 'gates').mockImplementation(async (task, row) => {
      const report = await gates(task, row)
      return { ...report, facts: Object.fromEntries(Object.entries(report.facts).reverse()) as typeof report.facts }
    })
    const status = (await list()).find(p => p.taskTitle === 'Reordered')!
    spy.mockRestore()
    expect(status.merge.failingGate).toBe('approvalIsForHeadCommit')
    expect(status.merge.failedGates).toEqual(['approvalIsForHeadCommit', 'requiredChecksPassed', 'evidenceComplete'])
  })

  it('is a 404 for an unknown project', async () => {
    expect((await t.request('GET', '/api/projects/nope/pull-requests')).status).toBe(404)
  })
})

// GET /projects/:slug/tasks/:number/pull-request and
// /projects/:slug/pull-requests/:number
describe('pull request detail', () => {
  let t: TestApp
  let project: Project

  beforeAll(async () => {
    t = await createTestApp('pglite')
    project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  })

  afterAll(async () => {
    await t?.close()
  })

  async function open(branch: string, files: PullRequestFile[]): Promise<number> {
    t.github.setBranch(project.repository, branch, `${branch}-sha`)
    const pr = await t.github.openPullRequest(project.repository, { head: branch, base: 'main', title: `Title of ${branch}`, body: `Body of ${branch}` })
    t.github.pullFiles.set(pr.number, files)
    return pr.number
  }

  function file(path: string, additions: number): PullRequestFile {
    const patch = ['@@ -0,0 +1 @@', ...Array.from({ length: additions }, (_, i) => `+line ${i}`)].join('\n')
    return { path, status: 'modified', additions, deletions: 0, patch }
  }

  const detail = async (number: number) => await (await t.request('GET', `/api/projects/${project.slug}/pull-requests/${number}`)).json() as PullRequestDetail

  it('returns a task\'s PR with its description, branches and files', async () => {
    const number = await open('whole', [{ path: 'a.ts', status: 'renamed', additions: 1, deletions: 2, patch: '@@ -1,2 +1 @@\n-a\n-b\n+c' }])
    const task = await t.createTask(project.slug)
    await t.db.update(tasks).set({ prNumber: number }).where(eq(tasks.id, task.id))

    const res = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/pull-request`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      number,
      url: `https://github.com/${project.repository}/pull/${number}`,
      title: 'Title of whole',
      body: 'Body of whole',
      baseBranch: 'main',
      headBranch: 'whole',
      files: [{ path: 'a.ts', status: 'renamed', additions: 1, deletions: 2, patch: '@@ -1,2 +1 @@\n-a\n-b\n+c' }],
      totalFiles: 1,
      truncated: false
    })
  })

  it('reads any PR on the repository by number, with no task behind it', async () => {
    const number = await open('no-task', [file('a.ts', 1)])
    expect(await detail(number)).toMatchObject({ number, headBranch: 'no-task', truncated: false })
  })

  it('stops at 20 files and reports the total', async () => {
    const number = await open('many-files', Array.from({ length: 25 }, (_, i) => file(`f${i}.ts`, 1)))
    const pr = await detail(number)
    expect(pr.files).toHaveLength(20)
    expect(pr).toMatchObject({ totalFiles: 25, truncated: true })
  })

  it('stops at 1,000 changed lines, cutting the file that goes over', async () => {
    const number = await open('many-lines', [file('a.ts', 600), file('b.ts', 600), file('c.ts', 10)])
    const pr = await detail(number)
    expect(pr.files.map(f => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(pr).toMatchObject({ totalFiles: 3, truncated: true })
    // The file keeps its real counts, its patch only the 400 lines that fit
    expect(pr.files[1]).toMatchObject({ additions: 600 })
    expect(pr.files[1]!.patch.split('\n').filter(l => l.startsWith('+'))).toHaveLength(400)
    expect(pr.files[1]!.patch.endsWith('+line 399')).toBe(true)
  })

  it('flags a single file over the cap even though every file is listed', async () => {
    const number = await open('one-huge-file', [file('a.ts', 1500)])
    const pr = await detail(number)
    expect(pr.files.map(f => f.path)).toEqual(['a.ts'])
    expect(pr).toMatchObject({ totalFiles: 1, truncated: true })
  })

  it('does not flag a PR of exactly 20 files and 1,000 lines, and keeps renames past the budget', async () => {
    const files = [file('a.ts', 1000), ...Array.from({ length: 19 }, (_, i) => file(`rename-${i}.ts`, 0))]
    const pr = await detail(await open('at-the-cap', files))
    expect(pr.files).toHaveLength(20)
    expect(pr.files[0]!.patch).toBe(files[0]!.patch)
    expect(pr.truncated).toBe(false)
  })

  it('says when a task has no PR', async () => {
    const task = await t.createTask(project.slug)
    const res = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/pull-request`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'no_pull_request' } })
  })

  it('says when GitHub has no such PR', async () => {
    const res = await t.request('GET', `/api/projects/${project.slug}/pull-requests/9999`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'pull_request_unavailable', number: 9999, message: 'Not Found' } })
  })

  it('reports a GitHub or runner job failure as a bad gateway, not a server error', async () => {
    for (const failure of [new GitHubError(403, 'Resource not accessible'), new Error('Runner job github timed out')]) {
      const spy = vi.spyOn(t.github, 'getPullRequestDiff').mockRejectedValueOnce(failure)
      const res = await t.request('GET', `/api/projects/${project.slug}/pull-requests/7`)
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: { code: 'pull_request_unavailable', number: 7, message: failure.message } })
      spy.mockRestore()
    }
  })
})
