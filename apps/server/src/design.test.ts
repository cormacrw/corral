import type { Project, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, asc, eq } from 'drizzle-orm'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleHasRootIndex } from './designs.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, auditLog, designVersions, runs, tasks } = schema

// A gzipped tar of the files, as the runner packs a bundle
function tarball(files: Record<string, string>): Buffer {
  const root = mkdtempSync(join(tmpdir(), 'corral-bundle-test-'))
  try {
    const src = join(root, 'src')
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(src, name)), { recursive: true })
      writeFileSync(join(src, name), text)
    }
    execFileSync('tar', ['-czf', join(root, 'bundle.tar.gz'), '-C', src, '.'])
    return readFileSync(join(root, 'bundle.tar.gz'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('bundleHasRootIndex', () => {
  it('finds index.html at the root of the bundle, and only there', () => {
    expect(bundleHasRootIndex(tarball({ 'index.html': '<h1>Hi</h1>', 'assets/app.js': '1' }))).toBe(true)
    expect(bundleHasRootIndex(tarball({ 'dist/index.html': '<h1>Hi</h1>' }))).toBe(false)
    expect(bundleHasRootIndex(tarball({ 'main.html': '<h1>Hi</h1>' }))).toBe(false)
    expect(bundleHasRootIndex(Buffer.from('not a tarball'))).toBe(false)
  })
})

// D20: a design task delivers versioned prototypes instead of a PR. Each test
// runs a task against a fake runner and fake GitHub.
describe('design tasks submit versions instead of a PR', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 })
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const BUNDLE = tarball({ 'index.html': '<h1>Login</h1>', 'assets/app.js': 'console.log(1)' })
  const SPEC = '# Login\n\n## Screens\n- `login`: the form\n- `login-error`: a bad password\n'

  async function taskRow(id: string) {
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, id))
    return row!
  }

  async function versionsOf(task: Task) {
    return t.db.select().from(designVersions).where(eq(designVersions.taskId, task.id)).orderBy(asc(designVersions.version))
  }

  async function full(project: Project, task: Task): Promise<Task> {
    return t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Promise<Task>
  }

  async function nextJob(task: Task, role: RunJob['role']): Promise<RunJob> {
    await t.orchestrator.schedule()
    return (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === role)).job
  }

  async function approved(input: Parameters<TestApp['createTask']>[1] = {}) {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { title: 'Login screen', type: 'design', acceptanceCriteria: ['Shows the login form', 'Shows the bad-password state'], ...input })
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
    return { project, task: await full(project, task) }
  }

  // The agent CLI's session, as the runner reports it when the run starts
  async function started(job: RunJob, agentSessionId: string) {
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId })
    for (let i = 0; i < 100; i++) {
      const [run] = await t.db.select({ agentSessionId: runs.agentSessionId }).from(runs).where(eq(runs.id, job.runId))
      if (run?.agentSessionId === agentSessionId) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('run.started was not recorded')
  }

  function submission(headSha: string, bundle = BUNDLE) {
    return {
      headSha,
      spec: SPEC,
      bundle: { dataBase64: bundle.toString('base64'), files: 2 },
      screenshots: [
        { fileName: 'login-desktop.png', contentType: 'image/png', dataBase64: Buffer.from('png-desktop').toString('base64') },
        { fileName: 'login-mobile.png', contentType: 'image/png', dataBase64: Buffer.from('png-mobile').toString('base64') }
      ]
    }
  }

  async function attachAll(job: RunJob, task: Task) {
    for (const criterion of task.acceptanceCriteria) {
      expect(await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', {
        criterionId: criterion.id, kind: 'screenshot', note: 'desktop', fileName: 'login-desktop.png', contentType: 'image/png', dataBase64: Buffer.from('png').toString('base64')
      })).toMatchObject({ ok: true })
    }
  }

  // The runner pushes the branch, then submit_design records the version
  async function submit(project: Project, job: RunJob, task: Task, sha: string) {
    t.github.setBranch(project.repository, job.branch!, sha)
    expect(await runner.call(job.runId, job.leaseEpoch, 'submit_design', submission(sha))).toMatchObject({ ok: true })
    await attachAll(job, task)
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'design_submitted', summary: 'Login form and its error state', headSha: sha }))
      .toMatchObject({ ok: true })
    await runner.next('run.stop', m => m.runId === job.runId)
  }

  function verdicts(task: Task, met: boolean) {
    return task.acceptanceCriteria.map(c => ({ criterionId: c.id, met, note: met ? 'In the spec and screenshots' : 'Missing' }))
  }

  async function review(task: Task) {
    const reviewer = await nextJob(task, 'reviewer')
    expect(await runner.call(reviewer.runId, reviewer.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Matches.', criteria: verdicts(task, true) }))
      .toMatchObject({ ok: true, result: { message: expect.stringContaining('The human reviews the design next') } })
    return reviewer
  }

  async function pause(project: Project) {
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  }

  it('runs a design end to end on design/<ref> and ends in Human review with v1 stored, without a PR', async () => {
    const { project, task } = await approved()

    const developer = await nextJob(task, 'developer')
    expect(developer).toMatchObject({ branch: `design/${task.ref}`, taskType: 'design', agentSessionId: null })
    expect(developer.prompt).toContain(`design task ${task.ref}`)
    expect(developer.prompt).toContain('submit_design')
    expect(developer.prompt).toContain('"design_submitted"')
    expect(developer.prompt).toContain('agent-browser')
    expect(developer.prompt).not.toContain('pr_opened')

    // A design opens no PR
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done', headSha: 'd1' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('submit_design') })
    // Reporting before a version exists at the commit is refused
    t.github.setBranch(project.repository, developer.branch!, 'd1')
    await attachAll(developer, task)
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'design_submitted', summary: 'Done', headSha: 'd1' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('call submit_design first') })

    await submit(project, developer, task, 'd1')
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', branch: `design/${task.ref}`, headSha: 'd1', prNumber: null })
    const [v1] = await versionsOf(task)
    expect(v1).toMatchObject({ version: 1, status: 'submitted', branch: `design/${task.ref}`, commitSha: 'd1' })
    expect(v1!.screenshots.map(s => s.fileName)).toEqual(['login-desktop.png', 'login-mobile.png'])
    expect(Buffer.from((await t.blobs.get(v1!.specBlob))!).toString('utf8')).toBe(SPEC.trim())
    expect(bundleHasRootIndex((await t.blobs.get(v1!.bundleBlob))!)).toBe(true)
    const [run] = await t.db.select().from(runs).where(eq(runs.id, developer.runId))
    expect(run).toMatchObject({ state: 'completed', outcome: 'design_submitted', headSha: 'd1' })

    // The reviewer checks the version's spec and screenshots, with no diff
    const reviewer = await nextJob(task, 'reviewer')
    expect(reviewer).toMatchObject({ branch: `design/${task.ref}`, headSha: 'd1', taskType: 'design' })
    expect(reviewer.prompt).toContain('design v1')
    expect(reviewer.prompt).toContain('get_design')
    expect(reviewer.prompt).toContain('login-mobile.png')
    expect(reviewer.prompt).not.toContain('git diff')
    expect(await runner.call(reviewer.runId, reviewer.leaseEpoch, 'get_design', { taskRef: task.ref })).toMatchObject({ ok: true, result: { version: 1, spec: SPEC.trim() } })
    await runner.call(reviewer.runId, reviewer.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Matches.', criteria: verdicts(task, true) })

    // Human review, even though the flag can't be turned off: never Ready to merge
    expect(await taskRow(task.id)).toMatchObject({ status: 'human_review', prNumber: null })
    expect(t.github.pulls.size).toBe(0)
    expect(runner.received.filter(m => m.type === 'job.request' && m.job.kind === 'github')).toHaveLength(0)
    const transitions = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.transition')))
    expect(transitions.map(e => (e.detail as { to: string }).to)).toEqual(['ready', 'agent_review', 'human_review'])
    await pause(project)
  })

  it('rejects a bundle without index.html at its root with a clear error, and records nothing', async () => {
    const { project, task } = await approved()
    const developer = await nextJob(task, 'developer')
    t.github.setBranch(project.repository, developer.branch!, 'd1')
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'submit_design', submission('d1', tarball({ 'dist/index.html': '<h1>Login</h1>' }))))
      .toMatchObject({ ok: false, error: 'Not submitted. The bundle has no index.html at its root. Pass the folder that holds index.html and its assets, with relative paths.' })
    expect(await versionsOf(task)).toHaveLength(0)
    await pause(project)
  })

  it('continues the same session on the same branch after the human requests changes, and submits v2', async () => {
    const { project, task } = await approved()
    const developer = await nextJob(task, 'developer')
    await started(developer, 'sess-design-1')
    await submit(project, developer, task, 'd1')
    await review(task)
    expect(await taskRow(task.id)).toMatchObject({ status: 'human_review' })

    // The human sends it back with feedback
    const res = await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'request_changes', text: 'Make the error state red, and add a forgot-password link.' })
    expect(res.status).toBe(200)
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress' })
    expect((await versionsOf(task))[0]).toMatchObject({ version: 1, status: 'changes_requested', feedback: 'Make the error state red, and add a forgot-password link.' })

    // The same agent session resumes on the same branch, told about the feedback
    const revision = await nextJob(task, 'developer')
    expect(revision).toMatchObject({ branch: developer.branch, agentSessionId: 'sess-design-1', taskType: 'design' })
    expect(revision.prompt).toContain('same session and the same branch')
    expect(revision.prompt).toContain('Make the error state red')
    expect(revision.prompt).toContain('records v2')
    // The full prompt, in case the session is gone
    expect(revision.fallbackPrompt).toContain('changes were requested on design v1')
    expect(revision.fallbackPrompt).toContain('Make the error state red')

    await submit(project, revision, task, 'd2')
    const versions = await versionsOf(task)
    expect(versions.map(v => ({ version: v.version, status: v.status, branch: v.branch, commitSha: v.commitSha }))).toEqual([
      { version: 1, status: 'changes_requested', branch: `design/${task.ref}`, commitSha: 'd1' },
      { version: 2, status: 'submitted', branch: `design/${task.ref}`, commitSha: 'd2' }
    ])
    const reviewer = await review(task)
    expect(reviewer.prompt).toContain('design v2')
    expect(await taskRow(task.id)).toMatchObject({ status: 'human_review', headSha: 'd2' })
    expect(t.github.pulls.size).toBe(0)
    await pause(project)
  })

  it('keeps other task types off the design path', async () => {
    const { project, task } = await approved({ title: 'Add login', type: 'task', acceptanceCriteria: ['Shows an error on a bad password'] })
    const developer = await nextJob(task, 'developer')
    expect(developer.branch).toMatch(new RegExp(`^corral/${task.ref.toLowerCase()}-`))
    expect(developer).toMatchObject({ taskType: 'task', agentSessionId: null, fallbackPrompt: null })
    expect(developer.prompt).not.toContain('submit_design')

    t.github.setBranch(project.repository, developer.branch!, 'abc123')
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'submit_design', submission('abc123')))
      .toMatchObject({ ok: false, error: 'Only a design task submits a design' })
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'design_submitted', summary: 'Done', headSha: 'abc123' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('Only a design task reports design_submitted') })
    expect(await versionsOf(task)).toHaveLength(0)
    await pause(project)
  })
})
