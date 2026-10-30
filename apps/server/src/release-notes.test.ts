import type { Deployment, PlanSessionDetail, ServerEvent, Task } from '@corral/contracts'
import { markdownToRichText } from '@corral/core'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fallbackNotes, withEveryChange } from './deployments.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, deployments, tasks } = schema
const sha = (c: string) => c.repeat(40)

// COR-128: each deployment's notes come from a `release_notes` setup job
describe('release notes', () => {
  let t: TestApp
  let runner: FakeRunner
  let project: Awaited<ReturnType<TestApp['createProject']>>

  const notesJob = (r = runner) => r.next('job.request', m => m.job.kind === 'release_notes')
  const answer = (id: string, notes: string, r = runner) => r.send({ type: 'job.result', jobId: id, ok: true, result: { kind: 'release_notes', notes } })
  const row = async (id: string) => (await t.db.select().from(deployments).where(eq(deployments.id, id)))[0]!
  const updates = (id: string) => t.events.filter((e): e is Extract<ServerEvent, { type: 'deployment.updated' }> => e.type === 'deployment.updated' && e.deployment.id === id)
  const prompt = (job: Awaited<ReturnType<typeof notesJob>>) => job.job.kind === 'release_notes' ? job.job.prompt : ''

  async function merged(input: { title: string, type?: 'task' | 'bug' }, merge: string): Promise<Task> {
    const task = await t.createTask(project.slug, { title: input.title, type: input.type ?? 'task', description: markdownToRichText(`About ${input.title}`) })
    await t.db.update(tasks).set({ mergeCommitSha: merge }).where(eq(tasks.id, task.id))
    return task
  }

  async function deploy(toSha: string, commits: { sha: string, subject: string }[]): Promise<Deployment> {
    const res = await t.request('POST', '/api/deployments', { repository: project.repository, fromSha: null, toSha, commits })
    expect(res.status).toBe(201)
    return await res.json() as Deployment
  }

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 1 }).where(eq(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  beforeEach(async () => {
    project = await t.createProject()
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  it('stores notes that cite the matched tasks and keep the untracked commits, and publishes them', async () => {
    const one = await merged({ title: 'Dark mode' }, sha('1'))
    const two = await merged({ title: 'Login loop', type: 'bug' }, sha('2'))
    const deployment = await deploy(sha('3'), [{ sha: sha('3'), subject: 'Bump dependencies' }, { sha: sha('2'), subject: 'Fix login (#2)' }, { sha: sha('1'), subject: 'Dark mode (#1)' }])
    expect(deployment.notesStatus).toBe('pending')

    const job = await notesJob()
    expect(job.job).toMatchObject({ kind: 'release_notes', runtime: 'claude-code' })
    expect(prompt(job)).toContain(`${one.ref} (task): Dark mode`)
    expect(prompt(job)).toContain('About Dark mode')
    expect(prompt(job)).toContain(`${two.ref} (bug): Login loop`)
    expect(prompt(job)).toContain('Commits with no task:\n- Bump dependencies')
    expect(prompt(job)).not.toContain('Fix login (#2)')

    const notes = `## Features\n\n- Dark mode (${one.ref})\n\n## Fixes\n\n- Login no longer loops (${two.ref})\n\n## Other changes\n\n- Bump dependencies`
    answer(job.jobId, notes)
    await expect.poll(async () => (await row(deployment.id)).notesStatus).toBe('ready')
    expect((await row(deployment.id)).notes).toBe(notes)
    expect(updates(deployment.id)).toMatchObject([
      { deployment: { id: deployment.id, notes: null, notesStatus: 'pending' } },
      { deployment: { id: deployment.id, notes, notesStatus: 'ready' } }
    ])
  })

  it('adds whatever the model left out', async () => {
    const task = await merged({ title: 'Export' }, sha('4'))
    const deployment = await deploy(sha('5'), [{ sha: sha('5'), subject: 'Tidy logs' }, { sha: sha('4'), subject: 'Export (#4)' }])
    answer((await notesJob()).jobId, '## Other changes\n\n- Small improvements')
    await expect.poll(async () => (await row(deployment.id)).notesStatus).toBe('ready')
    expect((await row(deployment.id)).notes).toBe(`## Other changes\n\n- Small improvements\n\n## Also in this deployment\n\n- Export (${task.ref})\n- Tidy logs`)
  })

  it('ignores another project\'s task with the same merge commit', async () => {
    await merged({ title: 'Elsewhere' }, sha('6'))
    project = await t.createProject()
    const deployment = await deploy(sha('6'), [{ sha: sha('6'), subject: 'Shipped here' }])
    const job = await notesJob()
    expect(prompt(job)).not.toContain('Elsewhere')
    expect(prompt(job)).toContain('- Shipped here')
    answer(job.jobId, '- Shipped here')
    await expect.poll(async () => (await row(deployment.id)).notesStatus).toBe('ready')
  })

  it('stores the plain list and failed when the job fails', async () => {
    const task = await merged({ title: 'Search', type: 'bug' }, sha('7'))
    const deployment = await deploy(sha('8'), [{ sha: sha('8'), subject: 'Update readme' }, { sha: sha('7'), subject: 'Search (#7)' }])
    runner.send({ type: 'job.result', jobId: (await notesJob()).jobId, ok: false, error: 'claude exited with code 1' })
    await expect.poll(async () => (await row(deployment.id)).notesStatus).toBe('failed')
    expect((await row(deployment.id)).notes).toBe(`## Bugs\n\n- ${task.ref} Search\n\n## Other commits\n\n- Update readme`)
    expect(updates(deployment.id)).toMatchObject([
      { deployment: { notesStatus: 'pending' } },
      { deployment: { notesStatus: 'failed' } }
    ])
  })

  it('uses the PM agent\'s runtime, on a runner that has it', async () => {
    await t.db.update(agents).set({ runtime: 'codex' }).where(eq(agents.role, 'pm'))
    const codex = await FakeRunner.connect(t.server!.url, [], 'codex-runner', { runtimes: ['codex'] })
    runner.close()
    await expect.poll(() => t.runner.status().runners.find(r => r.id === 'r1')?.online).toBe(false)
    const deployment = await deploy(sha('9'), [{ sha: sha('9'), subject: 'Change' }])
    const job = await notesJob(codex)
    expect(job.job).toMatchObject({ runtime: 'codex' })
    answer(job.jobId, '- Change', codex)
    await expect.poll(async () => (await row(deployment.id)).notesStatus).toBe('ready')
    codex.close()
    await expect.poll(() => t.runner.online).toBe(false)
    await t.db.update(agents).set({ runtime: 'claude-code' }).where(eq(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  it('waits for the runner when it is offline, and when it drops mid-job', async () => {
    runner.close()
    await expect.poll(() => t.runner.online).toBe(false)
    const deployment = await deploy(sha('a'), [{ sha: sha('a'), subject: 'While offline' }])
    await sleep(50)
    expect(await row(deployment.id)).toMatchObject({ notes: null, notesStatus: 'pending' })

    runner = await FakeRunner.connect(t.server!.url)
    await notesJob()
    runner.close()
    await expect.poll(() => t.runner.online).toBe(false)
    expect(await row(deployment.id)).toMatchObject({ notes: null, notesStatus: 'pending' })

    runner = await FakeRunner.connect(t.server!.url)
    answer((await notesJob()).jobId, '- While offline')
    await expect.poll(async () => (await row(deployment.id)).notesStatus).toBe('ready')
  })

  it('picks up deployments left pending by a restart, oldest first', async () => {
    runner.close()
    await expect.poll(() => t.runner.online).toBe(false)
    await t.db.insert(deployments).values([
      { projectId: project.id, toSha: sha('b'), commits: [{ sha: sha('b'), subject: 'Older' }], createdAt: new Date(Date.now() - 1000) },
      { projectId: project.id, toSha: sha('c'), commits: [{ sha: sha('c'), subject: 'Newer' }] }
    ])
    runner = await FakeRunner.connect(t.server!.url)
    const first = await notesJob()
    expect(prompt(first)).toContain('Older')
    answer(first.jobId, '- Older')
    const second = await notesJob()
    expect(prompt(second)).toContain('Newer')
    answer(second.jobId, '- Newer')
    await expect.poll(async () => (await t.db.select().from(deployments).where(eq(deployments.projectId, project.id))).map(d => d.notesStatus)).toEqual(['ready', 'ready'])
  })

  it('takes no PM slot: a Plan turn starts while the job is unanswered', async () => {
    const deployment = await deploy(sha('d'), [{ sha: sha('d'), subject: 'Busy' }])
    const job = await notesJob()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan something' }).then(r => r.json()) as PlanSessionDetail
    expect((await runner.next('run.assign', m => m.job.planSessionId === created.id)).job.role).toBe('pm')
    expect((await row(deployment.id)).notesStatus).toBe('pending')
    answer(job.jobId, '- Busy')
    await expect.poll(async () => (await row(deployment.id)).notesStatus).toBe('ready')
  })

  it('needs no job for a deployment with no commits', async () => {
    const deployment = await deploy(sha('e'), [])
    await expect.poll(async () => (await row(deployment.id)).notesStatus).toBe('ready')
    expect((await row(deployment.id)).notes).toBe('No changes were listed for this deployment.')
  })
})

describe('release notes text', () => {
  const changes = {
    tasks: [
      { ref: 'COR-101', type: 'task' as const, title: 'Dark mode', description: '' },
      { ref: 'COR-102', type: 'bug' as const, title: 'Login loop', description: '' }
    ],
    commits: ['Bump dependencies']
  }

  it('groups the fallback by type, then the commits', () => {
    expect(fallbackNotes(changes)).toBe('## Tasks\n\n- COR-101 Dark mode\n\n## Bugs\n\n- COR-102 Login loop\n\n## Other commits\n\n- Bump dependencies')
  })

  it('doesn\'t take COR-1010 for COR-101', () => {
    expect(withEveryChange('- Thing (COR-1010)\n- COR-102\n- Bump dependencies', changes)).toContain('- Dark mode (COR-101)')
  })
})
