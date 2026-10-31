import { schema } from '@corral/db'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createTestApp } from './test-app.ts'

// Query counts, latency and response sizes for the hot read paths on a
// database the size of a project with history. Prints a table, and writes it
// as JSON to CORRAL_PERF_OUT when that is set. On Postgres (with
// CORRAL_DATABASE_URL) it counts queries too; PGlite gives timings only.
const TASKS = 600
const RUNS_PER_TASK = 3
const AUDIT_ROWS = 30_000
const SESSIONS = 20
const SAMPLES = 15

// `pg` belongs to packages/db, so it's reached through there
const { Client } = createRequire(resolve('../../packages/db/package.json'))('pg') as { Client: { prototype: { query: (...args: unknown[]) => unknown } } }
let queries = 0
const query = Client.prototype.query
Client.prototype.query = function (this: unknown, ...args: unknown[]) {
  queries++
  return query.apply(this, args)
}

const statusFor = (n: number) =>
  n <= 450
    ? 'merged'
    : n <= 510
      ? 'ready'
      : n <= 560
        ? 'backlog'
        : n <= 565
          ? 'in_progress'
          : n <= 570
            ? 'agent_review'
            : n <= 585
              ? 'human_review'
              : n <= 595 ? 'blocked' : 'failed'

it('measures the hot read paths', async () => {
  const driver = process.env.CORRAL_DATABASE_URL ? 'postgres' : 'pglite'
  const t = await createTestApp(driver)
  try {
    const project = await t.createProject({ name: 'Perf' })
    const [agent] = await t.db.select().from(schema.agents).where(sql`role = 'developer'`)
    const [reviewer] = await t.db.select().from(schema.agents).where(sql`role = 'reviewer'`)
    const actor = sql.raw(`'${JSON.stringify(t.actor)}'::jsonb`)
    const description = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Describes the work in reasonable detail. '.repeat(40) }] }] })

    const ids = Array.from({ length: TASKS }, () => randomUUID())
    const values = ids.map((id, i) => {
      const n = i + 1
      const status = statusFor(n)
      return sql`(${id}::uuid, ${project.id}::uuid, ${n}, ${`Task number ${n}`}, ${description}::jsonb, ${status}::task_status, 'task'::task_type, ${status === 'blocked' || status === 'failed' ? 'A reason' : null}, ${actor}, ${n <= 450 ? sql`now()` : sql`null`}, now() - (${TASKS - n} * interval '10 minutes'))`
    })
    await t.db.execute(sql`insert into tasks (id, project_id, number, title, description, status, type, status_reason, created_by, merged_at, created_at) values ${sql.join(values, sql`, `)}`)
    await t.db.execute(sql`insert into acceptance_criteria (task_id, position, text) select t.id, g, 'A criterion that can be verified' from tasks t, generate_series(0, 2) g where t.project_id = ${project.id}`)
    await t.db.execute(sql`insert into comments (task_id, author, body) select t.id, ${actor}, 'A comment with a few words in it' from tasks t, generate_series(1, 3) g where t.project_id = ${project.id}`)
    await t.db.execute(sql`insert into runs (agent_id, project_id, task_id, role, state, outcome, summary, queued_at, started_at, ended_at)
      select case when g = 3 then ${reviewer!.id}::uuid else ${agent!.id}::uuid end, t.project_id, t.id, case when g = 3 then 'reviewer'::agent_role else 'developer'::agent_role end, 'completed'::run_state, case when g = 3 then 'approved'::run_outcome else 'pr_opened'::run_outcome end, 'What the run did', now(), now(), now()
      from tasks t, generate_series(1, ${RUNS_PER_TASK}) g where t.project_id = ${project.id}`)
    await t.db.execute(sql`insert into reviews (task_id, run_id, round, head_sha, verdict, summary, author)
      select r.task_id, r.id, 1, 'abc', 'approved'::review_verdict, 'Looks right', ${actor} from runs r where r.role = 'reviewer' and r.project_id = ${project.id}`)
    await t.db.execute(sql`insert into evidence (task_id, run_id, round, kind, note, size)
      select r.task_id, r.id, 1, 'note'::evidence_kind, 'Checked by hand', 0 from runs r where r.role = 'developer' and r.project_id = ${project.id}`)
    await t.db.execute(sql`insert into audit_log (project_id, task_id, actor, action, detail, created_at)
      select t.project_id, t.id, ${actor}, 'task.transition', jsonb_build_object('from', 'ready', 'to', t.status::text), t.created_at from tasks t where t.project_id = ${project.id}`)
    await t.db.execute(sql`insert into audit_log (project_id, task_id, actor, action, detail)
      select ${project.id}::uuid, null, ${actor}, 'pm.tool_called', jsonb_build_object('tool', 'get_task', 'input', repeat('x', 200)) from generate_series(1, ${AUDIT_ROWS})`)
    for (let i = 0; i < SESSIONS; i++) {
      const [session] = await t.db.insert(schema.planSessions).values({ projectId: project.id, title: `Session ${i}`, createdBy: t.actor, unread: true }).returning()
      await t.db.execute(sql`insert into plan_messages (session_id, role, text) select ${session!.id}::uuid, case when g % 2 = 0 then 'human' else 'pm' end, 'A message in the thread' from generate_series(1, 20) g`)
    }
    await t.db.execute(sql`analyze`)

    const routes: [string, string][] = [
      ['inbox', '/api/inbox'],
      ['task list', `/api/projects/${project.slug}/tasks`],
      ['task detail', `/api/projects/${project.slug}/tasks/570`],
      ['task history', `/api/projects/${project.slug}/tasks/570/history`],
      ['plan sessions', '/api/plan/sessions'],
      ['projects', '/api/projects'],
      ['agents', '/api/agents'],
      ['active runs', '/api/runs?active=1'],
      ['epics', `/api/projects/${project.slug}/epics`],
      ['flow metrics', `/api/projects/${project.slug}/metrics/flow`]
    ]
    const results: Record<string, { ms: number, queries: number | null, kb: number, status: number }> = {}
    const measure = async (name: string, run: () => Promise<Response>) => {
      const times: number[] = []
      let bytes = 0
      let count = 0
      let status = 0
      for (let i = 0; i < SAMPLES; i++) {
        const before = queries
        const start = performance.now()
        const response = await run()
        const body = await response.arrayBuffer()
        times.push(performance.now() - start)
        count = queries - before
        bytes = body.byteLength
        status = response.status
      }
      times.sort((a, b) => a - b)
      results[name] = { ms: Math.round(times[SAMPLES >> 1]! * 10) / 10, queries: driver === 'postgres' ? count : null, kb: Math.round(bytes / 102.4) / 10, status }
    }
    for (const [name, path] of routes) await measure(name, () => t.request('GET', path))
    await measure('patch task', () => t.request('PATCH', `/api/projects/${project.slug}/tasks/520`, { title: `Renamed ${Math.random()}` }))
    console.table(results)
    if (process.env.CORRAL_PERF_OUT) await writeFile(process.env.CORRAL_PERF_OUT, JSON.stringify({ driver, results }, null, 2))
    expect(results.inbox!.status).toBe(200)
  } finally {
    await t.close()
  }
})
