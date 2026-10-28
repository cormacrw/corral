import type { Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

describe.each(['pglite', 'postgres'] as const)('HTTP API on %s', (driver) => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp(driver)
  })

  afterAll(async () => {
    await t?.close()
  })

  async function transition(slug: string, number: number, body: unknown) {
    return t.request('POST', `/api/projects/${slug}/tasks/${number}/transitions`, body)
  }

  it('reports health', async () => {
    const res = await t.request('GET', '/api/health')
    expect(await res.json()).toEqual({ ok: true })
  })

  describe('profile pictures', () => {
    // A 1×1 PNG
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))

    it('stores, serves and removes the human\'s picture', async () => {
      expect(await t.request('GET', '/api/me').then(r => r.json())).toMatchObject({ avatarUrl: null })
      const saved = await t.request('PUT', '/api/me/avatar', new Blob([png], { type: 'image/png' }))
      expect(saved.status).toBe(200)
      const { avatarUrl } = await saved.json() as { avatarUrl: string }
      expect(avatarUrl).toMatch(/^\/api\/me\/avatar\?v=[0-9a-f]{12}$/)
      const served = await t.request('GET', avatarUrl)
      expect(served.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(png)
      expect(t.events.some(e => e.type === 'profile.updated' && e.profile.avatarUrl === avatarUrl)).toBe(true)
      expect(await t.request('DELETE', '/api/me/avatar').then(r => r.json())).toMatchObject({ avatarUrl: null })
      expect((await t.request('GET', '/api/me/avatar')).status).toBe(404)
    })

    it('stores an agent\'s picture and shows it on the agent', async () => {
      const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
      const saved = await t.request('PUT', `/api/agents/${agent!.id}/avatar`, new Blob([png], { type: 'image/png' }))
      expect(await saved.json()).toMatchObject({ id: agent!.id, avatarUrl: expect.stringMatching(new RegExp(`^/api/agents/${agent!.id}/avatar\\?v=`)) })
      const listed = await t.request('GET', '/api/agents').then(r => r.json()) as { id: string, avatarUrl: string | null }[]
      expect(listed.find(a => a.id === agent!.id)?.avatarUrl).toBeTruthy()
      expect(t.events.some(e => e.type === 'agent.updated' && e.agent.id === agent!.id && e.agent.avatarUrl !== null)).toBe(true)
      expect((await t.request('PUT', '/api/agents/not-an-id/avatar', new Blob([png], { type: 'image/png' }))).status).toBe(404)
    })

    it('rejects files that aren\'t the image they claim to be', async () => {
      const text = await t.request('PUT', '/api/me/avatar', new Blob(['hello'], { type: 'text/plain' }))
      expect(text.status).toBe(400)
      const fake = await t.request('PUT', '/api/me/avatar', new Blob(['<svg/>'], { type: 'image/png' }))
      expect(fake.status).toBe(400)
      expect(await fake.json()).toMatchObject({ error: { code: 'invalid_input', issues: [{ message: 'The file isn\'t a PNG image' }] } })
      const huge = await t.request('PUT', '/api/me/avatar', new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'image/png' }))
      expect(huge.status).toBe(413)
    })
  })

  describe('projects', () => {
    it('creates a project with a slug from its name', async () => {
      const project = await t.createProject({ name: 'Corral Web', prefix: 'CW' })
      expect(project).toMatchObject({ name: 'Corral Web', slug: 'corral-web', prefix: 'CW', mergeMethod: 'squash' })
      const res = await t.request('GET', '/api/projects/corral-web')
      expect(await res.json()).toEqual(project)
    })

    it('lets only one project use a repository (D13)', async () => {
      await t.createProject({ repository: 'owner/taken' })
      const res = await t.request('POST', '/api/projects', {
        name: 'Again', prefix: 'AGN', repository: 'owner/taken', defaultBranch: 'main'
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: { code: 'conflict', constraint: 'projects_repository_unique' } })
    })

    it('rejects a bad prefix', async () => {
      const res = await t.request('POST', '/api/projects', {
        name: 'Bad', prefix: 'toolong', repository: 'owner/bad', defaultBranch: 'main'
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_input')
    })

    it('returns 404 for an unknown project', async () => {
      expect((await t.request('GET', '/api/projects/nope')).status).toBe(404)
    })
  })

  describe('tasks', () => {
    it('numbers tasks per project and starts them in Backlog', async () => {
      const project = await t.createProject({ prefix: 'NUM' })
      const first = await t.createTask(project.slug)
      const second = await t.createTask(project.slug, { dependsOn: [1] })
      expect(first).toMatchObject({ ref: 'NUM-1', status: 'backlog', lease: null, dependsOn: [] })
      expect(second).toMatchObject({ ref: 'NUM-2', dependsOn: ['NUM-1'] })
      expect(second.acceptanceCriteria.map(c => c.text)).toEqual(['Shows an error on a bad password'])
    })

    it('takes the human-review default from the project (D5)', async () => {
      const project = await t.createProject({ humanReviewDefault: true })
      expect((await t.createTask(project.slug)).humanReview).toBe(true)
      expect((await t.createTask(project.slug, { humanReview: false })).humanReview).toBe(false)
    })

    it('rejects a dependency on a task that does not exist', async () => {
      const project = await t.createProject({ prefix: 'DEP' })
      const res = await t.request('POST', `/api/projects/${project.slug}/tasks`, { title: 'X', type: 'backend', dependsOn: [7] })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'invalid_dependencies', problems: [{ code: 'unknown_dependency', dependsOn: 'DEP-7' }] }
      })
    })

    it('splits the board from the backlog (D10)', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      await t.createTask(project.slug)
      await transition(project.slug, 2, { type: 'approve' })

      const list = async (view: string) =>
        ((await (await t.request('GET', `/api/projects/${project.slug}/tasks?view=${view}`)).json()) as Task[]).map(x => x.number)
      expect(await list('board')).toEqual([2])
      expect(await list('backlog')).toEqual([1])
      expect(await list('all')).toEqual([1, 2])
    })
  })

  describe('transitions', () => {
    it('approves a task that meets the Definition of Ready', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      const res = await transition(project.slug, 1, { type: 'approve' })
      expect(res.status).toBe(200)
      expect(((await res.json()) as Task).status).toBe('ready')
    })

    it('explains why a task is not ready', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug, { description: null, acceptanceCriteria: [] })
      const res = await transition(project.slug, 1, { type: 'approve' })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: { code: 'transition_rejected', reason: { code: 'not_ready', problems: ['missing_description', 'missing_acceptance_criteria'] } }
      })
    })

    it('rejects a transition D10 does not allow from the current status', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      const res = await transition(project.slug, 1, { type: 'send_back' })
      expect(await res.json()).toEqual({
        error: { code: 'transition_rejected', reason: { code: 'invalid_transition', status: 'backlog', event: 'send_back' } }
      })
    })

    it('accepts only the transitions a human may ask for', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      const res = await transition(project.slug, 1, { type: 'claim' })
      expect(res.status).toBe(400)
    })

    it('records who did it in the audit log (D1)', async () => {
      const project = await t.createProject()
      const task = await t.createTask(project.slug)
      await transition(project.slug, 1, { type: 'approve' })
      await transition(project.slug, 1, { type: 'send_back' })

      const entries = await t.db.select().from(schema.auditLog)
        .where(eq(schema.auditLog.taskId, task.id))
        .orderBy(asc(schema.auditLog.id))
      expect(entries.map(e => [e.action, e.actor, e.detail])).toEqual([
        ['task.created', t.actor, { number: 1 }],
        ['task.transition', t.actor, { event: { type: 'approve' }, from: 'backlog', to: 'ready' }],
        ['task.transition', t.actor, { event: { type: 'send_back' }, from: 'ready', to: 'backlog' }]
      ])
    })

    it('publishes the updated task for live updates', async () => {
      const project = await t.createProject()
      await t.createTask(project.slug)
      t.events.length = 0
      await transition(project.slug, 1, { type: 'approve' })
      expect(t.events).toMatchObject([{ type: 'task.updated', task: { number: 1, status: 'ready' } }])
    })
  })
})
