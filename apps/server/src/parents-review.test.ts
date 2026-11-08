import type { PlanSessionDetail, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimNextTask } from './claim.ts'
import { publishDependents } from './dependent-tasks.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './fake-runner.ts'

const { agents, comments, epics, epicDependencies, tasks, taskDependencies } = schema

// Parents at the edges: cycles, plan keys, promotion from every state, delivery
describe('delivery dependencies', () => {
  let t: TestApp
  let runner: FakeRunner
  let seq = 0
  const doc: { type: 'doc', content: unknown[] } = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Why' }] }] }
  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 })
    runner = await FakeRunner.connect(t.server!.url, [], 'r1', { slots: 100 })
  })
  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const item = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Task ${key}`, description: 'Build it', type: 'task', acceptanceCriteria: ['It works'], dependsOn: [], ...extra })
  const newProject = () => t.createProject({ repository: `cormacrw/edge-${seq++}`, defaultBranch: 'main' })
  async function start() {
    const project = await newProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    return { project, ...await turn(project.id) }
  }
  async function turn(projectId: string) {
    const created = await t.request('POST', '/api/plan/sessions', { projectId, text: 'Plan it' }).then(r => r.json()) as PlanSessionDetail
    const { job } = await runner.next('run.assign', m => m.job.planSessionId === created.id)
    const propose = (input: Record<string, unknown>) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', { title: 'Plan', ...input })
    const plans = async () => (await t.request('GET', `/api/plan/sessions/${created.id}`).then(r => r.json()) as PlanSessionDetail).plans
    return { session: created, job, propose, plans }
  }
  const approve = async (plans: () => Promise<{ id: string }[]>, to = 'backlog') => t.request('POST', `/api/plan/plans/${(await plans()).at(-1)!.id}/approve`, { to })
  const list = (slug: string, view = 'all') => t.request('GET', `/api/projects/${slug}/tasks?view=${view}`).then(r => r.json()) as Promise<Task[]>
  async function parentSetup(reviewMode: 'epic' | 'direct' = 'epic') {
    const project = await newProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const [d] = await t.db.insert(epics).values({ projectId: project.id, title: 'P', description: 'x', reviewMode, createdBy: t.actor }).returning()
    const mk = async () => await t.request('POST', `/api/projects/${project.slug}/tasks`, { title: 'S', type: 'task', epicId: d!.id, acceptanceCriteria: ['ok'] }).then(r => r.json()) as Task
    const a = await mk()
    const b = await mk()
    const [row] = await t.db.select().from(epics).where(eq(epics.id, d!.id))
    const [parent] = await t.db.select().from(tasks).where(eq(tasks.id, row!.taskId!))
    return { project, delivery: row!, parent: parent!, a, b }
  }
  const patch = (slug: string, number: number, body: unknown) => t.request('PATCH', `/api/projects/${slug}/tasks/${number}`, body)
  const addSub = (slug: string, number: number, body: Record<string, unknown> = {}) => t.request('POST', `/api/projects/${slug}/tasks/${number}/subtasks`, { title: 'Sub', type: 'task', ...body })

  describe('dependency cycles', () => {
    it('refuses a subtask that depends on its own task', async () => {
      const { project, a, parent } = await parentSetup()
      expect((await patch(project.slug, a.number, { dependsOn: [parent.number] })).status).toBe(400)
    })

    it('refuses a cycle through a task, on update and on create', async () => {
      const { project, delivery, b, parent } = await parentSetup()
      const other = await t.createTask(project.slug)
      expect((await patch(project.slug, other.number, { dependsOn: [parent.number] })).status).toBe(200)
      expect((await patch(project.slug, b.number, { dependsOn: [other.number] })).status).toBe(400)
      const created = await t.request('POST', `/api/projects/${project.slug}/tasks`, { title: 'In it', type: 'task', epicId: delivery.id, dependsOn: [other.number] })
      expect(created.status).toBe(400)
    })

    it('refuses moving a dependent into the task it waits on', async () => {
      const { project, delivery, parent } = await parentSetup()
      const other = await t.createTask(project.slug)
      await patch(project.slug, other.number, { dependsOn: [parent.number] })
      expect((await patch(project.slug, other.number, { epicId: delivery.id })).status).toBe(400)
    })
  })

  describe('plans', () => {
    it.each(['epics', 'parents'])('reads a ref-shaped %s key in dependsOn as a key', async (field) => {
      const { propose } = await start()
      const link = field === 'epics' ? 'epic' : 'parent'
      expect(await propose({ [field]: [{ key: 'epic-1', title: 'A' }, { key: 'epic-2', title: 'B', dependsOn: ['epic-1'] }], tasks: [item('a', { [link]: 'epic-1' }), item('c', { [link]: 'epic-1' }), item('b', { [link]: 'epic-2' }), item('d', { [link]: 'epic-2' })] })).toMatchObject({ ok: true })
    })

    it('keeps an existing task\'s prerequisites when the plan leaves them out', async () => {
      const { project, delivery, parent } = await parentSetup()
      const [q] = await t.db.insert(epics).values({ projectId: project.id, title: 'Q', createdBy: t.actor }).returning()
      await t.db.insert(epicDependencies).values({ projectId: project.id, epicId: delivery.id, dependsOnEpicId: q!.id })
      const { propose, plans } = await turn(project.id)
      expect(await propose({ parents: [{ key: 'p', ref: `${project.prefix}-${parent.number}` }], tasks: [item('c', { parent: 'p' })] })).toMatchObject({ ok: true })
      expect((await approve(plans)).status).toBe(200)
      expect(await t.db.select().from(epicDependencies).where(eq(epicDependencies.epicId, delivery.id))).toHaveLength(1)
    })

    it('keeps a Draft and its comments when a revision makes it a task', async () => {
      const { project, propose, plans } = await start()
      await propose({ tasks: [item('a')] })
      const [draft] = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
      await t.db.insert(comments).values({ taskId: draft!.id, author: t.actor, body: 'Keep me' })
      expect(await propose({ parents: [{ key: 'p', ref: `${project.prefix}-${draft!.number}` }], tasks: [item('s1', { parent: 'p' }), item('s2', { parent: 'p' })] })).toMatchObject({ ok: true })
      expect((await t.db.select().from(tasks).where(eq(tasks.id, draft!.id)))[0]).toMatchObject({ deletedAt: null })
      expect((await approve(plans)).status).toBe(200)
      expect((await t.db.select().from(tasks).where(eq(tasks.id, draft!.id)))[0]).toMatchObject({ status: 'parent' })
      expect(await t.db.select().from(comments).where(eq(comments.taskId, draft!.id))).toHaveLength(1)
      expect((await list(project.slug)).filter(task => task.parentTask?.id === draft!.id)).toHaveLength(2)
    })

    it('fails approval loudly when the task it would promote has gone', async () => {
      const { project, propose, plans } = await start()
      const big = await t.createTask(project.slug)
      await propose({ parents: [{ key: 'p', ref: big.ref }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' })] })
      await t.db.delete(tasks).where(eq(tasks.id, big.id))
      expect((await approve(plans)).status).toBe(409)
    })

    it('leaves what a human added to a Draft alone through a PM revision', async () => {
      const { project, propose, plans } = await start()
      await propose({ tasks: [item('a')] })
      const [draft] = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
      const sub = await addSub(project.slug, draft!.number, { title: 'Mine' }).then(r => r.json()) as Task
      expect(await propose({ tasks: [item('other', { title: 'Something else' })] })).toMatchObject({ ok: true })
      expect((await t.db.select().from(tasks).where(eq(tasks.id, sub.id)))[0]).toMatchObject({ title: 'Mine', status: 'draft', deletedAt: null })
      expect((await t.db.select().from(tasks).where(eq(tasks.id, draft!.id)))[0]).toMatchObject({ status: 'parent' })
      expect((await approve(plans)).status).toBe(200)
      expect((await list(project.slug)).find(task => task.id === sub.id)).toMatchObject({ parentTask: { id: draft!.id } })
    })

    it('refuses at propose time a promotion that would make a cycle', async () => {
      const { project, propose, plans } = await start()
      const big = await t.createTask(project.slug)
      const result = await propose({ parents: [{ key: 'p', ref: big.ref }], tasks: [item('a', { parent: 'p', dependsOn: [big.ref] }), item('b', { parent: 'p' })] })
      expect(result).toMatchObject({ ok: false })
      expect(await plans()).toEqual([])
    })

    it('refuses a second plan promoting the same task in words', async () => {
      const { project, propose } = await start()
      const big = await t.createTask(project.slug)
      const two = [item('a', { parent: 'p' }), item('b', { parent: 'p' })]
      expect(await propose({ parents: [{ key: 'p', ref: big.ref }], tasks: two })).toMatchObject({ ok: true })
      const other = await turn(project.id)
      expect(await other.propose({ parents: [{ key: 'p', ref: big.ref }], tasks: two })).toMatchObject({ ok: false })
      expect(await other.plans()).toEqual([])
    })

    it('never deletes a commented task because its plan was discarded', async () => {
      const { project, propose, plans } = await start()
      await propose({ parents: [{ key: 'p', title: 'New' }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' })] })
      const [delivery] = await t.db.select().from(epics).where(eq(epics.projectId, project.id))
      await t.db.insert(comments).values({ taskId: delivery!.taskId!, author: t.actor, body: 'Keep me' })
      expect((await t.request('POST', `/api/plan/plans/${(await plans()).at(-1)!.id}/discard`)).status).toBe(200)
      expect((await t.db.select().from(tasks).where(eq(tasks.id, delivery!.taskId!)))[0]).toMatchObject({ status: 'parent' })
      expect(await list(project.slug, 'backlog')).toEqual([expect.objectContaining({ id: delivery!.taskId, rollup: expect.objectContaining({ total: 0 }) })])
    })

    it('keeps a promoted task\'s rich text through a plan repeating it', async () => {
      const rich: { type: 'doc', content: unknown[] } = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }] }] }
      const { project, propose, plans } = await start()
      const big = await t.createTask(project.slug, { title: 'Big', description: rich })
      await propose({ parents: [{ key: 'p', ref: big.ref }], tasks: [item('a', { parent: 'p' }), item('b', { parent: 'p' })] })
      await approve(plans)
      expect((await t.db.select().from(tasks).where(eq(tasks.id, big.id)))[0]!.description).toEqual(rich)
    })
  })

  describe('promotion from every state', () => {
    it('merges a dependency the first subtask already has', async () => {
      const project = await newProject()
      const dep = await t.createTask(project.slug)
      const back = await t.createTask(project.slug, { dependsOn: [dep.number] })
      const res = await addSub(project.slug, back.number, { dependsOn: [dep.number] })
      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({ dependsOn: [dep.ref] })
    })

    it('makes a task of a Ready task, and a title is enough: the description comes along', async () => {
      const project = await newProject()
      await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
      const ready = await t.createTask(project.slug, { description: doc })
      await t.request('POST', `/api/projects/${project.slug}/tasks/${ready.number}/transitions`, { type: 'approve' })
      const res = await addSub(project.slug, ready.number)
      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({ status: 'ready', description: doc, parentTask: { ref: ready.ref } })
      expect((await list(project.slug, 'board')).find(task => task.id === ready.id)).toMatchObject({ status: 'parent', rollup: { planned: true } })
    })

    it('keeps a Draft\'s subtasks in its plan, through approval and through discarding', async () => {
      for (const ending of ['approve', 'discard'] as const) {
        const { project, propose, plans } = await start()
        await propose({ tasks: [item('a')] })
        const [draft] = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
        expect(await addSub(project.slug, draft!.number)).toMatchObject({ status: 201 })
        expect(await addSub(project.slug, draft!.number, { title: 'Second' })).toMatchObject({ status: 201 })
        expect((await plans()).at(-1)!.tasks.map(task => task.taskId)).not.toContain(draft!.id)
        expect((await list(project.slug)).some(task => task.id === draft!.id)).toBe(false)
        if (ending === 'approve') {
          expect((await approve(plans)).status).toBe(200)
          const all = await list(project.slug)
          expect(all.filter(task => task.parentTask?.id === draft!.id)).toHaveLength(2)
          expect(all.every(task => task.status !== 'draft')).toBe(true)
        } else {
          expect((await t.request('POST', `/api/plan/plans/${(await plans()).at(-1)!.id}/discard`)).status).toBe(200)
          expect(await list(project.slug)).toEqual([])
        }
      }
    })

    it('moves a pause to the first subtask', async () => {
      const project = await newProject()
      const back = await t.createTask(project.slug)
      await t.db.update(tasks).set({ paused: true }).where(eq(tasks.id, back.id))
      expect(await addSub(project.slug, back.number).then(r => r.json())).toMatchObject({ paused: true })
      expect((await t.db.select().from(tasks).where(eq(tasks.id, back.id)))[0]).toMatchObject({ paused: false })
    })

    it('refuses a subtask on a delivered task', async () => {
      const { project, delivery, parent } = await parentSetup()
      await t.db.update(epics).set({ reviewState: 'merged', branch: 'corral/x', mergedAt: new Date() }).where(eq(epics.id, delivery.id))
      expect((await addSub(project.slug, parent.number)).status).toBe(409)
    })
  })

  describe('delivery', () => {
    it('refuses to delete a task with an unmerged branch, and keeps one with comments', async () => {
      const { project, delivery, parent, a, b } = await parentSetup()
      for (const sub of [a, b]) await t.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, sub.id))
      await t.db.update(epics).set({ branch: 'corral/epic-x' }).where(eq(epics.id, delivery.id))
      const refused = await t.request('DELETE', `/api/projects/${project.slug}/tasks/${parent.number}`)
      expect(refused.status).toBe(409)
      expect(await refused.text()).toContain('corral/epic-x')
      await t.db.update(epics).set({ branch: null }).where(eq(epics.id, delivery.id))
      await t.db.insert(comments).values({ taskId: parent.id, author: t.actor, body: 'Keep me' })
      expect((await t.request('DELETE', `/api/projects/${project.slug}/tasks/${parent.number}`)).status).toBeLessThan(300)
      expect((await t.db.select().from(tasks).where(eq(tasks.id, parent.id)))[0]!.deletedAt).toBeInstanceOf(Date)
      expect(await t.db.select().from(comments).where(eq(comments.taskId, parent.id))).toHaveLength(1)
    })

    it('gives a subtask\'s run its task\'s pinned comments', async () => {
      const { project, parent, a } = await parentSetup()
      await t.db.insert(comments).values([{ taskId: parent.id, author: t.actor, body: 'Pinned on the task', pinned: true }, { taskId: parent.id, author: t.actor, body: 'Not pinned' }])
      await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
      await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, a.id))
      await t.orchestrator.scheduler.schedule()
      const { job } = await runner.next('run.assign', m => m.job.taskId === a.id)
      expect(job.prompt).toContain('Pinned on the task')
      expect(job.prompt).not.toContain('Not pinned')
    })

    it('holds a dependent of a direct task while a subtask is in Backlog', async () => {
      const { project, parent, a } = await parentSetup('direct')
      await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, a.id))
      const waiting = await t.createTask(project.slug)
      await t.db.insert(taskDependencies).values({ projectId: project.id, taskId: waiting.id, dependsOnId: parent.id })
      await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, waiting.id))
      await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
      const [developer] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
      expect(await claimNextTask(t.db, developer!.id, new Date(), [waiting.id])).toBeNull()
    })

    it('records when a direct task\'s last subtask lands', async () => {
      const { delivery, a, b } = await parentSetup('direct')
      await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, a.id))
      await publishDependents(t.db, t.bus, a.id)
      expect((await t.db.select().from(epics).where(eq(epics.id, delivery.id)))[0]!.mergedAt).toBeNull()
      await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, b.id))
      await publishDependents(t.db, t.bus, b.id)
      expect((await t.db.select().from(epics).where(eq(epics.id, delivery.id)))[0]!.mergedAt).toBeInstanceOf(Date)
    })

    it('deletes an empty task whose deleted subtask submitted commits, and shows it until then', async () => {
      const { project, delivery, parent, a, b } = await parentSetup()
      await t.db.update(tasks).set({ integrationProtocol: 1, deletedAt: new Date() }).where(eq(tasks.id, a.id))
      await t.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, b.id))
      expect((await list(project.slug, 'board')).map(task => task.id)).toContain(parent.id)
      expect((await list(project.slug, 'backlog')).map(task => task.id)).toContain(parent.id)
      expect((await t.request('DELETE', `/api/projects/${project.slug}/tasks/${parent.number}`)).status).toBeLessThan(300)
      expect(await t.db.select().from(tasks).where(eq(tasks.id, parent.id))).toEqual([])
      expect(await t.db.select().from(epics).where(eq(epics.id, delivery.id))).toHaveLength(1)
    })
  })
})
