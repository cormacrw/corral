import type { Project, PullRequestGuide, SetupJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findProjectBySlug } from './projects.ts'
import { PullRequestGuides, guidePrompt, parseGuide, type GuideInput } from './pull-request-guides.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { tasks } = schema

const files = [
  { path: 'src/a.ts', status: 'modified' as const, additions: 2, deletions: 0, patch: '@@ -1,1 +1,2 @@\n+one\n@@ -9,1 +10,2 @@\n+two' },
  { path: 'src/b.ts', status: 'added' as const, additions: 1, deletions: 0, patch: '@@ -0,0 +1,1 @@\n+three' }
]

describe('PR guides', () => {
  let t: TestApp
  let project: Project
  let number: number
  let criterionId: string

  beforeAll(async () => {
    t = await createTestApp('pglite')
    project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const task = await t.createTask(project.slug, { title: 'Guide me', acceptanceCriteria: ['It reads well'] })
    criterionId = task.acceptanceCriteria[0]!.id
    t.github.setBranch(project.repository, 'corral/guide', 'sha-1')
    const pr = await t.github.openPullRequest(project.repository, { head: 'corral/guide', base: 'main', title: 'Guide me', body: '' })
    t.github.pullFiles.set(pr.number, files)
    number = pr.number
    await t.db.update(tasks).set({ status: 'human_review', branch: 'corral/guide', prNumber: pr.number, prUrl: pr.url, headSha: 'sha-1' }).where(eq(tasks.id, task.id))
  })

  afterAll(async () => {
    await t?.close()
  })

  const guides = (answer: (job: SetupJob) => Promise<{ kind: 'pr_guide', text: string }>) => {
    const jobs: SetupJob[] = []
    const service = new PullRequestGuides({ db: t.db, github: t.github, runner: { request: ((job: SetupJob) => {
      jobs.push(job)
      return answer(job)
    }) as never } })
    return { service, jobs }
  }

  it('has none until asked, then fails plainly with no runner online', async () => {
    const res = await t.request('GET', `/api/projects/${project.slug}/pull-requests/${number}/guide`)
    expect(await res.json()).toEqual({ status: 'none', headSha: null, steps: [], error: null, generatedAt: null })

    const started = await t.request('POST', `/api/projects/${project.slug}/pull-requests/${number}/guide`)
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ status: 'generating', headSha: 'sha-1' })
    const guide = () => t.request('GET', `/api/projects/${project.slug}/pull-requests/${number}/guide`).then(r => r.json() as Promise<PullRequestGuide>)
    await expect.poll(async () => (await guide()).status).not.toBe('generating')
    expect(await guide()).toMatchObject({ status: 'failed', error: expect.stringContaining('runner'), steps: [] })
  })

  it('sends the task and numbered hunks, keeps only refs that exist, and starts one generation at a time', async () => {
    let finish!: (text: string) => void
    const { service, jobs } = guides(() => new Promise((resolve) => {
      finish = text => resolve({ kind: 'pr_guide', text })
    }))
    const row = await findProjectBySlug(t.db, project.slug)
    expect((await service.generate(row, number)).status).toBe('generating')
    expect((await service.generate(row, number)).status).toBe('generating')
    await expect.poll(() => jobs.length).toBe(1)
    const prompt = (jobs[0] as { prompt: string }).prompt
    expect(prompt).toContain(criterionId)
    expect(prompt).toContain('It reads well')
    // Hunks are numbered per file as the answer cites them
    expect(prompt).toMatch(/src\/a\.ts\W+hunk 1\s+@@ -9,1 \+10,2 @@/)

    finish('```json\n' + JSON.stringify({ steps: [
      { title: 'Core', why: 'Start here.', criterionIds: [criterionId, 'not-a-criterion'], hunks: [{ path: 'src/a.ts', hunk: 1 }, { path: 'src/a.ts', hunk: 7 }, { path: 'nope.ts', hunk: 0 }] },
      { title: 'Repeat', why: 'Dupes only.', criterionIds: [], hunks: [{ path: 'src/a.ts', hunk: 1 }] },
      { title: 'Rest', why: 'Then this.', criterionIds: [], hunks: [{ path: 'src/b.ts', hunk: 0 }] }
    ] }) + '\n```')
    await service.idle()
    // The second ask joined the first
    expect(jobs).toHaveLength(1)
    const guide = await service.get(row, number)
    expect(guide.status).toBe('ready')
    expect(guide.headSha).toBe('sha-1')
    expect(guide.steps.map(s => ({ title: s.title, criterionIds: s.criterionIds, hunks: s.hunks }))).toEqual([
      { title: 'Core', criterionIds: [criterionId], hunks: [{ path: 'src/a.ts', hunk: 1 }] },
      { title: 'Rest', criterionIds: [], hunks: [{ path: 'src/b.ts', hunk: 0 }] }
    ])
  })

  it('saves an answer it can\'t parse as failed, and a later ask starts over for the new head', async () => {
    const row = await findProjectBySlug(t.db, project.slug)
    const failing = guides(async () => ({ kind: 'pr_guide', text: 'Sorry, I can\'t help with that.' }))
    await failing.service.generate(row, number)
    await failing.service.idle()
    expect(await failing.service.get(row, number)).toMatchObject({ status: 'failed', error: expect.any(String), steps: [] })

    t.github.pulls.get(number)!.headSha = 'sha-2'
    const ok = guides(async () => ({ kind: 'pr_guide', text: JSON.stringify({ steps: [{ title: 'All', why: 'Everything.', criterionIds: [], hunks: [{ path: 'src/b.ts', hunk: 0 }] }] }) }))
    await ok.service.generate(row, number)
    await ok.service.idle()
    expect(await ok.service.get(row, number)).toMatchObject({ status: 'ready', headSha: 'sha-2', error: null })
  })
})

describe('parseGuide', () => {
  const input: GuideInput = { task: null, pr: { title: 'x', body: '' }, files }

  it('refuses an answer with no step that cites a real hunk', () => {
    expect(() => parseGuide(JSON.stringify({ steps: [{ title: 'x', why: 'y', hunks: [{ path: 'gone.ts', hunk: 0 }] }] }), input)).toThrow()
    expect(() => parseGuide('{"nope":1}', input)).toThrow()
  })

  it('names a file past the patch budget without its hunks', () => {
    const big = { path: 'big.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: `@@ -1 +1 @@\n+${'x'.repeat(90_000)}` }
    const prompt = guidePrompt({ ...input, files: [big, ...files] })
    expect(prompt).toContain('big.ts')
    expect(prompt).not.toContain('x'.repeat(1000))
    expect(prompt).toMatch(/src\/b\.ts\W+hunk 0/)
  })
})
