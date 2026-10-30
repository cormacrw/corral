import type { DesignVersion, Project, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, asc, eq } from 'drizzle-orm'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleProblem } from './designs.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, auditLog, designVersions, planMessages, planSessions, runs, taskDesignPins, tasks } = schema

// A tar of the files, as the runner packs a bundle
function tarball(files: Record<string, string>): Buffer {
  const root = mkdtempSync(join(tmpdir(), 'corral-bundle-test-'))
  try {
    const src = join(root, 'src')
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(src, name)), { recursive: true })
      writeFileSync(join(src, name), text)
    }
    execFileSync('tar', ['-cf', join(root, 'bundle.tar'), '-C', src, '.'])
    return readFileSync(join(root, 'bundle.tar'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('bundleProblem', () => {
  it('finds index.html at the root of the bundle, and only there', () => {
    const noIndex = 'The bundle has no index.html at its root. Pass the folder that holds index.html and its assets, with relative paths.'
    expect(bundleProblem(tarball({ 'index.html': '<h1>Hi</h1>', 'assets/app.js': '1' }))).toBeNull()
    expect(bundleProblem(tarball({ 'dist/index.html': '<h1>Hi</h1>' }))).toBe(noIndex)
    expect(bundleProblem(tarball({ 'main.html': '<h1>Hi</h1>' }))).toBe(noIndex)
    expect(bundleProblem(Buffer.from('not a tarball'))).toBe('The bundle is not a valid tar archive. Truncated tar archive: entry 1 at offset 0 has 13 of 512 header bytes.')
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
    expect(bundleProblem((await t.blobs.get(v1!.bundleBlob))!)).toBeNull()
    // The preview route serves the stored bundle as it was submitted
    const preview = await t.request('GET', `/api/designs/${v1!.id}/files/`)
    expect(preview.status).toBe(200)
    expect(await preview.text()).toBe('<h1>Login</h1>')
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

  it('accepts a design submission whose criteria are covered by notes alone (D21)', async () => {
    const { project, task } = await approved()
    const developer = await nextJob(task, 'developer')
    t.github.setBranch(project.repository, developer.branch!, 'n1')
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'submit_design', submission('n1'))).toMatchObject({ ok: true })
    for (const criterion of task.acceptanceCriteria) {
      expect(await runner.call(developer.runId, developer.leaseEpoch, 'attach_evidence', { criterionId: criterion.id, kind: 'note', note: 'See the screenshots in v1' }))
        .toMatchObject({ ok: true })
    }
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'design_submitted', summary: 'Login form', headSha: 'n1' }))
      .toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review' })
    await runner.next('run.stop', m => m.runId === developer.runId)
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

  it('rejects a corrupt bundle with an error naming where, not as a missing index.html', async () => {
    const { project, task } = await approved()
    const developer = await nextJob(task, 'developer')
    t.github.setBranch(project.repository, developer.branch!, 'd1')
    const corrupt = tarball({ 'index.html': '<h1>Login</h1>' })
    corrupt[512 + 150] = corrupt[512 + 150]! ^ 1
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'submit_design', submission('d1', corrupt)))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^Not submitted\. The bundle is not a valid tar archive\. .*offset 512/) })
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

  // D20: approving a version opens one Plan session for its build, whose
  // PM reads the version with get_design
  it('opens one Plan session for the build when a version is approved, and none when it is approved again', async () => {
    const { project, task } = await approved()
    const developer = await nextJob(task, 'developer')
    await submit(project, developer, task, 'd1')
    await review(task)
    expect(await taskRow(task.id)).toMatchObject({ status: 'human_review' })
    await pause(project)

    const path = `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve`
    expect((await t.request('POST', path, { note: 'Ship the desktop layout first.' })).status).toBe(200)
    expect(await taskRow(task.id)).toMatchObject({ status: 'approved', prNumber: null, mergedAt: null })
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/approve`)).status).toBe(409)
    const sessions = async () => t.db.select().from(planSessions).where(eq(planSessions.projectId, project.id))
    const [session] = await sessions()
    expect(session).toMatchObject({ title: 'Build: Login screen' })
    expect((await sessions())).toHaveLength(1)

    // The version links to it, for the design view
    const [version] = await versionsOf(task)
    expect(version).toMatchObject({ status: 'approved', planSessionId: session!.id })
    const listed = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/designs`).then(r => r.json()) as DesignVersion[]
    expect(listed[0]).toMatchObject({ version: 1, planSessionId: session!.id })

    // The human's first message names the design and version, with the note,
    // and its PM turn is queued like any other
    const messages = await t.db.select().from(planMessages).where(eq(planMessages.sessionId, session!.id))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'human' })
    expect(messages[0]!.text).toContain(`design v1 of ${task.ref} "Login screen"`)
    expect(messages[0]!.text).toContain('get_design')
    expect(messages[0]!.text).toContain('Approval note: Ship the desktop layout first.')
    const pmRuns = await t.db.select().from(runs).where(and(eq(runs.planSessionId, session!.id), eq(runs.role, 'pm')))
    expect(pmRuns).toHaveLength(1)
    await t.orchestrator.schedule()
    const pm = (await runner.next('run.assign', m => m.job.planSessionId === session!.id)).job
    expect(pm).toMatchObject({ role: 'pm', taskId: null, projectId: project.id })
    expect(pm.prompt).toContain(`design v1 of ${task.ref}`)
    expect(pm.prompt).toContain(`About task ${task.ref} Login screen`)

    // The PM reads the approved version
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'get_design', { taskRef: task.ref, version: 1 }))
      .toMatchObject({ ok: true, result: { taskRef: task.ref, title: 'Login screen', version: 1, status: 'approved', spec: SPEC.trim(), commitSha: 'd1' } })

    // Approving the same version again opens no second session and sends no
    // second message
    expect((await t.request('POST', path, { note: 'Again' })).status).toBe(200)
    expect((await t.request('POST', path)).status).toBe(200)
    expect(await sessions()).toHaveLength(1)
    expect(await t.db.select().from(planMessages).where(eq(planMessages.sessionId, session!.id))).toHaveLength(1)
    expect(await t.db.select().from(runs).where(and(eq(runs.planSessionId, session!.id), eq(runs.role, 'pm')))).toHaveLength(1)
    expect((await versionsOf(task))[0]).toMatchObject({ planSessionId: session!.id })
  })

  // D20: build tasks pinned to a design get its files and the instructions
  // to compare their build with the prototype; a newer approved version
  // flags the ones that haven't started
  describe('build tasks pinned to a design', () => {
    async function approvedV1() {
      const { project, task } = await approved()
      const developer = await nextJob(task, 'developer')
      await submit(project, developer, task, 'd1')
      await review(task)
      await pause(project)
      expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve`)).status).toBe(200)
      const [v1] = await versionsOf(task)
      return { project, design: task, v1: v1! }
    }

    async function buildTask(project: Project, v1: { id: string }, title: string, status: Task['status'], ran: boolean) {
      const created = await t.createTask(project.slug, { title, acceptanceCriteria: ['Matches the design'] })
      await t.db.insert(taskDesignPins).values({ taskId: created.id, designVersionId: v1.id, screens: ['login', 'login-error'] })
      await t.db.update(tasks).set({ status }).where(eq(tasks.id, created.id))
      if (ran) {
        const [agent] = await t.db.select().from(agents).where(eq(agents.role, 'developer')).limit(1)
        await t.db.insert(runs).values({ agentId: agent!.id, projectId: project.id, taskId: created.id, role: 'developer', state: 'completed' })
      }
      return created
    }

    it('gives the developer and reviewer the pinned version, its branch and the side-by-side evidence instruction', async () => {
      const { project, design, v1 } = await approvedV1()
      const build = await buildTask(project, v1, 'Build the login screen', 'backlog', false)
      expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${build.number}/transitions`, { type: 'approve' })).status).toBe(200)
      await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))

      const developer = await nextJob(build, 'developer')
      expect(developer).toMatchObject({ designPinned: true, taskType: 'task' })
      expect(developer.prompt).toContain(`design v1 of ${design.ref}`)
      expect(developer.prompt).toContain('`login`, `login-error`')
      expect(developer.prompt).toContain(`branch \`design/${design.ref}\` at commit d1`)
      expect(developer.prompt).toContain('read-only files')
      expect(developer.prompt).toContain('side by side')
      // The runner fetches the pinned version by the build task's own ref
      expect(await runner.call(developer.runId, developer.leaseEpoch, 'get_design', { taskRef: build.ref }))
        .toMatchObject({ ok: true, result: { taskRef: design.ref, version: 1, branch: `design/${design.ref}`, pinnedScreens: ['login', 'login-error'], spec: SPEC.trim() } })

      t.github.setBranch(project.repository, developer.branch!, 'b1')
      for (const criterion of build.acceptanceCriteria) {
        expect(await runner.call(developer.runId, developer.leaseEpoch, 'attach_evidence', {
          criterionId: criterion.id, kind: 'screenshot', note: 'login: build beside prototype', fileName: 'login-side-by-side.png', contentType: 'image/png', dataBase64: Buffer.from('png').toString('base64')
        })).toMatchObject({ ok: true })
      }
      expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Login screen', headSha: 'b1' })).toMatchObject({ ok: true })
      await runner.next('run.stop', m => m.runId === developer.runId)
      const reviewer = await nextJob(build, 'reviewer')
      expect(reviewer).toMatchObject({ designPinned: true })
      expect(reviewer.prompt).toContain(`design v1 of ${design.ref}`)
      expect(reviewer.prompt).toContain('matching prototype screenshots')
      await pause(project)

      // Unpinned tasks get neither
      const plain = await approved({ title: 'Plain', type: 'task', acceptanceCriteria: ['Works'] })
      const job = await nextJob(plain.task, 'developer')
      expect(job).toMatchObject({ designPinned: false })
      expect(job.prompt).not.toContain('## Design')
      await pause(plain.project)
    })

    it('approving v2 flags Draft, Backlog and Ready tasks pinned to v1 but not started or merged ones, and tells the PM', async () => {
      const { project, design, v1 } = await approvedV1()
      const ready = await buildTask(project, v1, 'Login form', 'ready', false)
      const backlog = await buildTask(project, v1, 'Login error state', 'backlog', false)
      const draft = await buildTask(project, v1, 'Forgot password link', 'draft', false)
      const inProgress = await buildTask(project, v1, 'Login API wiring', 'in_progress', true)
      const merged = await buildTask(project, v1, 'Login layout', 'merged', true)
      // Ready again after a run, so it has started
      const restarted = await buildTask(project, v1, 'Login copy', 'ready', true)

      const pinOf = async (task: Task) => (await full(project, task)).design
      expect(await pinOf(ready)).toEqual({ taskRef: design.ref, version: 1, screens: ['login', 'login-error'], newerVersion: null })

      // The human reopens the design and v2 is submitted and reviewed
      const reopened = await t.request('POST', `/api/projects/${project.slug}/tasks/${design.number}/transitions`, { type: 'human_request_changes', feedback: 'Revise the design for v2' })
      expect(reopened.status).toBe(200)
      expect(await taskRow(design.id)).toMatchObject({ status: 'in_progress' })
      expect((await versionsOf(design))[0]).toMatchObject({ status: 'approved' })
      const feedback = await t.request('GET', `/api/projects/${project.slug}/tasks/${design.number}/comments`).then(r => r.json())
      expect(feedback).toContainEqual(expect.objectContaining({ body: 'Revise the design for v2', pinned: true }))
      await t.db.update(tasks).set({ status: 'human_review' }).where(eq(tasks.id, design.id))
      await t.db.insert(designVersions).values({ taskId: design.id, version: 2, bundleBlob: v1.bundleBlob, specBlob: v1.specBlob, screenshots: v1.screenshots, branch: v1.branch, commitSha: 'd2' })
      expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${design.number}/designs/2/approve`)).status).toBe(200)
      expect((await versionsOf(design)).map(v => v.status)).toEqual(['superseded', 'approved'])

      // Unstarted tasks are flagged; started and merged ones keep v1 untouched
      for (const task of [ready, backlog, draft]) expect(await pinOf(task)).toMatchObject({ version: 1, newerVersion: 2 })
      for (const task of [inProgress, merged, restarted]) expect(await pinOf(task)).toMatchObject({ version: 1, newerVersion: null })
      // The board shows the flag too
      const board = await t.request('GET', `/api/projects/${project.slug}/tasks`).then(r => r.json()) as Task[]
      expect(board.find(x => x.id === ready.id)?.design).toMatchObject({ newerVersion: 2 })

      // The PM is told in v2's Plan session
      const [v2] = (await versionsOf(design)).slice(1)
      const [message] = await t.db.select().from(planMessages).where(eq(planMessages.sessionId, v2!.planSessionId!))
      expect(message!.text).toContain(`design v2 of ${design.ref}`)
      for (const task of [ready, backlog, draft]) expect(message!.text).toContain(`${task.ref} "${task.title}"`)
      expect(message!.text).toContain('design changed: v1 → v2')
      for (const task of [inProgress, merged, restarted]) expect(message!.text).not.toContain(task.ref)

      // Repinning to v2 clears the flag
      await t.db.update(taskDesignPins).set({ designVersionId: v2!.id }).where(eq(taskDesignPins.taskId, ready.id))
      expect(await pinOf(ready)).toMatchObject({ version: 2, newerVersion: null })
    })
  })

  it('refuses to approve while the runner is offline, so the build is never left unplanned', async () => {
    const { project, task } = await approved()
    const developer = await nextJob(task, 'developer')
    await submit(project, developer, task, 'd1')
    await review(task)
    await pause(project)
    runner.close()
    try {
      await expect.poll(() => t.runner.online).toBe(false)
      const res = await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/designs/1/approve`)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: { code: 'runner_offline' } })
      expect((await versionsOf(task))[0]).toMatchObject({ status: 'submitted', planSessionId: null })
      expect(await t.db.select().from(planSessions).where(eq(planSessions.projectId, project.id))).toHaveLength(0)
    } finally {
      runner = await FakeRunner.connect(t.server!.url)
      await expect.poll(() => t.runner.online).toBe(true)
    }
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
