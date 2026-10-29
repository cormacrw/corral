import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const migrationsFolder = join(import.meta.dirname, '..', 'migrations')

interface Journal { entries: { idx: number, tag: string }[] }

// A copy of the migrations folder that stops before `tag`, so a test can
// put rows in the old shape before the migration under test runs
async function migrationsBefore(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'corral-migrations-'))
  await cp(migrationsFolder, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal
  const stop = journal.entries.findIndex(e => e.tag === tag)
  expect(stop, `migration ${tag} exists`).toBeGreaterThan(0)
  journal.entries = journal.entries.slice(0, stop)
  await writeFile(journalPath, JSON.stringify(journal))
  return dir
}

describe('migrations', () => {
  const cleanup: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn()
  })

  it('0015 turns every task of the four old types into a task (D19)', async () => {
    const before = await migrationsBefore('0015_task_bug_spike')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const client = new PGlite()
    cleanup.push(() => client.close())
    const db = drizzle(client, { casing: 'snake_case' })
    await migrate(db, { migrationsFolder: before })

    const actor = sql`'{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb`
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('P', 'p', 'PA', 'o/r', 'main')`)
    const oldTypes = ['frontend', 'backend', 'full_stack', 'infrastructure']
    for (const [i, type] of oldTypes.entries()) {
      await db.execute(sql`insert into tasks (project_id, number, title, type, created_by)
        select id, ${i + 1}, ${`Task ${i + 1}`}, ${type}::task_type, ${actor} from projects`)
    }
    // A revision staged on a plan carries a type too
    await db.execute(sql`insert into plan_sessions (project_id, title, created_by) select id, 'S', ${actor} from projects`)
    await db.execute(sql`insert into plans (session_id, project_id, version, title) select s.id, s.project_id, 1, 'Plan' from plan_sessions s`)
    await db.execute(sql`insert into plan_tasks (plan_id, task_id, key, change, position, revision)
      select p.id, t.id, 't1', 'changed', 0, '{"title":"T","description":"","type":"frontend","priority":"medium","humanReview":false,"acceptanceCriteria":[],"epicId":null,"dependsOn":[]}'::jsonb
      from plans p, tasks t where t.number = 1`)

    // Up to 0015 only, so later changes to the enum don't show
    const through = await migrationsBefore('0016_design_tasks')
    cleanup.push(() => rm(through, { recursive: true, force: true }))
    await migrate(db, { migrationsFolder: through })

    const tasks = await db.execute(sql`select number, type::text as type from tasks order by number`)
    expect(tasks.rows).toEqual(oldTypes.map((_, i) => ({ number: i + 1, type: 'task' })))
    const revision = await db.execute(sql`select revision->>'type' as type from plan_tasks`)
    expect(revision.rows).toEqual([{ type: 'task' }])
    const values = await db.execute(sql`select unnest(enum_range(null::task_type))::text as value`)
    expect(values.rows.map(r => r.value)).toEqual(['task', 'bug', 'spike'])
    // Two full migration runs on PGlite
  }, 60_000)
  it('0016 adds the design type and design versions to a database with tasks (D20)', async () => {
    const before = await migrationsBefore('0016_design_tasks')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const client = new PGlite()
    cleanup.push(() => client.close())
    const db = drizzle(client, { casing: 'snake_case' })
    await migrate(db, { migrationsFolder: before })

    const actor = sql`'{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb`
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('P', 'p', 'PA', 'o/r', 'main')`)
    for (const [i, type] of ['task', 'bug', 'spike'].entries()) {
      await db.execute(sql`insert into tasks (project_id, number, title, type, human_review, created_by)
        select id, ${i + 1}, ${`Task ${i + 1}`}, ${type}::task_type, ${i === 1}, ${actor} from projects`)
    }

    await migrate(db, { migrationsFolder })

    // Existing tasks are untouched
    const existing = await db.execute(sql`select number, type::text as type, human_review from tasks order by number`)
    expect(existing.rows).toEqual([
      { number: 1, type: 'task', human_review: false },
      { number: 2, type: 'bug', human_review: true },
      { number: 3, type: 'spike', human_review: false }
    ])
    const values = await db.execute(sql`select unnest(enum_range(null::task_type))::text as value`)
    expect(values.rows.map(r => r.value)).toEqual(['task', 'bug', 'spike', 'design'])

    // A design task with versions numbered per task
    await db.execute(sql`insert into tasks (project_id, number, title, type, human_review, created_by)
      select id, 4, 'Login design', 'design', true, ${actor} from projects`)
    const version = (n: number) => sql`insert into design_versions (task_id, version, bundle_blob, spec_blob, screenshots, branch, commit_sha)
      select id, ${n}, 'bundle', 'spec', '[{"blob":"shot","fileName":"login.png","contentType":"image/png"}]'::jsonb, 'design/PA-4', 'abc123' from tasks where number = 4`
    await db.execute(version(1))
    await db.execute(version(2))
    const versions = await db.execute(sql`select version, status::text as status, feedback from design_versions order by version`)
    expect(versions.rows).toEqual([{ version: 1, status: 'submitted', feedback: null }, { version: 2, status: 'submitted', feedback: null }])
    await expect(db.execute(version(2))).rejects.toThrow()
    await expect(db.execute(sql`update design_versions set version = 0 where version = 1`)).rejects.toThrow()
    // Versions go with their task
    await db.execute(sql`delete from tasks where number = 4`)
    expect((await db.execute(sql`select * from design_versions`)).rows).toEqual([])
  }, 60_000)

  it('0023 adds closed_at to plan sessions, leaving existing sessions open', async () => {
    const before = await migrationsBefore('0023_third_mandrill')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const client = new PGlite()
    cleanup.push(() => client.close())
    const db = drizzle(client, { casing: 'snake_case' })
    await migrate(db, { migrationsFolder: before })

    const actor = sql`'{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb`
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('P', 'p', 'PA', 'o/r', 'main')`)
    await db.execute(sql`insert into plan_sessions (project_id, title, unread, created_by) select id, 'S', true, ${actor} from projects`)

    await migrate(db, { migrationsFolder })

    const sessions = await db.execute(sql`select title, unread, closed_at from plan_sessions`)
    expect(sessions.rows).toEqual([{ title: 'S', unread: true, closed_at: null }])
  }, 60_000)
})
