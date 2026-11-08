import type { TransitionDetail } from '@corral/contracts'
import { SERVER_ACTOR, type GateCheck, type TaskEvent, type TaskStatus } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { eq } from 'drizzle-orm'
import { failedCheckLine } from './checks.ts'
import { MAX_CI_FIXES } from './retries.ts'
import { triageCap } from './retry-recovery.ts'
import { ciFixesInARow } from './task-base.ts'
import { lockTask } from './task-rows.ts'
import { applyTransition } from './tasks.ts'
import { addCommentWithTransition } from './comments.ts'

// What the merge and integration passes do to a task they read a while ago

const { tasks } = schema

export interface ServerChange {
  event: TaskEvent
  detail: TransitionDetail
  // A failure that ends Corral's own retries: the PM triages it (D30)
  cap?: boolean
  comment?: string
  values?: Partial<typeof tasks.$inferInsert>
}

// Only from the status the pass read, with no run on the task: a human or
// an agent may have moved it since. False when it had moved.
export async function settleTask(db: Database, taskId: string, change: ServerChange, from: TaskStatus = 'ready_to_merge'): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    if (task.leaseRunId || task.status !== from) return false
    await applyTransition(tx, task, project, change.event, SERVER_ACTOR, change.detail)
    if (change.cap) await triageCap(tx, taskId, true)
    if (change.values) await tx.update(tasks).set(change.values).where(eq(tasks.id, taskId))
    if (change.comment) await addCommentWithTransition(tx, taskId, { body: change.comment }, SERVER_ACTOR)
    return true
  })
}

// flows.md 7b: CI fails on the task's work, so it goes back to its developer
// with the failures, until MAX_CI_FIXES fixes in a row haven't made it pass
export async function ciFailed(db: Database, taskId: string, failed: GateCheck[], approvedHeadSha: string | null, instruction: string): Promise<ServerChange> {
  const names = failed.map(c => c.name)
  if (await ciFixesInARow(db, taskId) >= MAX_CI_FIXES) {
    return { event: { type: 'fail', reason: `CI still fails after ${MAX_CI_FIXES} fixes in a row: ${names.join(', ')}` }, detail: { event: 'ci_failed', checks: names }, cap: true }
  }
  return {
    event: { type: 'ci_failed' },
    detail: { event: 'ci_failed', checks: names },
    comment: [instruction, '', ...failed.map(c => `- ${failedCheckLine(c)}`)].join('\n'),
    values: { ciFix: failed.map(c => ({ name: c.name, url: c.url })), approvedHeadSha }
  }
}
