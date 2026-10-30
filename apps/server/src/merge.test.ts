import type { Inbox, Project, Task, TaskInboxItem } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, auditLog, comments, runs, tasks } = schema

// The merge orchestrator, deletion, the kill switch and the Inbox, on
// Postgres with a fake runner and FakeGitHub
describe('merge orchestrator and human controls', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('postgres', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  async function taskRow(id: string) {
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, id))
    return row!
  }

  async function getTask(project: Project, number: number): Promise<Task> {
    return t.request('GET', `/api/projects/${project.slug}/tasks/${number}`).then(r => r.json()) as Promise<Task>
  }

  async function pause(project: Project) {
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  }

  // Approve, claim, submit with evidence, review and approve: the task waits
  // in Agent review with an approved verdict for 'abc123'
  async function approved(options: { humanReview?: boolean, requiredChecks?: string[], task?: Parameters<TestApp['createTask']>[1], noteEvidence?: boolean, reviewRounds?: number } = {}) {
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { requiredChecks: options.requiredChecks ?? ['lint'] })
    const created = await t.createTask(project.slug, { ...(options.humanReview !== undefined && { humanReview: options.humanReview }), ...options.task })
    if (options.reviewRounds !== undefined) await t.db.update(tasks).set({ reviewRounds: options.reviewRounds }).where(eq(tasks.id, created.id))
    await t.request('POST', `/api/projects/${project.slug}/tasks/${created.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    const dev = (await runner.next('run.assign', m => m.job.taskId === created.id)).job
    const task = await getTask(project, created.number)
    t.github.setBranch(project.repository, dev.branch!, 'abc123')
    for (const criterion of task.acceptanceCriteria) {
      await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', options.noteEvidence
        ? { criterionId: criterion.id, kind: 'note', note: 'No behaviour change' }
        : { criterionId: criterion.id, kind: 'test_output', fileName: 't.txt', contentType: 'text/plain', dataBase64: Buffer.from('ok').toString('base64') })
    }
    expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Done', headSha: 'abc123' })).toMatchObject({ ok: true })
    await t.orchestrator.schedule()
    const review = (await runner.next('run.assign', m => m.job.taskId === created.id && m.job.role === 'reviewer')).job
    expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'approved', summary: 'Looks right', criteria: task.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: '' }))
    })).toMatchObject({ ok: true })
    const pr = [...t.github.pulls.values()].find(p => p.head === dev.branch)!
    return { project, task: await getTask(project, created.number), pr, dev }
  }

  it('waits while required checks are pending, and sends CI failures back to the developer', async () => {
    const { project, task, pr } = await approved()
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })

    t.github.setChecks(pr.headSha, [{ name: 'lint', conclusion: 'failure', url: 'https://ci/1' }])
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress' })
    const notes = await t.db.select().from(comments).where(eq(comments.taskId, task.id))
    expect(notes.at(-1)?.body).toContain('lint: failed (https://ci/1)')
    expect(notes.at(-1)?.body).toContain('pr_updated')
    // The pass the reviewer's handoff poked may already have claimed the task,
    // so wait for the developer's run rather than expecting a gap before it
    await t.orchestrator.schedule()
    const rework = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', leaseRunId: rework.runId })
    await pause(project)
  })

  it('updates a branch that fell behind, keeps the approval over the update, then merges and cleans up', async () => {
    const { project, task, pr } = await approved()
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    t.github.pulls.get(pr.number)!.mergeableState = 'behind'
    await t.orchestrator.merges.tick()
    expect(t.github.calls.filter(c => c.method === 'updateBranch')).toHaveLength(1)
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge', branchUpdateRequested: true })

    // GitHub rebased the branch, rewriting every commit, so the head is new; CI runs again on it
    t.github.setBranch(project.repository, pr.head, 'def456')
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge', headSha: 'def456', branchUpdateRequested: false })
    const reviews = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/reviews`).then(r => r.json()) as { headSha: string, verdict: string, round: number }[]
    expect(reviews[0]).toMatchObject({ headSha: 'def456', verdict: 'approved', round: task.reviewRounds })
    expect((await taskRow(task.id)).reviewRounds).toBe(task.reviewRounds)
    await t.orchestrator.schedule()
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === task.id)).toHaveLength(0)

    t.github.setChecks('def456', [{ name: 'lint', conclusion: 'success', url: null }])
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'merged', mergeCommitSha: 'merge-sha' })
    expect(t.github.pulls.get(pr.number)).toMatchObject({ merged: true })
    // Merged tasks are read-only except for comments
    expect((await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { title: 'Changed' })).status).toBe(409)
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body: 'Shipped, thanks' })).status).toBe(201)
    await sleep(100)
    const history = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/history`).then(r => r.json()) as { action: string, detail: Record<string, unknown> }[]
    expect(history.map(h => h.action)).toEqual(expect.arrayContaining(['task.claimed', 'review.recorded', 'branch.update_requested', 'branch.head_moved', 'task.transition', 'worktrees.cleaned']))
    expect(history.find(h => h.action === 'worktrees.cleaned')?.detail).toMatchObject({ removed: [`worktrees/${task.id}`] })
    await pause(project)
  })

  it('treats note-only evidence as complete and merges (D21)', async () => {
    const { project, task, pr } = await approved({ noteEvidence: true })
    const evidence = await t.db.select().from(schema.evidence).where(eq(schema.evidence.taskId, task.id))
    expect(evidence.map(e => ({ kind: e.kind, blob: e.blob }))).toEqual([{ kind: 'note', blob: null }])
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    const status = await t.request('GET', `/api/projects/${project.slug}/pull-requests`).then(r => r.json()) as { taskRef: string, evidenceComplete: boolean, merge: { eligible: boolean } }[]
    expect(status.find(s => s.taskRef === task.ref)).toMatchObject({ evidenceComplete: true, merge: { eligible: true } })
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
    expect(t.github.pulls.get(pr.number)).toMatchObject({ merged: true })
    await pause(project)
  })

  it('needs a fresh review when a commit other than a base update arrives', async () => {
    const { project, task, pr } = await approved()
    t.github.setBranch(project.repository, pr.head, 'fff999')
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', headSha: 'fff999' })
    await t.orchestrator.schedule()
    const review = await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')
    expect(review.job.headSha).toBe('fff999')
    await pause(project)
  })

  it('sends a conflicting branch back to the developer', async () => {
    const { project, task, pr } = await approved({ reviewRounds: 2 })
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    t.github.pulls.get(pr.number)!.mergeable = false
    t.github.pulls.get(pr.number)!.mergeableState = 'dirty'
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', rebaseOnly: true, approvedHeadSha: 'abc123', reviewRounds: task.reviewRounds })
    const notes = await t.db.select().from(comments).where(eq(comments.taskId, task.id))
    expect(notes.at(-1)?.body).toContain('can’t be merged')
    expect(notes.at(-1)?.body).toContain('Rebase onto `origin/main`, resolve the conflicts, and report pr_rebased.')
    expect(notes.at(-1)?.body).not.toContain('Merge')
    await t.orchestrator.schedule()
    const rebase = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
    expect(rebase.prompt).toContain('rebase-only round')
    expect(rebase.prompt).not.toContain('This is a revision')
    expect(await getTask(project, task.number)).toMatchObject({ status: 'in_progress', reviewRounds: task.reviewRounds })
    expect(await runner.call(rebase.runId, rebase.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', note: 'Resolved conflicts', summary: 'Resolved', headSha: 'rebased' })).toMatchObject({ ok: false, error: expect.stringContaining('pr_rebased') })
    t.github.setBranch(project.repository, rebase.branch!, 'rebased')
    expect(await runner.call(rebase.runId, rebase.leaseEpoch, 'report_outcome', { outcome: 'pr_rebased', review: 'needs_review', conflictedFiles: ['app.ts'], note: 'Resolved conflicts', summary: 'Kept both changes in app.ts', headSha: 'rebased' })).toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', reviewRounds: task.reviewRounds, approvedHeadSha: 'abc123', headSha: 'rebased' })
    expect(await getTask(project, task.number)).toMatchObject({ status: 'agent_review', reviewRounds: task.reviewRounds })
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.activity.find(i => i.taskId === task.id && i.preview === `Rebased PR #${pr.number}; on to the reviewer`))
      .toMatchObject({ body: `Rebased PR #${pr.number}; on to the reviewer`, prUrl: pr.url, type: 'activity' })

    await t.orchestrator.schedule()
    const review = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
    expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'approved', summary: 'Rebase preserves the approved work', criteria: task.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: '' }))
    })).toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge', rebaseOnly: false, approvedHeadSha: 'abc123' })
    t.github.pulls.get(pr.number)!.state = 'closed'
    await t.orchestrator.merges.tick()
    expect(await getTask(project, task.number)).toMatchObject({ status: 'failed' })
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'resolve', to: 'in_progress' })).status).toBe(200)
    await t.orchestrator.schedule()
    const fix = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
    expect(fix.prompt).not.toContain('rebase-only round')
    expect(await runner.call(fix.runId, fix.leaseEpoch, 'report_outcome', { outcome: 'pr_rebased', review: 'needs_review', conflictedFiles: ['app.ts'], note: 'Fixed merge failure', summary: 'Restored PR', headSha: 'fixed' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('pr_opened or pr_updated') })
    t.github.setBranch(project.repository, fix.branch!, 'fixed')
    expect(await runner.call(fix.runId, fix.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', note: 'Fixed merge failure', summary: 'Restored PR', headSha: 'fixed' }))
      .toMatchObject({ ok: true })
    expect(await getTask(project, task.number)).toMatchObject({ status: 'agent_review', headSha: 'fixed', reviewRounds: task.reviewRounds })
    await pause(project)
  })

  it('sends a branch back to the developer when the rebase onto the base conflicts', async () => {
    const { project, task, pr } = await approved()
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    t.github.pulls.get(pr.number)!.mergeableState = 'behind'
    t.github.updateBranchResult = false
    try {
      await t.orchestrator.merges.tick()
    } finally {
      t.github.updateBranchResult = true
    }
    expect(t.github.calls.filter(c => c.method === 'updateBranch' && c.args[1] === pr.number)).toHaveLength(1)
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', branchUpdateRequested: false })
    const notes = await t.db.select().from(comments).where(eq(comments.taskId, task.id))
    expect(notes.at(-1)?.body).toBe('The base branch `main` has moved and the update conflicts with this branch. Rebase onto `origin/main`, resolve the conflicts, and report pr_rebased.')
    expect(notes.at(-1)?.body).not.toContain('Merge')
    const history = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/history`).then(r => r.json()) as { action: string, detail: Record<string, unknown> }[]
    expect(history.find(h => h.action === 'task.transition' && h.detail.event === 'base_conflict')).toBeDefined()
    await pause(project)
  })

  it('hands a flagged task to the human; approving moves it to Ready to merge and Corral merges it', async () => {
    const { project, task, pr } = await approved({ humanReview: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'human_review' })
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: 'https://ci/lint' }])
    // Nothing merges while the human hasn't approved
    await t.orchestrator.merges.tick()
    expect(t.github.pulls.get(pr.number)).toMatchObject({ merged: false })

    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    const item = inbox.needsYou.filter((i): i is TaskInboxItem => i.type !== 'plan_thread').find(i => i.taskId === task.id)
    expect(item).toMatchObject({ type: 'human_review', taskRef: task.ref, prUrl: pr.url, sender: { name: 'Vera', role: 'reviewer' } })
    expect(item?.body).toBe('Approved, all 1 criteria met. This task is marked for human review, so it needs your OK before it merges.')
    // It arrived when it entered Human review; an update that keeps the status, such as the PR head moving, doesn't move it
    const [entered] = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.transition'))).orderBy(desc(auditLog.createdAt)).limit(1)
    expect(item?.at).toBe(entered!.createdAt.toISOString())
    await t.db.update(tasks).set({ headSha: 'def456', updatedAt: new Date(Date.now() + 60_000) }).where(eq(tasks.id, task.id))
    const moved = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(moved.needsYou.find(i => i.taskId === task.id)?.at).toBe(item?.at)
    await t.db.update(tasks).set({ headSha: 'abc123' }).where(eq(tasks.id, task.id))

    // The human's part is done on approval: the item resolves at once and
    // the merge finishes in the background
    const res = await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ task: { status: 'ready_to_merge' } })
    const resolved = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(resolved.needsYou.some(i => i.taskId === task.id)).toBe(false)
    expect(resolved.resolved.find(i => i.taskId === task.id)?.resolution).toBe('You approved the merge')
    await vi.waitFor(async () => expect(await taskRow(task.id)).toMatchObject({ status: 'merged', gateChecks: [{ name: 'lint', url: 'https://ci/lint' }] }))
    const merge = t.github.calls.findLast(c => c.method === 'merge')
    expect(merge?.args).toEqual([project.repository, pr.number, 'squash', 'abc123'])
    const audit = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.transition')))
    expect(audit.map(a => (a.detail as { event?: string }).event)).toEqual(expect.arrayContaining(['review_approved', 'human_approve', 'merged']))
    expect(audit.find(a => (a.detail as { event?: string }).event === 'human_approve')?.actor).toEqual(t.actor)
    await pause(project)
  })

  it('sends a human-approved task back to the developer when CI fails', async () => {
    const { project, task } = await approved({ humanReview: true })
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'failure', url: null }])
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/approve`)).status).toBe(200)
    await vi.waitFor(async () => expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress' }))
    await pause(project)
  })

  it('merges an unflagged task on the reviewer\'s approval when the project has no required checks', async () => {
    const { project, task, pr } = await approved({ requiredChecks: [], humanReview: false })
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
    expect(t.github.pulls.get(pr.number)).toMatchObject({ merged: true })
    await pause(project)
  })

  it('lets the human request changes, which pins the request for the developer', async () => {
    const { project, task } = await approved({ humanReview: true })
    const res = await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'request_changes', text: 'Use the shared button' })
    expect(res.status).toBe(200)
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', rebaseOnly: false })
    const notes = await t.db.select().from(comments).where(eq(comments.taskId, task.id))
    expect(notes.at(-1)).toMatchObject({ body: 'Use the shared button', pinned: true, author: { kind: 'human' } })
    await pause(project)
  })

  it('never marks a task Merged when GitHub refuses, and fails it after repeated refusals', async () => {
    const { project, task, pr } = await approved()
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    t.github.mergeResult = { merged: false, sha: null, message: 'Required status check is expected' }
    for (let i = 0; i < 2; i++) {
      await t.orchestrator.merges.tick()
      expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })
    }
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'failed', statusReason: expect.stringContaining('refused the merge 3 times') })
    expect(t.github.pulls.get(pr.number)).toMatchObject({ merged: false })
    t.github.mergeResult = { merged: true, sha: 'merge-sha', message: '' }
    await pause(project)
  })

  it('re-reads the PR after an ambiguous merge error and records the merge it finds', async () => {
    const { project, task, pr } = await approved()
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    t.github.mergeResult = new Error('socket hang up')
    // The merge did go through on GitHub's side
    const live = t.github.pulls.get(pr.number)!
    const original = t.github.merge.bind(t.github)
    t.github.merge = async (...args) => {
      live.merged = true
      live.state = 'closed'
      live.mergeCommitSha = 'ambiguous-sha'
      return original(...args)
    }
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'merged', mergeCommitSha: 'ambiguous-sha' })
    t.github.merge = original
    t.github.mergeResult = { merged: true, sha: 'merge-sha', message: '' }
    await pause(project)
  })

  it('deletes a Backlog task outright and keeps its audit entry', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    const res = await t.request('DELETE', `/api/projects/${project.slug}/tasks/${task.number}`)
    expect(res.status).toBe(204)
    expect(await t.db.select().from(tasks).where(eq(tasks.id, task.id))).toHaveLength(0)
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'task.deleted')).orderBy(auditLog.id)
    expect(audit).toBeDefined()
    expect(t.events.some(e => e.type === 'task.deleted' && e.taskId === task.id)).toBe(true)
  })

  it('soft-deletes a task in flight: stops the run, closes the PR, deletes the branch and blocks dependents', async () => {
    const { project, task, pr, dev } = await approved()
    const dependent = await t.createTask(project.slug, { dependsOn: [task.number] })
    await t.request('POST', `/api/projects/${project.slug}/tasks/${dependent.number}/transitions`, { type: 'approve' })
    // Give the task a live run again
    await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, task.id))
    await t.orchestrator.schedule()
    const run = (await runner.next('run.assign', m => m.job.taskId === task.id)).job

    const res = await t.request('DELETE', `/api/projects/${project.slug}/tasks/${task.number}`, { reason: 'Not needed' })
    expect(res.status).toBe(204)
    await runner.next('run.stop', m => m.runId === run.runId)
    expect((await t.db.select().from(runs).where(eq(runs.id, run.runId)))[0]).toMatchObject({ state: 'interrupted' })
    expect(t.github.pulls.get(pr.number)).toMatchObject({ state: 'closed', merged: false })
    expect(t.github.branches.has(`${project.repository}#${dev.branch}`)).toBe(false)
    expect(await taskRow(task.id)).toMatchObject({ deletedAt: expect.any(Date) })
    expect((await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`)).status).toBe(404)
    expect(await taskRow(dependent.id)).toMatchObject({ status: 'blocked', statusReason: 'A dependency was deleted' })
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.needsYou.find(i => i.taskId === dependent.id)).toMatchObject({ type: 'blocked' })
    expect(inbox.resolved.find(i => i.taskId === task.id)?.resolution).toBe('You deleted the task')
    await pause(project)
  })

  it('refuses to delete a Merged task', async () => {
    const { project, task } = await approved()
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    await t.orchestrator.merges.tick()
    expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
    expect((await t.request('DELETE', `/api/projects/${project.slug}/tasks/${task.number}`)).status).toBe(409)
    await pause(project)
  })

  it('stops everything with the kill switch and starts again on resume', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    const run = (await runner.next('run.assign', m => m.job.taskId === task.id)).job

    expect((await t.request('POST', '/api/stop-all')).status).toBe(200)
    await runner.next('run.stop', m => m.runId === run.runId)
    expect((await t.db.select().from(runs).where(eq(runs.id, run.runId)))[0]).toMatchObject({ state: 'interrupted' })
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', leaseRunId: null, failedRuns: 0 })
    expect(await t.request('GET', '/api/status').then(r => r.json())).toMatchObject({ stopped: true, updating: false })
    await t.orchestrator.schedule()
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === task.id)).toHaveLength(0)

    await t.request('POST', '/api/resume-all')
    const again = await runner.next('run.assign', m => m.job.taskId === task.id)
    expect(again.job.leaseEpoch).toBe(run.leaseEpoch + 1)
    await pause(project)
  })

  it('holds new work for an update while running work finishes, then carries on', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    const run = (await runner.next('run.assign', m => m.job.taskId === task.id)).job

    const { busy } = await t.request('POST', '/api/update-hold').then(r => r.json()) as { busy: number }
    expect(busy).toBeGreaterThan(0)
    expect(await t.request('GET', '/api/status').then(r => r.json())).toMatchObject({ stopped: false, updating: true })
    expect(runner.received.some(m => m.type === 'run.stop' && m.runId === run.runId)).toBe(false)

    // A task approved during the hold waits
    const waiting = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${waiting.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === waiting.id)).toHaveLength(0)

    runner.send({ type: 'run.ended', runId: run.runId, leaseEpoch: run.leaseEpoch, exit: { kind: 'stopped' }, headSha: null })
    await vi.waitFor(async () => {
      const again = await t.request('POST', '/api/update-hold').then(r => r.json()) as { busy: number }
      expect(again.busy).toBe(busy - 1)
    })

    expect(await t.request('DELETE', '/api/update-hold').then(r => r.json())).toEqual({ stopped: false, updating: false })
    await runner.next('run.assign', m => m.job.taskId === waiting.id)
    await pause(project)
  })

  it('pauses a project and an agent through their PATCH endpoints', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    // Paused before approving: approval pokes the scheduler straight away
    expect(await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true }).then(r => r.json())).toMatchObject({ paused: true })
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === task.id)).toHaveLength(0)

    // Likewise the agent is paused before the project resumes
    const [atlas] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
    expect(await t.request('PATCH', `/api/agents/${atlas!.id}`, { paused: true }).then(r => r.json())).toMatchObject({ paused: true })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
    await t.orchestrator.schedule()
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === task.id)).toHaveLength(0)
    await t.request('PATCH', `/api/agents/${atlas!.id}`, { paused: false })
    await runner.next('run.assign', m => m.job.taskId === task.id)
    await pause(project)
  })

  it('edits a task field by field and keeps criteria IDs', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    const other = await t.createTask(project.slug)
    const criterion = task.acceptanceCriteria[0]!
    const res = await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, {
      title: 'Add login (OAuth)',
      priority: 'high',
      humanReview: true,
      acceptanceCriteria: [{ id: criterion.id, text: 'Shows a clear error on a bad password' }, { text: 'Logs in with Google' }],
      dependsOn: [other.number]
    })
    expect(res.status).toBe(200)
    const updated = await res.json() as Task
    expect(updated).toMatchObject({ title: 'Add login (OAuth)', priority: 'high', humanReview: true, dependsOn: [other.ref] })
    expect(updated.acceptanceCriteria.map(c => [c.id === criterion.id, c.text])).toEqual([[true, 'Shows a clear error on a bad password'], [false, 'Logs in with Google']])

    // A cycle is rejected by core
    const cycle = await t.request('PATCH', `/api/projects/${project.slug}/tasks/${other.number}`, { dependsOn: [task.number] })
    expect(cycle.status).toBe(400)
    expect(await cycle.json()).toMatchObject({ error: { code: 'invalid_dependencies', problems: [{ code: 'cycle' }] } })
    expect((await t.request('GET', `/api/tasks/${task.ref}`).then(r => r.json()) as Task).id).toBe(task.id)
  })
})
