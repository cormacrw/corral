import { approveDesignVersion, isDesignApprovable, type Actor } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { asc, eq } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure } from './errors.ts'
import { lockTask } from './task-rows.ts'
import { applyTransition } from './tasks.ts'
import { addCommentWithTransition } from './comments.ts'

const { designVersions, tasks } = schema

// The human approves a version in Human review, or recovers a design left
// in Ready to merge by the old Inbox path (D20): it's
// marked approved and every earlier version superseded. Versions are
// otherwise immutable. Returns the approved version's id.
export async function approveDesign(db: Database, taskId: string, version: number | undefined, actor: Actor, note?: string): Promise<string> {
  return db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    if (actor.kind !== 'human' || task.type !== 'design' || !isDesignApprovable(task.status)) {
      throw new ApiFailure(409, { code: 'transition_rejected', reason: { code: 'invalid_transition', status: task.status, event: 'human_approve' } })
    }
    const rows = await tx.select({ id: designVersions.id, version: designVersions.version, status: designVersions.status })
      .from(designVersions).where(eq(designVersions.taskId, taskId)).orderBy(asc(designVersions.version))
    const submitted = rows.filter(row => row.status === 'submitted').at(-1)
    const latest = rows.at(-1)
    // Before Approved was a task status, task-page approvals left the task
    // in Human review. Recover only its latest, already approved version,
    // and never let it bypass a newer submission waiting for review.
    const legacyApproval = !submitted && latest?.status === 'approved' ? latest : undefined
    version ??= submitted?.version ?? legacyApproval?.version
    const target = rows.find(row => row.version === version)
    if (!target || (task.status === 'approved' ? target.status !== 'approved' : target.status !== 'submitted' && target.id !== legacyApproval?.id)) {
      throw new ApiFailure(409, { code: 'invalid_input', issues: [{ path: ['version'], message: 'Choose a submitted design version' }] })
    }
    if (task.status === 'approved') return target.id
    const result = approveDesignVersion(rows, target.version)
    if (!result.ok) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ path: ['version'], message: result.error }] })
    for (const next of result.versions) {
      const before = rows.find(r => r.id === next.id)!
      if (before.status !== next.status) await tx.update(designVersions).set({ status: next.status, updatedAt: new Date() }).where(eq(designVersions.id, next.id))
    }
    if (task.status === 'human_review') {
      await applyTransition(tx, task, project, { type: 'human_approve' }, actor, { event: 'human_approve', headSha: null })
    } else {
      await tx.update(tasks).set({ status: 'approved', updatedAt: new Date() }).where(eq(tasks.id, taskId))
      await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.transition', { event: 'human_approve', headSha: task.headSha, from: task.status, to: 'approved' }))
    }
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('design.approved', { version: target.version }))
    if (note?.trim()) await addCommentWithTransition(tx, taskId, { body: note.trim() }, actor)
    return result.versions.find(v => v.version === target.version)!.id
  })
}
