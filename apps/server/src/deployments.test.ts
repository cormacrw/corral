import type { Deployment } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const sha = (c: string) => c.repeat(40)

describe.each(['pglite', 'postgres'] as const)('POST /api/deployments on %s', (driver) => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp(driver)
  })

  afterAll(async () => {
    await t?.close()
  })

  it('records a deploy for the project with that repository, with its commits', async () => {
    const project = await t.createProject()
    const commits = [{ sha: sha('c'), subject: 'Second change' }, { sha: sha('b'), subject: 'First change' }]
    const res = await t.request('POST', '/api/deployments', { repository: project.repository.toUpperCase(), fromSha: sha('a'), toSha: sha('c'), commits })
    expect(res.status).toBe(201)
    const deployment = await res.json() as Deployment
    expect(deployment).toMatchObject({ projectId: project.id, fromSha: sha('a'), toSha: sha('c'), commits, notes: null, notesStatus: 'pending', readAt: null })
    const rows = await t.db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
    expect(rows).toHaveLength(1)
  })

  it('returns the existing record when the same toSha is posted again', async () => {
    const project = await t.createProject()
    const body = { repository: project.repository, fromSha: null, toSha: sha('d'), commits: [{ sha: sha('d'), subject: 'Only change' }] }
    const first = await t.request('POST', '/api/deployments', body)
    expect(first.status).toBe(201)
    const again = await t.request('POST', '/api/deployments', { ...body, commits: [] })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(await first.json())
    const rows = await t.db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
    expect(rows).toHaveLength(1)
  })

  it('keeps every commit of a long range', async () => {
    const project = await t.createProject()
    const commits = Array.from({ length: 1001 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0'), subject: `Change ${i}` }))
    const res = await t.request('POST', '/api/deployments', { repository: project.repository, fromSha: sha('a'), toSha: commits[0]!.sha, commits })
    expect(res.status).toBe(201)
    const [row] = await t.db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
    expect(row!.commits).toEqual(commits)
  })

  it('keeps the same toSha apart per project', async () => {
    const one = await t.createProject()
    const two = await t.createProject()
    for (const project of [one, two]) {
      const res = await t.request('POST', '/api/deployments', { repository: project.repository, fromSha: null, toSha: sha('e'), commits: [] })
      expect(res.status).toBe(201)
    }
  })

  it('404s for a repository no project uses and rejects bad input', async () => {
    const missing = await t.request('POST', '/api/deployments', { repository: 'nobody/nothing', fromSha: null, toSha: sha('f'), commits: [] })
    expect(missing.status).toBe(404)
    const project = await t.createProject()
    for (const body of [
      { repository: project.repository, fromSha: null, toSha: 'main', commits: [] },
      { repository: project.repository, toSha: sha('f'), commits: [] },
      { repository: project.repository, fromSha: null, toSha: sha('f'), commits: [{ sha: 'abc' }] }
    ]) {
      expect((await t.request('POST', '/api/deployments', body)).status).toBe(400)
    }
  })
})
