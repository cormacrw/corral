import { ACTIVE_RUN_STATES, LEASE_DURATION_MS, leaseExpiry } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import type { RunContext, RunKind } from './run-context.ts'
import { STOP } from './run-stops.ts'

const { runs, tasks } = schema

// Where a run's lease lives. A task run's is on its task, which it fences
// against every other run; epic reviews, epic fixes and PM turns hold theirs
// on the run. Taking one is part of each claim (core's leaseExpiry);
// ending the run releases it (run-lifecycle).
export const Lease = {
  async renew(db: Database, ctx: RunContext, now: Date): Promise<void> {
    const leaseExpiresAt = leaseExpiry(now)
    if (ctx.kind !== 'task') {
      await db.update(runs).set({ leaseExpiresAt }).where(eq(runs.id, ctx.run.id))
      return
    }
    if (!ctx.task) return
    await db.update(tasks).set({ leaseHeartbeatAt: now, leaseExpiresAt })
      .where(and(eq(tasks.id, ctx.task.id), eq(tasks.leaseRunId, ctx.run.id), eq(tasks.leaseEpoch, ctx.run.leaseEpoch!)))
  },

  // A task run whose lease ran out, though the run still looks live
  lapsed(ctx: RunContext, now: Date): boolean {
    return ctx.kind === 'task' && ctx.task?.leaseExpiresAt != null && ctx.task.leaseExpiresAt <= now
  },

  // Runs whose lease ran out: the runner stopped heartbeating. A PM turn still
  // holding its job was never sent, and a turn sent before PM leases existed
  // has none, so it's timed from when it was queued.
  async expired(db: Database, now: Date): Promise<string[]> {
    const onRuns = await db.select({ id: runs.id }).from(runs).where(and(
      inArray(runs.state, [...ACTIVE_RUN_STATES]),
      isNull(runs.pmJob),
      or(lt(runs.leaseExpiresAt, now), and(eq(runs.role, 'pm'), isNull(runs.leaseExpiresAt), lt(runs.queuedAt, new Date(now.getTime() - LEASE_DURATION_MS))))
    ))
    const onTasks = await db.select({ runId: tasks.leaseRunId }).from(tasks)
      .where(and(isNotNull(tasks.leaseRunId), lt(tasks.leaseExpiresAt, now)))
    return [...onRuns.map(r => r.id), ...onTasks.map(r => r.runId!)]
  },

  expiredStop(kind: RunKind): string {
    switch (kind) {
      case 'task': return STOP.leaseExpired
      case 'pm': return STOP.pmLeaseExpired
      case 'epic_fix': return STOP.fixLeaseExpired
      case 'epic_review': return STOP.reviewLeaseExpired
    }
  }
}
