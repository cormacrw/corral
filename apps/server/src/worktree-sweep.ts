import { ACTIVE_RUN_STATES, type Actor } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, gte, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import type { RunnerHub } from './runner-hub.ts'

const { epics, planSessions, runs, tasks } = schema

const server: Actor = { kind: 'system', component: 'server' }

// How long a Plan session keeps its pm worktree after its last activity. The
// next PM turn recreates it at the same path, so the agent session still resumes.
export const PM_WORKTREE_TTL = 24 * 60 * 60 * 1000

const SWEEP_INTERVAL_MS = 60 * 60 * 1000
// A first sweep can have a lot to remove, behind fetches holding the repo locks
const SWEEP_TIMEOUT_MS = 10 * 60 * 1000

export interface WorktreeSweepDeps {
  db: Database
  runner: RunnerHub
  now?: () => Date
}

// Removes the worktrees nothing needs any more, on every online runner, each
// time a runner connects and then hourly. It also retries a cleanup_worktrees
// that failed because no runner was online. Merges and deletions already
// comment on kept worktrees, so this only writes to the audit log.
export class WorktreeSweep {
  #d: WorktreeSweepDeps
  #timer: NodeJS.Timeout | null = null
  #running: Promise<void> | null = null
  #again = false

  constructor(deps: WorktreeSweepDeps) {
    this.#d = deps
  }

  start(intervalMs = SWEEP_INTERVAL_MS): void {
    this.#timer = setInterval(() => void this.run(), intervalMs)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  // Sweeps never overlap. One asked for during a sweep runs after it, so a
  // runner connecting meanwhile still gets one.
  async run(): Promise<void> {
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    this.#running = (async () => {
      do {
        this.#again = false
        await this.#sweep().catch(error => console.error('Worktree sweep failed', error))
      } while (this.#again)
      this.#running = null
    })()
    return this.#running
  }

  async #sweep(): Promise<void> {
    const { db, runner } = this.#d
    if (!runner.online) return
    const results = await runner.sweepWorktrees({ kind: 'sweep_worktrees', ...await this.#keepSet() }, SWEEP_TIMEOUT_MS)
    const answers = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
    for (const result of results) {
      if (result.status === 'rejected') console.error('Worktree sweep failed on a runner', result.reason)
    }
    if (!answers.length) return
    await appendAudit(db, { actor: server }, auditEvent('worktrees.swept', { removed: answers.flatMap(a => a.removed), kept: answers.flatMap(a => a.kept) }))
  }

  async #keepSet(): Promise<{ keepTaskIds: string[], keepPlanSessionIds: string[], keepEpicIds: string[] }> {
    const { db } = this.#d
    const cutoff = new Date((this.#d.now?.() ?? new Date()).getTime() - PM_WORKTREE_TTL)
    // Soft-deleted tasks stay in the table, but nothing runs on them again
    const keptTasks = await db.select({ id: tasks.id }).from(tasks)
      .where(and(ne(tasks.status, 'merged'), isNull(tasks.deletedAt)))
    const keptSessions = await db.selectDistinct({ id: planSessions.id }).from(planSessions)
      .leftJoin(runs, and(eq(runs.planSessionId, planSessions.id), eq(runs.role, 'pm'), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      .where(or(gte(planSessions.updatedAt, cutoff), isNotNull(runs.id)))
    const keptEpics = await db.select({ id: epics.id }).from(epics).where(isNull(epics.mergeCommitSha))
    return { keepTaskIds: keptTasks.map(t => t.id), keepPlanSessionIds: keptSessions.map(s => s.id), keepEpicIds: keptEpics.map(e => e.id) }
  }
}
