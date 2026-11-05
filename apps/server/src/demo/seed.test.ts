import type { Inbox } from '@corral/contracts'
import { schema } from '@corral/db'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DemoGitHub } from './demo-github.ts'
import { Seeder } from './harness.ts'
import { seedDemo } from './scenarios.ts'

// The demo is told through the real flows, so a change to one can break it.
// This runs the whole story and checks the states the demo promises.
it('seeds every board state, the Inbox items and a GitHub that reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'corral-demo-test-'))
  const seeder = await Seeder.open(dir, 'http://corral.test')
  try {
    await seedDemo(seeder)
    const statuses = (await seeder.db.select({ status: schema.tasks.status }).from(schema.tasks)).map(r => r.status)
    for (const status of ['backlog', 'ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'merged', 'blocked', 'failed', 'parent', 'draft'] as const) {
      expect(statuses, status).toContain(status)
    }
    const inbox = await seeder.request<Inbox>('GET', '/api/inbox')
    expect(inbox.needsYou.map(i => i.type).sort()).toEqual(['epic_review', 'human_review', 'human_review', 'human_review', 'human_review', 'human_review', 'human_review', 'human_review', 'human_review', 'plan_thread', 'plan_thread', 'plan_thread', 'plan_thread'])
    expect(inbox.activity.some(i => i.type === 'release_notes')).toBe(true)
    const [design] = await seeder.db.select().from(schema.designVersions).orderBy(schema.designVersions.version).limit(2).offset(1)
    expect(design).toMatchObject({ version: 2, status: 'submitted' })

    const file = join(dir, 'demo-github.json')
    seeder.github.save(file)
    const reloaded = DemoGitHub.load(file)
    expect(reloaded.pulls.size).toBe(seeder.github.pulls.size)
    expect(reloaded.nextNumber).toBe(seeder.github.nextNumber)
  } finally {
    await seeder.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 120_000)
