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

    await migrate(db, { migrationsFolder })

    const tasks = await db.execute(sql`select number, type::text as type from tasks order by number`)
    expect(tasks.rows).toEqual(oldTypes.map((_, i) => ({ number: i + 1, type: 'task' })))
    const revision = await db.execute(sql`select revision->>'type' as type from plan_tasks`)
    expect(revision.rows).toEqual([{ type: 'task' }])
    const values = await db.execute(sql`select unnest(enum_range(null::task_type))::text as value`)
    expect(values.rows.map(r => r.value)).toEqual(['task', 'bug', 'spike'])
    // Two full migration runs on PGlite
  }, 60_000)
})
