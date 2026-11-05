import type { PlanSessionDetail, Task } from '@corral/contracts'
import { markdownToRichText, richTextToMarkdown } from '@corral/core'
import { schema } from '@corral/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

// A task's implementation plan travels through propose_plan beside its
// description, and a plan revision that changes only the plan is a change
describe('implementation plans in proposed plans', { timeout: 30_000 }, () => {
  let t: TestApp
  let runner: FakeRunner
  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
  })
  afterEach(async () => {
    await t.orchestrator.schedule()
    await t.db.delete(schema.projects)
  })
  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  it('stores the plan apart from the description, and applies a plan-only revision on approval', async () => {
    const project = await t.createProject({ repository: 'cormacrw/test-app', defaultBranch: 'main' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const existing = await t.createTask(project.slug, { title: 'Add login', description: markdownToRichText('Let people sign in.') })
    const session = await (await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan login' })).json() as PlanSessionDetail
    const { job } = await runner.next('run.assign', m => m.job.planSessionId === session.id)
    const propose = (existingPlan: string) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', {
      title: 'Login',
      tasks: [
        { key: 'form', title: 'Login form', description: 'A form to sign in.', implementationPlan: 'Add `LoginForm.vue`.', type: 'task', acceptanceCriteria: ['It works'] },
        { key: 'login', ref: existing.ref, title: 'Add login', description: 'Let people sign in.', implementationPlan: existingPlan, type: 'task', acceptanceCriteria: ['It works'] }
      ]
    })
    const detail = async () => (await t.request('GET', `/api/plan/sessions/${session.id}`)).json() as Promise<PlanSessionDetail>
    const getTask = async (ref: string) => (await runner.call(job.runId, job.leaseEpoch, 'get_task', { taskRef: ref }) as { result: { description: string, implementationPlan: string } }).result

    expect(await propose('Edit `src/login.ts`.')).toMatchObject({ ok: true })
    const v1 = (await detail()).plans.at(-1)!
    expect(v1.tasks).toMatchObject([
      { key: 'form', description: 'A form to sign in.', implementationPlan: 'Add `LoginForm.vue`.' },
      { key: 'login', revises: true, description: 'Let people sign in.', implementationPlan: 'Edit `src/login.ts`.' }
    ])
    // The new Draft holds both; the revised task waits for approval
    expect(await getTask(v1.tasks[0]!.ref!)).toMatchObject({ description: 'A form to sign in.', implementationPlan: 'Add `LoginForm.vue`.' })
    expect(await getTask(existing.ref)).toMatchObject({ description: 'Let people sign in.', implementationPlan: '' })

    expect(await propose('Edit `src/auth.ts` instead.')).toMatchObject({ ok: true })
    const v2 = (await detail()).plans.at(-1)!
    expect(v2.version).toBe(2)
    expect(v2.tasks.map(task => [task.key, task.change])).toEqual([['form', 'unchanged'], ['login', 'changed']])

    expect((await t.request('POST', `/api/plan/plans/${v2.id}/approve`, { to: 'backlog' })).status).toBe(200)
    expect(await getTask(existing.ref)).toMatchObject({ description: 'Let people sign in.', implementationPlan: 'Edit `src/auth.ts` instead.' })
    const task = await (await t.request('GET', `/api/projects/${project.slug}/tasks/${existing.number}`)).json() as Task
    expect(richTextToMarkdown(task.implementationPlan)).toBe('Edit `src/auth.ts` instead.')
    const history = await (await t.request('GET', `/api/projects/${project.slug}/tasks/${existing.number}/history`)).json() as { action: string, detail: { fields?: string[] } }[]
    expect(history.find(e => e.action === 'task.revised')?.detail.fields).toContain('implementationPlan')
  })
})
