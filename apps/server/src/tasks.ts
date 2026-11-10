import type { CreateTaskInput, HumanTransitionInput, PatchTaskInput, TransitionDetail } from '@corral/contracts'
import { createTaskInput } from '@corral/contracts'
import {
  canChangeType,
  checkDependencies,
  createFixTask as createFixTaskState,
  createTask as createTaskState,
  deletionFor,
  DEPENDENCY_DELETED_REASON,
  feedbackFixTitle,
  feedbackPoints,
  humanReviewFlag,
  isOnBoard,
  isPrFree,
  isViaPm,
  markdownToRichText,
  requiresHumanReview,
  richTextToMarkdown,
  richTextToPlainText,
  SERVER_ACTOR,
  taskRef,
  transition,
  type Actor,
  type TaskEvent,
  type TaskKind,
  type TaskState,
  type TaskStatus,
  type TransitionResult
} from '@corral/core'
import { schema, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { addComment, addCommentWithTransition } from './comments.ts'
import { sendBackDesignVersion } from './designs.ts'
import { invalidateEpicReview, type InvalidatedEpics } from './epic-review-state.ts'
import { ApiFailure } from './errors.ts'
import { checkParentCycles, createDelivery, deliveredAt, ensureParent, isParent, parentDeletion, promoteToParent, promotionRefusal, refuseOnParent, syncDeliveryContent } from './parents.ts'
import { handDraftToSubtask, joinDraftPlan } from './plan-items.ts'
import { allocateTaskNumber } from './projects.ts'
import { lockTask, toTaskState } from './task-rows.ts'

// Every write to a task: creating, editing, moving it through D10's statuses
// and deleting it

const { acceptanceCriteria, epics, projects, taskDependencies, tasks } = schema

async function checkEpic(tx: Executor, project: ProjectRow, epicId: string): Promise<void> {
  const [epic] = await tx.select({ id: epics.id }).from(epics).where(and(eq(epics.id, epicId), eq(epics.projectId, project.id)))
  if (!epic) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['epicId'], message: 'Unknown task' }] })
}

// The live tasks these numbers name, or the refusal naming those that don't exist
async function findDependencies(tx: Executor, project: ProjectRow, numbers: number[]): Promise<{ id: string, number: number }[]> {
  const wanted = [...new Set(numbers)]
  const found = wanted.length === 0
    ? []
    : await tx.select({ id: tasks.id, number: tasks.number }).from(tasks)
        .where(and(eq(tasks.projectId, project.id), inArray(tasks.number, wanted), isNull(tasks.deletedAt)))
  const unknown = wanted.filter(n => !found.some(d => d.number === n))
  if (unknown.length > 0) {
    throw new ApiFailure(400, { code: 'invalid_dependencies', problems: unknown.map(n => ({ code: 'unknown_dependency', dependsOn: taskRef(project.prefix, n) })) })
  }
  return found
}

// New tasks start in Backlog, or as Drafts for the PM's plans (D10).
// Returns the new task's ID.
export async function createTask(db: Executor, project: ProjectRow, rawInput: CreateTaskInput, actor: Actor, options: { draft?: boolean, invalidatedEpics?: InvalidatedEpics } = {}): Promise<string> {
  const input = createTaskInput.parse(rawInput)
  const created = createTaskState(actor, requiresHumanReview(input.type, input.humanReview ?? project.humanReviewDefault), options.draft, input.type)
  return insertTask(db, project, input, created, actor, { invalidatedEpics: options.invalidatedEpics })
}

// A human's change request on a task's PR: new work with its own criteria,
// Ready at once (D27, D29)
export async function createFixTask(db: Executor, project: ProjectRow, epicId: string, feedback: string, actor: Actor, options: { invalidatedEpics?: InvalidatedEpics } = {}): Promise<string> {
  const input = createTaskInput.parse({ type: 'task', title: feedbackFixTitle(feedback), description: markdownToRichText(feedback), epicId, acceptanceCriteria: feedbackPoints(feedback) })
  return insertTask(db, project, input, createFixTaskState(input.humanReview ?? project.humanReviewDefault, input.type), actor, { kind: 'fix', invalidatedEpics: options.invalidatedEpics })
}

async function insertTask(db: Executor, project: ProjectRow, input: ReturnType<typeof createTaskInput.parse>, created: TransitionResult, actor: Actor, options: { kind?: TaskKind, invalidatedEpics?: InvalidatedEpics | undefined }): Promise<string> {
  if (!created.ok) throw new ApiFailure(409, { code: 'transition_rejected', reason: created.error })
  return db.transaction(async (tx) => {
    const number = await allocateTaskNumber(tx, project.id)
    if (input.epicId) await checkEpic(tx, project, input.epicId)
    // A brand-new task has no dependents, so it can't close a cycle; it can
    // only point at tasks that don't exist
    const dependencies = await findDependencies(tx, project, input.dependsOn)
    const state = created.task
    if (isOnBoard(state.status)) await invalidateEpicReview(tx, input.epicId ?? null, options.invalidatedEpics)
    const [row] = await tx.insert(tasks).values({
      projectId: project.id,
      number,
      title: input.title,
      description: input.description,
      implementationPlan: input.implementationPlan ?? null,
      type: input.type,
      kind: options.kind,
      priority: input.priority,
      epicId: input.epicId,
      status: state.status,
      humanReview: state.humanReview,
      createdBy: actor
    }).returning()
    const taskId = row!.id

    if (input.acceptanceCriteria.length > 0) {
      await tx.insert(acceptanceCriteria).values(
        input.acceptanceCriteria.map((criterion, position) => ({ taskId, position, ...(typeof criterion === 'string' ? { text: criterion } : criterion) }))
      )
    }
    if (dependencies.length > 0) {
      await tx.insert(taskDependencies).values(dependencies.map(d => ({ projectId: project.id, taskId, dependsOnId: d.id })))
    }
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.created', { number: row!.number }))
    if (input.epicId) await ensureParent(tx, input.epicId, actor)
    if (input.epicId && dependencies.length > 0) await checkParentCycles(tx, project)
    return taskId
  })
}

// Adds a sub-task, making a parent of the task if it isn't one yet
export async function addSubtask(db: Executor, project: ProjectRow, taskId: string, input: CreateTaskInput, actor: Actor): Promise<string> {
  return db.transaction(async (tx) => {
    const { task } = await lockTask(tx, taskId)
    if (isParent(task)) {
      const [delivery] = await tx.select().from(epics).where(eq(epics.taskId, taskId))
      if (deliveredAt(delivery!)) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'This task has delivered. Add a separate follow-up task instead.' }] })
      const live = await tx.select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(eq(tasks.epicId, delivery!.id), isNull(tasks.deletedAt)))
      const subId = await createTask(tx, project, { ...input, epicId: delivery!.id }, actor)
      const drafted = live[0] && live.every(t => t.status === 'draft')
      if (drafted && await joinDraftPlan(tx, delivery!.id, subId, live[0]!.id)) await tx.update(tasks).set({ status: 'draft' }).where(eq(tasks.id, subId))
      return subId
    }
    const refusal = await promotionRefusal(tx, task)
    if (refusal) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: refusal }] })
    const [claimed] = await tx.select({ id: epics.id }).from(epics).where(eq(epics.taskId, taskId))
    if (claimed) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'A plan waiting for approval already gives this task subtasks.' }] })
    const deliveryId = await createDelivery(tx, project, { taskId, title: task.title, description: richTextToMarkdown(task.description), priority: task.priority }, actor)
    // Ready needs a description, and the work it describes moves to this sub-task
    const subId = await createTask(tx, project, { ...input, description: input.description ?? task.description as CreateTaskInput['description'], implementationPlan: input.implementationPlan ?? task.implementationPlan as CreateTaskInput['implementationPlan'], epicId: deliveryId }, actor)
    await promoteToParent(tx, project, task, subId, actor)
    if (task.status === 'draft') {
      await tx.update(tasks).set({ status: 'draft' }).where(eq(tasks.id, subId))
      if (!await handDraftToSubtask(tx, deliveryId, taskId, subId)) await tx.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, subId))
    }
    if (task.status === 'ready') await transitionTask(tx, subId, { type: 'approve' }, actor)
    return subId
  })
}

// Applies a D10 transition the human asked for. The row is locked for the
// whole check-and-write, and core decides whether the transition is allowed.
// A pinned `comment` is the human's answer: it stands or falls with the
// transition, stamped with the transaction's time like the audit entry, which
// is how the Inbox finds it again.
export async function transitionTask(db: Executor, taskId: string, input: HumanTransitionInput, actor: Actor, options: { comment?: string | undefined, invalidatedEpics?: InvalidatedEpics } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    await applyTransition(tx, task, project, await humanEvent(tx, task, input), actor, { event: input }, options.invalidatedEpics)
    if (options.comment) await addCommentWithTransition(tx, taskId, { body: options.comment, pinned: true }, actor)
  })
}

// Pauses or resumes claims on a task (flows.md §3). False when it already was.
export async function setTaskPaused(tx: Executor, taskId: string, paused: boolean, actor: Actor, now = new Date()): Promise<boolean> {
  const [task] = await tx.update(tasks).set({ paused, updatedAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.paused, !paused), isNull(tasks.deletedAt)))
    .returning({ projectId: tasks.projectId })
  if (!task) return false
  await appendAudit(tx, { projectId: task.projectId, taskId, actor }, paused ? auditEvent('task.paused', {}) : auditEvent('task.resumed', {}))
  return true
}

// Runs an event through core and writes the result with an audit entry.
// Every status change in Corral goes through here (D10). Throws an
// ApiFailure when core rejects it.
export async function applyTransition(
  tx: Executor,
  task: TaskRow,
  project: ProjectRow,
  event: TaskEvent,
  actor: Actor,
  detail: TransitionDetail,
  invalidatedEpics?: InvalidatedEpics
): Promise<TaskState> {
  const state = toTaskState(task)
  if (event.type === 'review_approved') {
    const humanCriteria = await tx.select({ id: acceptanceCriteria.id }).from(acceptanceCriteria)
      .where(and(eq(acceptanceCriteria.taskId, task.id), eq(acceptanceCriteria.checkedByHuman, true))).limit(1)
    if (humanCriteria.length) state.humanReview = true
  }
  // PR-free epic work integrates on agent approval: its flag and human checks
  // become obligations of the epic's human approval, and the row keeps them
  state.humanReview = humanReviewFlag({ ...task, humanReview: state.humanReview })
  const result = transition(state, event, actor, {
    reviewRoundCap: project.reviewRoundCap,
    failedRunCap: project.failedRunCap
  })
  if (!result.ok) throw new ApiFailure(409, { code: 'transition_rejected', reason: result.error })

  const next = result.task
  if (!isOnBoard(task.status) && isOnBoard(next.status)) {
    await invalidateEpicReview(tx, task.epicId, invalidatedEpics)
  }
  await tx.update(tasks).set({
    status: next.status,
    rebaseOnly: next.rebaseOnly ?? false,
    approvedHeadSha: next.approvedHeadSha ?? null,
    reviewRounds: next.reviewRounds,
    failedRuns: next.failedRuns,
    statusReason: next.reason,
    // A base update asked for in Ready to merge mustn't keep the approval
    // over whatever is pushed once the task has left it
    ...(next.status !== 'ready_to_merge' && { branchUpdateRequested: false }),
    // A spike finishes without a merge (D19); this is when it finished
    ...(task.type === 'spike' && next.status === 'merged' && task.status !== 'merged' && { mergedAt: new Date() }),
    updatedAt: new Date()
  }).where(eq(tasks.id, task.id))
  await sendBackDesignVersion(tx, task, event)
  if (event.type === 'human_request_changes' && event.feedback?.trim()) {
    await addCommentWithTransition(tx, task.id, { body: event.feedback!, pinned: true }, actor)
  }
  await appendAudit(tx, { projectId: project.id, taskId: task.id, actor }, auditEvent('task.transition', { ...detail, from: task.status, to: next.status satisfies TaskStatus }))
  return next
}

// The task's work is on its target branch, as `commitSha` when Corral knows
// it: Merged, through core like any other status change
export async function recordTaskMerged(tx: Executor, { task, project }: { task: TaskRow, project: ProjectRow }, event: Extract<TaskEvent, { type: 'merged' | 'merged_outside' | 'integrated' }>, detail: TransitionDetail, merge: { commitSha?: string | null, at: Date }): Promise<void> {
  await applyTransition(tx, task, project, event, SERVER_ACTOR, detail)
  await tx.update(tasks).set({ ...(merge.commitSha !== undefined && { mergeCommitSha: merge.commitSha }), mergedAt: merge.at, updatedAt: merge.at }).where(eq(tasks.id, task.id))
}

// What a PATCH changed in the text an agent works to (PRD §7.3), or null
// when the description and criteria are as they were
export interface TaskContentEdit {
  description: boolean
  fields?: string[]
  criteria: { added: number, removed: number, reworded: number } | null
}

// design/task.md: a PATCH per field. Criteria keep their IDs (and so their
// evidence and verdicts) when passed back with the same ID. `check` refuses
// the edit once the task is locked, and `paused` pauses or resumes claims on
// it in the same write.
export async function patchTask(db: Executor, project: ProjectRow, taskId: string, input: PatchTaskInput, actor: Actor, options: { invalidatedEpics?: InvalidatedEpics | undefined, check?: ((task: TaskRow) => void) | undefined, paused?: boolean | undefined, now?: Date } = {}): Promise<TaskContentEdit | null> {
  const { invalidatedEpics } = options
  return db.transaction(async (tx) => {
    // Serializes dependency edits, so concurrent patches can't each pass the
    // cycle check against the old graph. Taken before the task, the order
    // createTask needs. FOR UPDATE here would deadlock with any transaction
    // holding the task, as its audit insert takes KEY SHARE on the project.
    if (input.dependsOn) await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, project.id)).for('no key update')
    const { task } = await lockTask(tx, taskId)
    options.check?.(task)
    // Merged is final (D10): the record stays as it shipped; comments still work
    if (task.status === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'task_merged' })
    if (input.acceptanceCriteria) refuseOnParent(task, 'criteria')
    if (input.dependsOn) refuseOnParent(task, 'dependencies')
    if (input.type !== undefined || input.epicId !== undefined || input.humanReview !== undefined) refuseOnParent(task, 'delivery')
    if (input.type && !canChangeType(task, input.type)) throw new ApiFailure(409, { code: 'conflict', constraint: 'task_type_locked' })
    // D27: PM metadata edits must not remove the work that locks epic review mode.
    if (isViaPm(actor) && input.epicId !== undefined && input.epicId !== task.epicId && (task.prNumber !== null || isPrFree(task))) {
      throw new ApiFailure(409, { code: 'conflict', constraint: 'task_epic_locked' })
    }
    const { acceptanceCriteria: criteriaInput, dependsOn, ...fields } = input
    // D20: a design task's flag can't be turned off, by the human or a plan
    if ((fields.type ?? task.type) === 'design') fields.humanReview = true
    if (fields.epicId) await checkEpic(tx, project, fields.epicId)
    // A selected task's submissions target this epic's branch and it can't take another path
    if (isPrFree(task) && ((fields.epicId !== undefined && fields.epicId !== task.epicId) || (fields.type !== undefined && fields.type !== task.type))) {
      throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'A subtask submitting commits to the task\'s branch can\'t change membership or type' }] })
    }
    const descriptionChanged = fields.description !== undefined && JSON.stringify(fields.description) !== JSON.stringify(task.description)
    let criteriaChange: TaskContentEdit['criteria'] = null
    if (fields.epicId !== undefined && fields.epicId !== task.epicId && isOnBoard(task.status)) {
      for (const epicId of [task.epicId, fields.epicId]) {
        await invalidateEpicReview(tx, epicId, invalidatedEpics)
      }
    }
    if (Object.keys(fields).length > 0) {
      await tx.update(tasks).set({ ...fields, updatedAt: new Date() }).where(eq(tasks.id, taskId))
    }
    await syncDeliveryContent(tx, task, fields)
    if (fields.epicId) {
      await ensureParent(tx, fields.epicId, actor)
      await checkParentCycles(tx, project)
    }
    let newHumanCheck = false
    let newAgentCheck = false
    if (criteriaInput) {
      const existing = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId))
      newHumanCheck = criteriaInput.some(c => c.checkedByHuman && !existing.some(e => e.id === c.id && e.checkedByHuman))
      newAgentCheck = criteriaInput.some((c) => {
        const held = existing.find(e => e.id === c.id)
        return !(c.checkedByHuman ?? held?.checkedByHuman ?? false) && (!held || held.checkedByHuman)
      })
      const keep = new Set(criteriaInput.map(c => c.id).filter((id): id is string => Boolean(id)))
      const gone = existing.filter(c => !keep.has(c.id)).map(c => c.id)
      if (gone.length > 0) await tx.delete(acceptanceCriteria).where(inArray(acceptanceCriteria.id, gone))
      const added = criteriaInput.filter(c => !c.id || !existing.some(e => e.id === c.id)).length
      const reworded = criteriaInput.filter(c => existing.some(e => e.id === c.id && (e.text !== c.text || e.checkedByHuman !== (c.checkedByHuman ?? e.checkedByHuman)))).length
      const reordered = criteriaInput.some((c, i) => c.id !== undefined && existing.find(e => e.id === c.id)?.position !== i)
      if (added + gone.length + reworded > 0 || reordered) criteriaChange = { added, removed: gone.length, reworded }
      for (const [position, criterion] of criteriaInput.entries()) {
        if (criterion.id && existing.some(c => c.id === criterion.id)) {
          await tx.update(acceptanceCriteria).set({ position, text: criterion.text, checkedByHuman: criterion.checkedByHuman, updatedAt: new Date() }).where(eq(acceptanceCriteria.id, criterion.id))
        } else {
          await tx.insert(acceptanceCriteria).values({ taskId, position, text: criterion.text, checkedByHuman: criterion.checkedByHuman })
        }
      }
    }
    if (task.status === 'ready_to_merge' && newAgentCheck && actor.kind === 'human') {
      // Evidence for it can only come from a developer run (D21, flows.md step
      // 5), so this is the human asking for more work, whatever else changed.
      // Without it the merge gate would wait for evidence nothing will produce.
      await applyTransition(tx, task, project, { type: 'human_request_changes' }, actor, { event: { type: 'human_request_changes' } })
      await addComment(tx, taskId, { body: `A criterion that needs evidence was added after approval. Attach evidence for it, then report ${isPrFree(task) ? 'commit_submitted' : 'pr_updated'}.`, pinned: true }, SERVER_ACTOR)
    // A PR-free task's new check goes to the epic review instead
    } else if (task.status === 'ready_to_merge' && newHumanCheck && !isPrFree(task)) {
      await applyTransition(tx, task, project, { type: 'require_human_check' }, SERVER_ACTOR, { event: 'require_human_check' })
    }
    if (dependsOn) await setDependencies(tx, project, task, dependsOn)
    if (options.paused !== undefined) await setTaskPaused(tx, taskId, options.paused, actor, options.now)
    // An empty input still ran the merged guard above, but it edited nothing
    if (Object.keys(input).length > 0) await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.updated', { changed: Object.keys(input) }))
    const changedFields = Object.keys(fields).filter(k => JSON.stringify(fields[k as keyof typeof fields]) !== JSON.stringify(task[k as keyof TaskRow]))
    if (dependsOn !== undefined) changedFields.push('dependsOn')
    return descriptionChanged || criteriaChange || changedFields.length ? { description: descriptionChanged, criteria: criteriaChange, fields: changedFields.filter(k => k !== 'description') } : null
  })
}

// Replaces a task's dependencies, keeping the graph a DAG (core)
async function setDependencies(tx: Executor, project: ProjectRow, task: TaskRow, numbers: number[]): Promise<void> {
  const found = await findDependencies(tx, project, numbers)
  // The whole project graph with this task's new edges, checked by core
  const edges = await tx.select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId }).from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId)).where(eq(tasks.projectId, project.id))
  const ids = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)))
  const graph = new Map<string, string[]>(ids.map(t => [t.id, []]))
  for (const edge of edges) {
    if (edge.taskId !== task.id) graph.get(edge.taskId)?.push(edge.dependsOnId)
  }
  graph.set(task.id, found.map(d => d.id))
  const problems = checkDependencies(graph)
  if (problems.length > 0) throw new ApiFailure(400, { code: 'invalid_dependencies', problems })
  await checkParentCycles(tx, project, { changed: new Map([[task.id, found.map(d => d.id)]]) })
  await tx.delete(taskDependencies).where(and(eq(taskDependencies.projectId, project.id), eq(taskDependencies.taskId, task.id)))
  if (found.length > 0) await tx.insert(taskDependencies).values(found.map(d => ({ projectId: project.id, taskId: task.id, dependsOnId: d.id })))
}

// D10 "Deleting": Backlog tasks go outright; the rest are hidden but kept
// with their history. Dependents move to Blocked unless the dependency was
// removed first. The caller has already stopped the run and closed the PR.
// `discardDraft` throws away a Plan thread's draft: it is kept hidden, and its
// dependents' edges are dropped instead, since a draft was never accepted
// work, so accepted tasks keep their status (COR-119).
export async function deleteTaskRows(db: Executor, taskId: string, actor: Actor, reason: string | null, options: { discardDraft?: boolean } = {}): Promise<string[]> {
  return db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    let mode = options.discardDraft && task.status === 'draft' ? 'soft' : deletionFor(task)
    if (mode === 'not_allowed') throw new ApiFailure(409, { code: 'conflict', constraint: 'merged_tasks_are_immutable' })
    const parent = await parentDeletion(tx, task)
    if (parent?.keepRow) mode = 'soft'
    const dependentRows = tx.select({ task: tasks }).from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(and(eq(taskDependencies.dependsOnId, taskId), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.id))
    // Blocking writes each dependent from this read, so it must be locked
    const dependents = await (options.discardDraft ? dependentRows : dependentRows.for('update', { of: tasks }))
    if (options.discardDraft) await tx.delete(taskDependencies).where(eq(taskDependencies.dependsOnId, taskId))
    else for (const { task: dependent } of dependents) {
      // e.g. Backlog: nothing to block yet
      if (!transition(toTaskState(dependent), { type: 'block', reason: DEPENDENCY_DELETED_REASON }, SERVER_ACTOR).ok) continue
      await applyTransition(tx, dependent, project, { type: 'block', reason: DEPENDENCY_DELETED_REASON }, SERVER_ACTOR, { event: 'dependency_deleted', dependency: taskRef(project.prefix, task.number) })
    }
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.deleted', { mode, number: task.number, title: task.title, reason }))
    await parent?.release()
    if (mode === 'hard') await tx.delete(tasks).where(eq(tasks.id, taskId))
    // No run keeps a lease on a hidden task: it would pass every fence
    else await tx.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date(), leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null }).where(eq(tasks.id, taskId))
    return dependents.map(d => d.task.id)
  })
}

// Adds the facts core needs to the human's request
async function humanEvent(db: Executor, task: TaskRow, input: HumanTransitionInput): Promise<TaskEvent> {
  if (input.type !== 'approve') return input
  const criteria = await db.select({ text: acceptanceCriteria.text }).from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, task.id))
  return {
    type: 'approve',
    content: {
      title: task.title,
      description: richTextToPlainText(task.description),
      acceptanceCriteria: criteria.map(c => c.text)
    }
  }
}
