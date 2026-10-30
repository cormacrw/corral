import type { AuditEntry, Comment, RunMessageAccepted, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

// POST /projects/:slug/runs/:runId/messages, against a fake runner
describe('messages to a live run', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    // Each test leaves its run live, so the developer needs room for all of them
    await t.db.update(schema.agents).set({ concurrency: 50 }).where(eq(schema.agents.role, 'developer'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  // An approved task the developer has claimed, with its run started
  async function liveRun(type: 'task' | 'design' = 'task') {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { type })
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 's1' })
    await expect.poll(async () => (await t.db.select().from(schema.runs).where(eq(schema.runs.id, job.runId)))[0]?.state).toBe('running')
    return { project, task, job }
  }

  const post = (slug: string, runId: string, body: unknown) => t.request('POST', `/api/projects/${slug}/runs/${runId}/messages`, body)

  it.each(['task', 'design'] as const)('forwards a %s message to the runner, keeps it as a comment and audits it', async (type) => {
    const { project, task, job } = await liveRun(type)
    const res = await post(project.slug, job.runId, { text: '  Use the existing login form  ' })
    expect(res.status).toBe(202)
    const body = await res.json() as RunMessageAccepted
    expect(body).toMatchObject({ runId: job.runId, comment: { taskId: task.id, author: t.actor, body: 'Use the existing login form', pinned: false } })

    const sent = await runner.next('run.message', m => m.runId === job.runId)
    expect(sent).toEqual({ type: 'run.message', runId: job.runId, leaseEpoch: job.leaseEpoch, text: 'Use the existing login form' })

    const comments = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/comments`).then(r => r.json()) as Comment[]
    expect(comments.map(c => c.body)).toContain('Use the existing login form')
    const history = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/history`).then(r => r.json()) as AuditEntry[]
    const entry = history.find(h => h.action === 'run.message_sent')
    expect(entry).toMatchObject({ actor: t.actor, taskId: task.id, detail: { runId: job.runId, commentId: body.comment.id } })
    expect(Date.parse(entry!.createdAt)).not.toBeNaN()
    expect(t.events.some(e => e.type === 'comment.created' && e.comment.id === body.comment.id)).toBe(true)
  })

  it('references attachments from the project in the message', async () => {
    const { project, job } = await liveRun()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const upload = await t.request('POST', `/api/projects/${project.slug}/attachments?name=screen.png`, new Blob([png], { type: 'image/png' })).then(r => r.json()) as { id: string }
    const res = await post(project.slug, job.runId, { text: 'Like this', attachments: [upload.id] })
    expect(res.status).toBe(202)
    const sent = await runner.next('run.message', m => m.runId === job.runId)
    expect(sent.text).toBe(`Like this\n\n![screen.png](attachment:${upload.id})`)

    const other = await t.createProject()
    const foreign = await t.request('POST', `/api/projects/${other.slug}/attachments`, new Blob([png], { type: 'image/png' })).then(r => r.json()) as { id: string }
    expect((await post(project.slug, job.runId, { text: 'x', attachments: [foreign.id] })).status).toBe(400)
  })

  it('returns 409 with a reason for an ended run, and records nothing', async () => {
    const { project, task, job } = await liveRun()
    await t.request('POST', `/api/runs/${job.runId}/stop`)
    const res = await post(project.slug, job.runId, { text: 'Too late' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'run_not_live', reason: expect.stringMatching(/has ended$/) } })
    const comments = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/comments`).then(r => r.json()) as Comment[]
    expect(comments.map(c => c.body)).not.toContain('Too late')
    expect(runner.received.some(m => m.type === 'run.message' && m.runId === job.runId)).toBe(false)
  })

  it('returns 409 when no runner is connected', async () => {
    const { project, task, job } = await liveRun()
    runner.close()
    await expect.poll(() => t.runner.online).toBe(false)
    try {
      const res = await post(project.slug, job.runId, { text: 'Anyone there?' })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: { code: 'run_not_live', reason: 'No runner is connected to deliver the message' } })
      const history = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/history`).then(r => r.json()) as AuditEntry[]
      expect(history.some(h => h.action === 'run.message_sent')).toBe(false)
    } finally {
      runner = await FakeRunner.connect(t.server!.url, [{ runId: job.runId, leaseEpoch: job.leaseEpoch }])
    }
  })

  it('404s for a run in another project, and 400s for an empty message', async () => {
    const { project, job } = await liveRun()
    const other = await t.createProject()
    expect((await post(other.slug, job.runId, { text: 'Hi' })).status).toBe(404)
    expect((await post(project.slug, job.runId, { text: '   ' })).status).toBe(400)
  })
})

// PRD §7.3: editing a task while a run holds it tells the run
describe('edits to a task with a live run', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(schema.agents).set({ concurrency: 50 }).where(eq(schema.agents.role, 'developer'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  async function liveRun(type: 'task' | 'design' = 'task') {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { type })
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 's1' })
    await expect.poll(async () => (await t.db.select().from(schema.runs).where(eq(schema.runs.id, job.runId)))[0]?.state).toBe('running')
    return { project, task, job }
  }

  const patch = (slug: string, number: number, body: unknown) => t.request('PATCH', `/api/projects/${slug}/tasks/${number}`, body)
  const comments = (slug: string, number: number) => t.request('GET', `/api/projects/${slug}/tasks/${number}/comments`).then(r => r.json()) as Promise<Comment[]>
  const messagesFor = (runId: string) => runner.received.filter(m => m.type === 'run.message' && m.runId === runId)

  it.each(['task', 'design'] as const)('sends a Claude %s run the new acceptance criteria', async (type) => {
    const { project, task, job } = await liveRun(type)
    const kept = task.acceptanceCriteria[0]!
    const res = await patch(project.slug, task.number, { acceptanceCriteria: [{ id: kept.id, text: kept.text }, { text: 'Locks the account after five tries' }] })
    expect(res.status).toBe(200)
    const updated = await res.json() as Task
    const added = updated.acceptanceCriteria[1]!

    const sent = await runner.next('run.message', m => m.runId === job.runId)
    expect(sent.leaseEpoch).toBe(job.leaseEpoch)
    expect(sent.text).toContain(`The acceptance criteria of ${task.ref} changed while you were working on it`)
    expect(sent.text).toContain('**Acceptance criteria** (1 added)')
    expect(sent.text).toContain(`- [${kept.id}] ${kept.text}`)
    expect(sent.text).toContain(`- [${added.id}] Locks the account after five tries`)
    expect(sent.text).not.toContain('**Description**')

    // Kept as the human's comment, like any message to a run, and not pinned
    expect((await comments(project.slug, task.number)).find(c => c.body === sent.text)).toMatchObject({ author: t.actor, pinned: false })
    const history = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/history`).then(r => r.json()) as AuditEntry[]
    expect(history.some(h => h.action === 'run.message_sent')).toBe(true)
  })

  it('sends the new description when only the description changed, and nothing for other fields', async () => {
    const { project, task, job } = await liveRun()
    await patch(project.slug, task.number, { priority: 'high', title: 'Add a login page' })
    // Same description and criteria as before: no change to tell
    await patch(project.slug, task.number, { description: task.description, acceptanceCriteria: task.acceptanceCriteria.map(c => ({ id: c.id, text: c.text })) })
    expect(messagesFor(job.runId)).toHaveLength(0)

    const description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Email, password and a magic link' }] }] }
    expect((await patch(project.slug, task.number, { description })).status).toBe(200)
    const sent = await runner.next('run.message', m => m.runId === job.runId)
    expect(sent.text).toContain(`The description of ${task.ref} changed`)
    expect(sent.text).toContain('**Description**\n\nEmail, password and a magic link')
    expect(sent.text).not.toContain('**Acceptance criteria**')
  })

  it('sends nothing when no run holds the task', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    const before = runner.received.length
    const res = await patch(project.slug, task.number, { acceptanceCriteria: [{ text: 'Something new' }] })
    expect(res.status).toBe(200)
    expect(runner.received.slice(before).some(m => m.type === 'run.message')).toBe(false)
    expect(await comments(project.slug, task.number)).toEqual([])
  })

  it('pins a comment instead during a Codex run', async () => {
    const { project, task, job } = await liveRun()
    await t.db.update(schema.agents).set({ runtime: 'codex' }).where(eq(schema.agents.role, 'developer'))
    try {
      const res = await patch(project.slug, task.number, { acceptanceCriteria: [{ id: task.acceptanceCriteria[0]!.id, text: 'Shows a clear error on a bad password' }] })
      expect(res.status).toBe(200)
      const pinned = (await comments(project.slug, task.number)).filter(c => c.pinned)
      expect(pinned).toHaveLength(1)
      expect(pinned[0]).toMatchObject({ author: t.actor })
      expect(pinned[0]!.body).toContain(`The acceptance criteria of ${task.ref} changed during run #`)
      expect(pinned[0]!.body).toContain('(1 reworded)')
      expect(pinned[0]!.body).toContain(`- [${task.acceptanceCriteria[0]!.id}] Shows a clear error on a bad password`)
      expect(messagesFor(job.runId)).toHaveLength(0)
      expect(t.events.some(e => e.type === 'comment.created' && e.comment.id === pinned[0]!.id)).toBe(true)
      const history = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/history`).then(r => r.json()) as AuditEntry[]
      expect(history.find(h => h.action === 'task.edit_pinned')).toMatchObject({ actor: t.actor, detail: { runId: job.runId, commentId: pinned[0]!.id } })
    } finally {
      await t.db.update(schema.agents).set({ runtime: 'claude-code' }).where(eq(schema.agents.role, 'developer'))
    }
  })
})
