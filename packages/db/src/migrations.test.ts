import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { requireDatabase } from './testing.ts'

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

  it.for([
    { driver: 'pglite' as const },
    { driver: 'postgres' as const }
  ])('0035 adds designer without changing existing agents or runs on $driver', { timeout: 60_000 }, async ({ driver }, context) => {
    requireDatabase(driver, context)
    const before = await migrationsBefore('0035_amused_bloodaxe')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const { db, migrate } = await open(driver)
    await migrate(before)
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('Test app', 'test-app', 'TA', 'cormacrw/test-app', 'main')`)
    await db.execute(sql`insert into agents (name, role) values ('Juno', 'pm'), ('Atlas', 'developer'), ('Vera', 'reviewer')`)
    await db.execute(sql`insert into tasks (project_id, number, title, type, created_by) select id, 1, 'Existing task', 'task', '{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb from projects`)
    await db.execute(sql`insert into runs (project_id, agent_id, task_id, role, state, ended_at) select p.id, a.id, t.id, a.role, 'completed', now() from projects p, agents a, tasks t where a.role <> 'pm'`)
    const agents = (await db.execute(sql`select * from agents order by name`)).rows
    const runs = (await db.execute(sql`select * from runs order by id`)).rows
    await migrate(migrationsFolder)
    expect((await db.execute(sql`select * from agents order by name`)).rows).toEqual(agents)
    expect((await db.execute(sql`select * from runs order by id`)).rows).toEqual(runs.map(run => ({ ...run, timings: null, review: null, conflicted_files: null })))
    await db.execute(sql`insert into agents (name, role) values ('Iris', 'designer')`)
    expect((await db.execute(sql`select role from agents where name = 'Iris'`)).rows).toEqual([{ role: 'designer' }])
  })

  it.for([
    { driver: 'pglite' as const },
    { driver: 'postgres' as const }
  ])('upgrades historical runs and tasks after 0030 without data loss, on $driver', { timeout: 60_000 }, async ({ driver }, context) => {
    requireDatabase(driver, context)
    const before = await migrationsBefore('0031_omniscient_firedrake')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const { db, migrate } = await open(driver)
    await migrate(before)
    const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string, when: number }[] }
    const main = journal.entries.find(e => e.tag === '0030_lumpy_wiccan')!
    const added = journal.entries.find(e => e.tag === '0031_omniscient_firedrake')!
    expect(added.when).toBeGreaterThan(main.when)
    expect(Number((await db.execute(sql`select max(created_at) as latest from drizzle.__drizzle_migrations`)).rows[0]!.latest)).toBe(main.when)
    expect((await db.execute(sql`select column_name from information_schema.columns where table_name = 'runs' and column_name = 'runner_name'`)).rows).toEqual([])
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('Test app', 'test-app', 'TA', 'cormacrw/test-app', 'main')`)
    await db.execute(sql`insert into agents (name, role) values ('Developer', 'developer')`)
    await db.execute(sql`insert into tasks (project_id, number, title, type, created_by) select id, 1, 'Historical task', 'task', '{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb from projects`)
    await db.execute(sql`insert into runs (project_id, agent_id, task_id, role, state, ended_at)
      select p.id, a.id, t.id, 'developer', 'completed', now() from projects p, agents a, tasks t`)

    await migrate(migrationsFolder)
    expect((await db.execute(sql`select data_type, is_nullable from information_schema.columns where table_name = 'runs' and column_name = 'runner_name'`)).rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }])
    expect((await db.execute(sql`select state, runner_name from runs`)).rows).toEqual([{ state: 'completed', runner_name: null }])
    await db.execute(sql`update runs set runner_name = 'home-server'`)
    expect((await db.execute(sql`select runner_name from runs`)).rows).toEqual([{ runner_name: 'home-server' }])
    expect((await db.execute(sql`select rebase_only, approved_head_sha from tasks`)).rows).toEqual([{ rebase_only: false, approved_head_sha: null }])
    await db.execute(sql`update tasks set rebase_only = true, approved_head_sha = 'approved-head'`)
    await db.execute(sql`update runs set outcome = 'pr_rebased'`)
    expect((await db.execute(sql`select outcome from runs`)).rows).toEqual([{ outcome: 'pr_rebased' }])
    expect((await db.execute(sql`select rebase_only, approved_head_sha from tasks`)).rows).toEqual([{ rebase_only: true, approved_head_sha: 'approved-head' }])
    expect(Number((await db.execute(sql`select max(created_at) as latest from drizzle.__drizzle_migrations`)).rows[0]!.latest)).toBe(journal.entries.at(-1)!.when)
    await migrate(migrationsFolder)
    expect((await db.execute(sql`select runner_name from runs`)).rows).toEqual([{ runner_name: 'home-server' }])
  })

  it.for([
    { driver: 'pglite' as const },
    { driver: 'postgres' as const }
  ])('0034 adds dismissal without changing historical deployment notes or read state on $driver', { timeout: 60_000 }, async ({ driver }, context) => {
    requireDatabase(driver, context)
    const before = await migrationsBefore('0034_typical_prowler')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const { db, migrate } = await open(driver)
    await migrate(before)
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('Test app', 'test-app', 'TA', 'cormacrw/test-app', 'main')`)
    await db.execute(sql`insert into deployments (project_id, to_sha, notes, notes_status, read_at)
      select id, 'abc1234', 'Existing release notes', 'ready', '2026-10-01T12:00:00Z' from projects`)
    await migrate(migrationsFolder)
    expect((await db.execute(sql`select notes, notes_status, read_at is not null as read, dismissed_at from deployments`)).rows)
      .toEqual([{ notes: 'Existing release notes', notes_status: 'ready', read: true, dismissed_at: null }])
    await migrate(migrationsFolder)
    expect((await db.execute(sql`select count(*)::int as count from deployments`)).rows).toEqual([{ count: 1 }])
  })

  describe('0036 project-scoped edges', () => {
    const actor = sql`'{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb`
    // Two projects, each with two epics and two tasks, in the old shape
    async function seed(driver: 'pglite' | 'postgres') {
      const before = await migrationsBefore('0036_robust_jackpot')
      cleanup.push(() => rm(before, { recursive: true, force: true }))
      const { db, migrate } = await open(driver)
      await migrate(before)
      for (const prefix of ['AA', 'BB']) {
        await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values (${prefix}, ${prefix}, ${prefix}, ${`o/${prefix}`}, 'main')`)
        for (const n of [1, 2]) {
          await db.execute(sql`insert into epics (project_id, title, created_by) select id, ${`${prefix}${n}`}, ${actor} from projects where prefix = ${prefix}`)
          await db.execute(sql`insert into tasks (project_id, number, title, type, created_by) select id, ${n}, 'T', 'task', ${actor} from projects where prefix = ${prefix}`)
        }
      }
      const task = (prefix: string, n: number) => sql`(select t.id from tasks t join projects p on p.id = t.project_id where p.prefix = ${prefix} and t.number = ${n})`
      const epic = (title: string) => sql`(select id from epics where title = ${title})`
      return { db, migrate, task, epic }
    }

    it.each([
      { driver: 'pglite' as const, enabled: true },
      { driver: 'postgres' as const, enabled: postgresAvailable }
    ])('fills in the project of every same-project row on $driver', async ({ driver, enabled }) => {
      if (!enabled) return
      const { db, migrate, task, epic } = await seed(driver)
      await db.execute(sql`update tasks set epic_id = ${epic('AA1')} where id = ${task('AA', 1)}`)
      await db.execute(sql`insert into task_dependencies (task_id, depends_on_id) values (${task('AA', 1)}, ${task('AA', 2)})`)
      await db.execute(sql`insert into epic_dependencies (epic_id, depends_on_epic_id) values (${epic('BB1')}, ${epic('BB2')})`)

      await migrate(migrationsFolder)

      const prefixes = (table: string) => db.execute(sql`select p.prefix from ${sql.raw(table)} d join projects p on p.id = d.project_id`)
      expect((await prefixes('task_dependencies')).rows).toEqual([{ prefix: 'AA' }])
      expect((await prefixes('epic_dependencies')).rows).toEqual([{ prefix: 'BB' }])
      expect((await db.execute(sql`select count(*)::int as count from tasks where epic_id is not null`)).rows).toEqual([{ count: 1 }])
      await db.execute(sql`delete from epics where title = 'AA1'`)
      expect((await db.execute(sql`select count(*)::int as count from tasks where epic_id is null`)).rows).toEqual([{ count: 4 }])
    }, 60_000)

    it.each([
      { driver: 'pglite' as const, enabled: true },
      { driver: 'postgres' as const, enabled: postgresAvailable }
    ])('reports every cross-project row and stops without changing anything on $driver', async ({ driver, enabled }) => {
      if (!enabled) return
      const { db, migrate, task, epic } = await seed(driver)
      await db.execute(sql`update tasks set epic_id = ${epic('BB1')} where id = ${task('AA', 1)}`)
      await db.execute(sql`insert into task_dependencies (task_id, depends_on_id) values (${task('AA', 2)}, ${task('BB', 2)})`)
      await db.execute(sql`insert into epic_dependencies (epic_id, depends_on_epic_id) values (${epic('AA2')}, ${epic('BB2')})`)
      await db.execute(sql`insert into epic_dependencies (epic_id, depends_on_epic_id) values (${epic('AA1')}, ${epic('AA2')})`)

      const error = await migrate(migrationsFolder).then(() => null, (e: unknown) => e as Error & { cause?: Error })
      const message = error?.cause?.message ?? error?.message
      expect(message).toContain('Cross-project rows must be fixed by hand')
      expect(message).toMatch(/task AA-1 \(.+\) is in epic .+ \(BB1, BB\)/)
      expect(message).toMatch(/task AA-2 \(.+\) depends on task BB-2/)
      expect(message).toMatch(/epic .+ \(AA2, AA\) depends on epic .+ \(BB2, BB\)/)
      expect(message).not.toContain('(AA1, AA) depends on')

      // Nothing was rewritten, and the migration didn't count as applied
      expect((await db.execute(sql`select count(*)::int as count from tasks where epic_id is not null`)).rows).toEqual([{ count: 1 }])
      expect((await db.execute(sql`select count(*)::int as count from task_dependencies`)).rows).toEqual([{ count: 1 }])
      expect((await db.execute(sql`select count(*)::int as count from epic_dependencies`)).rows).toEqual([{ count: 2 }])
      expect((await db.execute(sql`select column_name from information_schema.columns where table_name = 'task_dependencies' and column_name = 'project_id'`)).rows).toEqual([])

      // Once a human has fixed the rows, the same migration goes through
      await db.execute(sql`update tasks set epic_id = null`)
      await db.execute(sql`delete from task_dependencies`)
      await db.execute(sql`delete from epic_dependencies where depends_on_epic_id = ${epic('BB2')}`)
      await migrate(migrationsFolder)
      expect((await db.execute(sql`select count(*)::int as count from epic_dependencies where project_id is not null`)).rows).toEqual([{ count: 1 }])
    }, 60_000)
  })

  it('0028 preserves historical runs with null runner ownership', async () => {
    const before = await migrationsBefore('0028_complex_clint_barton')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const client = new PGlite()
    cleanup.push(() => client.close())
    const db = drizzle(client, { casing: 'snake_case' })
    await migrate(db, { migrationsFolder: before })
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('Test app', 'test-app', 'TA', 'cormacrw/test-app', 'main')`)
    await db.execute(sql`insert into agents (name, role) values ('Developer', 'developer')`)
    await db.execute(sql`insert into tasks (project_id, number, title, type, created_by) select id, 1, 'Historical task', 'task', '{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb from projects`)
    await db.execute(sql`insert into runs (project_id, agent_id, task_id, role, state, ended_at)
      select p.id, a.id, t.id, 'developer', 'completed', now() from projects p, agents a, tasks t`)
    await migrate(db, { migrationsFolder })
    expect((await db.execute(sql`select state, runner_id from runs`)).rows).toEqual([{ state: 'completed', runner_id: null }])
    await db.execute(sql`insert into runs (project_id, agent_id, task_id, role, runner_id)
      select p.id, a.id, t.id, 'developer', 'runner-B' from projects p, agents a, tasks t`)
    expect((await db.execute(sql`select runner_id from runs order by number`)).rows).toEqual([{ runner_id: null }, { runner_id: 'runner-B' }])
  }, 60_000)

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

  // On both drivers: Postgres can't use an enum value in the transaction
  // that adds it, so the check compares the kind as text
  it.for([
    { driver: 'pglite' as const },
    { driver: 'postgres' as const }
  ])('0024 makes evidence files optional for notes, keeping existing evidence, on $driver (D21)', { timeout: 60_000 }, async ({ driver }, context) => {
    requireDatabase(driver, context)
    const before = await migrationsBefore('0024_evidence_note')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const { db, migrate } = await open(driver)

    await migrate(before)
    const actor = sql`'{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb`
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('P', 'p', 'PA', 'o/r', 'main')`)
    await db.execute(sql`insert into tasks (project_id, number, title, type, created_by) select id, 1, 'T', 'task', ${actor} from projects`)
    await db.execute(sql`insert into agents (role, name) values ('developer', 'Dev')`)
    await db.execute(sql`insert into runs (task_id, project_id, agent_id, role) select t.id, t.project_id, a.id, 'developer' from tasks t, agents a`)
    await db.execute(sql`insert into evidence (task_id, run_id, round, kind, note, blob, file_name, content_type, size)
      select t.id, r.id, 0, 'screenshot', 'Login page', 'abc123', 'login.png', 'image/png', 42 from tasks t, runs r`)

    await migrate(migrationsFolder)

    // Existing evidence keeps its file
    const existing = await db.execute(sql`select kind::text as kind, note, blob, file_name, content_type, size from evidence`)
    expect(existing.rows).toEqual([{ kind: 'screenshot', note: 'Login page', blob: 'abc123', file_name: 'login.png', content_type: 'image/png', size: 42 }])
    const insert = (kind: string) => db.execute(sql`insert into evidence (task_id, run_id, round, kind, note, size)
      select t.id, r.id, 0, ${kind}::evidence_kind, 'No visible change', 0 from tasks t, runs r`)
    // A note needs no file; any other kind still does
    await insert('note')
    await expect(insert('screenshot')).rejects.toThrow()
    const notes = await db.execute(sql`select note, blob, file_name, content_type from evidence where kind = 'note'`)
    expect(notes.rows).toEqual([{ note: 'No visible change', blob: null, file_name: null, content_type: null }])
  })

  it.for([
    { driver: 'pglite' as const },
    { driver: 'postgres' as const }
  ])('0027 makes epics already on the board direct and new ones take the project default, on $driver (D27)', { timeout: 60_000 }, async ({ driver }, context) => {
    requireDatabase(driver, context)
    const before = await migrationsBefore('0027_epic_review_modes')
    cleanup.push(() => rm(before, { recursive: true, force: true }))
    const { db, migrate } = await open(driver)

    await migrate(before)
    const actor = sql`'{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb`
    await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('P', 'p', 'PA', 'o/r', 'main')`)
    // In progress, all merged, only Backlog, and only a deleted board task
    const epics = { inProgress: 'in_progress', merged: 'merged', backlog: 'backlog', deleted: 'ready' }
    for (const [i, [title, status]] of Object.entries(epics).entries()) {
      await db.execute(sql`insert into epics (project_id, title, created_by) select id, ${title}, ${actor} from projects`)
      await db.execute(sql`insert into tasks (project_id, number, epic_id, title, type, status, deleted_at, created_by)
        select e.project_id, ${i + 1}, e.id, 'T', 'task', ${status}::task_status, ${title === 'deleted' ? sql`now()` : null}, ${actor} from epics e where e.title = ${title}`)
    }
    await db.execute(sql`insert into tasks (project_id, number, epic_id, title, type, status, created_by)
      select e.project_id, 5, e.id, 'T', 'task', 'merged', ${actor} from epics e where e.title = 'inProgress'`)

    await migrate(migrationsFolder)

    const modes = await db.execute(sql`select title, review_mode::text as mode, branch, pr_number, pr_head_sha, review_state from epics order by title`)
    expect(modes.rows).toEqual([
      { title: 'backlog', mode: 'epic', branch: null, pr_number: null, pr_head_sha: null, review_state: null },
      { title: 'deleted', mode: 'epic', branch: null, pr_number: null, pr_head_sha: null, review_state: null },
      { title: 'inProgress', mode: 'direct', branch: null, pr_number: null, pr_head_sha: null, review_state: null },
      { title: 'merged', mode: 'direct', branch: null, pr_number: null, pr_head_sha: null, review_state: null }
    ])
    const projects = await db.execute(sql`select epic_review_mode_default::text as mode from projects`)
    expect(projects.rows).toEqual([{ mode: 'epic' }])
  })

  describe('0038 run lifecycle checks', () => {
    const tag = '0038_loving_daimon_hellstrom'
    async function historical(driver: 'pglite' | 'postgres') {
      const before = await migrationsBefore(tag)
      cleanup.push(() => rm(before, { recursive: true, force: true }))
      const { db, migrate } = await open(driver)
      await migrate(before)
      const actor = sql`'{"kind":"human","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb`
      await db.execute(sql`insert into projects (name, slug, prefix, repository, default_branch) values ('P', 'p', 'PA', 'o/r', 'main')`)
      await db.execute(sql`insert into tasks (project_id, number, title, type, created_by) select id, 1, 'T', 'task', ${actor} from projects`)
      await db.execute(sql`insert into agents (name, role) values ('Juno', 'pm'), ('Atlas', 'developer')`)
      return { db, migrate }
    }
    const insertDeveloperRun = (state: string, outcome: string | null, endedAt: boolean) => sql`insert into runs (project_id, agent_id, task_id, role, state, outcome, ended_at)
      select t.project_id, a.id, t.id, 'developer', ${state}::run_state, ${outcome}::run_outcome, ${endedAt ? sql`now()` : null} from tasks t, agents a where a.role = 'developer'`

    it.for([
      { driver: 'pglite' as const },
      { driver: 'postgres' as const }
    ])('lists rows that break the checks and stops, changing nothing, on $driver', { timeout: 60_000 }, async ({ driver }, context) => {
      requireDatabase(driver, context)
      const { db, migrate } = await historical(driver)
      await db.execute(insertDeveloperRun('running', 'approved', true))
      await db.execute(insertDeveloperRun('completed', 'pr_opened', false))
      await db.execute(insertDeveloperRun('completed', 'pr_opened', true))
      const rows = () => db.execute(sql`select number, state::text as state, outcome::text as outcome, ended_at is not null as ended from runs order by number`)
      const stored = (await rows()).rows

      const failure = await migrate(migrationsFolder).then(() => null, (error: Error & { cause?: Error }) => error.cause?.message ?? error.message)
      expect(failure).toContain('4 check violation(s) in runs')
      expect(failure).toMatch(/run #1 \([0-9a-f-]+\): runs_ended_at_matches_state, role=developer state=running outcome=approved/)
      expect(failure).toMatch(/run #1 .*: runs_outcome_only_when_ended/)
      expect(failure).toMatch(/run #1 .*: runs_outcome_matches_role/)
      expect(failure).toMatch(/run #2 .*: runs_ended_at_matches_state, role=developer state=completed outcome=pr_opened/)
      expect(failure).not.toContain('run #3')
      expect((await rows()).rows).toEqual(stored)
      expect((await db.execute(sql`select count(*)::int as n from pg_constraint where conname like 'runs_%' and conname <> 'runs_task_unless_pm' and contype = 'c'`)).rows).toEqual([{ n: 0 }])
    })

    it.for([
      { driver: 'pglite' as const },
      { driver: 'postgres' as const }
    ])('passes outcome-less PM turns and interrupted runs through, on $driver', { timeout: 60_000 }, async ({ driver }, context) => {
      requireDatabase(driver, context)
      const { db, migrate } = await historical(driver)
      await db.execute(sql`insert into runs (project_id, agent_id, role, state, ended_at)
        select p.id, a.id, 'pm', s.state::run_state, now() from projects p, agents a, (values ('completed'), ('interrupted')) s(state) where a.role = 'pm'`)
      await db.execute(insertDeveloperRun('interrupted', null, true))
      await db.execute(insertDeveloperRun('running', null, false))

      await migrate(migrationsFolder)

      expect((await db.execute(sql`select count(*)::int as n from runs`)).rows).toEqual([{ n: 4 }])
      await expect(db.execute(insertDeveloperRun('running', null, true))).rejects.toThrow()
    })
  })

  // An empty database to migrate step by step: PGlite in memory, or a
  // throwaway database on the test Postgres server
  async function open(driver: 'pglite' | 'postgres') {
    if (driver === 'pglite') {
      const client = new PGlite()
      cleanup.push(() => client.close())
      const db = drizzle(client, { casing: 'snake_case' })
      return { db, migrate: (folder: string) => migrate(db, { migrationsFolder: folder }) }
    }
    const adminUrl = process.env.CORRAL_DATABASE_URL!
    const name = `corral_migration_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    await admin.query(`create database ${name}`)
    cleanup.push(async () => {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    })
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    const pool = new pg.Pool({ connectionString: url.href })
    cleanup.unshift(() => pool.end())
    const db = drizzlePg(pool, { casing: 'snake_case' })
    return { db, migrate: (folder: string) => migratePg(db, { migrationsFolder: folder }) }
  }
})
