import type { Run } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const { agents, epics, runs } = schema

let t: TestApp
beforeAll(async () => {
  t = await createTestApp('pglite')
})
afterAll(async () => {
  await t?.close()
})

async function agentOf(role: 'pm' | 'developer' | 'reviewer') {
  const [agent] = await t.db.select().from(agents).where(eq(agents.role, role))
  return agent!
}

it('names the epic on its integration reviews, and only those', async () => {
  const project = await t.createProject()
  const task = await t.createTask(project.slug, { title: 'Search API' })
  const [epic] = await t.db.insert(epics).values({ projectId: project.id, createdBy: t.actor, title: 'Saved searches' }).returning()
  const reviewer = await agentOf('reviewer')
  const [review, finished, build, turn] = await t.db.insert(runs).values([
    { agentId: reviewer.id, projectId: project.id, epicId: epic!.id, role: 'reviewer', state: 'running' },
    { agentId: reviewer.id, projectId: project.id, epicId: epic!.id, role: 'reviewer', state: 'completed', outcome: 'approved', summary: 'Works together.' },
    { agentId: (await agentOf('developer')).id, projectId: project.id, taskId: task.id, role: 'developer', state: 'completed' },
    { agentId: (await agentOf('pm')).id, projectId: project.id, role: 'pm', state: 'completed' }
  ]).returning()

  const get = async (id: string) => await (await t.request('GET', `/api/runs/${id}`)).json() as Run
  const expected = { epicId: epic!.id, epicTitle: 'Saved searches', taskId: null, taskRef: null, taskTitle: null }
  const list = await (await t.request('GET', `/api/runs?agentId=${reviewer.id}`)).json() as Run[]
  expect(list.map(r => r.id)).toEqual([finished!.id, review!.id])
  for (const run of [...list, await get(review!.id), await get(finished!.id)]) expect(run).toMatchObject(expected)

  expect(await get(build!.id)).toMatchObject({ epicId: null, epicTitle: null, taskRef: task.ref, taskTitle: 'Search API' })
  expect(await get(turn!.id)).toMatchObject({ epicId: null, epicTitle: null, taskRef: null, taskTitle: null })
})
