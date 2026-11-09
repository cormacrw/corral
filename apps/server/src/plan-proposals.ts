import { normalizeProposedPlan, toolName, type DraftSession, type Plan, type ProposedPlanInput } from '@corral/contracts'
import { checkPlan, checkPlanEpicDependencies, requiresHumanReview, designPinKey, diffPlans, ACTIVE_RUN_STATES, markdownToRichText, optionalMarkdownToRichText, parseTaskRef, revisionProblem, richTextToMarkdown, TASK_REF_PATTERN, taskRef, type Actor, type DesignPin, type DesignPinTarget, type PlanDependencyContext, type PlanRef, type ProposedPlan, type ProposedTask } from '@corral/core'
import { schema, type Database, type Executor, type PlanRevision, type PlanSessionRow, type ProjectRow } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { setDesignPin } from './designs.ts'
import { listEpics, replaceEpicDependencies, reviewModeLocked, withInvalidatedEpics } from './epics.ts'
import type { InvalidatedEpics } from './epic-review-state.ts'
import { ApiFailure, notFound, requireHuman } from './errors.ts'
import type { EventBus } from './events.ts'
import { checkParentCycles, collapseUnstartedParent, createDelivery, deleteEpicWithParent, isParent, promoteToParent, promotionRefusal, syncParentContent } from './parents.ts'
import { HUMAN_PLAN_KEY, draftSessions } from './plan-items.ts'
import { insertMessage, type PlanSessions } from './plan-sessions.ts'
import { lowersMode, matchCriteria, newTaskLowersReview, reviewModeName, taskGatesLowered } from './review-gates.ts'
import { createTask, deleteTaskRows, patchTask, transitionTask } from './tasks.ts'
import { taskByRef } from './task-rows.ts'
import { loadTasks } from './task-views.ts'
import { ToolError } from './tool-error.ts'
import { taskCriteria } from './criteria.ts'

// A Plan session's proposals (D9, D10): the PM's plan versions, their Drafts
// and the revisions they stage, and the human's approve or discard

const { acceptanceCriteria, designVersions, epicDependencies, epics, planEpics, planMessages, planTasks, plans, planSessions, projects, runs, taskDependencies, tasks } = schema

// Plans saved before plan_epics have only plans.epicId, under this key
const ONLY_EPIC = 'main'

// An existing task a plan names by ref
interface RefTarget {
  id: string
  number: number
  status: string
}

type PlanRow = typeof plans.$inferSelect

// Commands describe new writes, independently of nullable historical reads.
export interface ApprovePlanCommand {
  approvedBy: Extract<Actor, { kind: 'human' }>
  approvedAt: Date
}

export type PlanTaskWrite = {
  planId: string
  key: string
  position: number
} & (
  | { change: 'added' | 'changed' | 'unchanged', taskId: string, revision: PlanRevision | null }
  | { change: 'removed', taskId: string | null, revision?: null }
)

async function recordApproval(tx: Executor, planId: string, command: ApprovePlanCommand) {
  await tx.update(plans).set({ status: 'approved', ...command }).where(eq(plans.id, planId))
}

async function insertPlanTasks(tx: Executor, items: PlanTaskWrite[]) {
  await tx.insert(planTasks).values(items)
}

interface PlanProposalsDeps {
  db: Database
  events: EventBus
  sessions: Pick<PlanSessions, 'publish' | 'messageSaved'>
  wake(taskIds?: readonly string[]): void
}

export class PlanProposals {
  #d: PlanProposalsDeps

  constructor(deps: PlanProposalsDeps) {
    this.#d = deps
  }

  // A project's Drafts grouped by the Plan session they belong to, newest
  // session first (D10)
  async listDrafts(projectId: string): Promise<DraftSession[]> {
    const { db } = this.#d
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
    if (!project) throw notFound()
    const rows = await db.select().from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.status, 'draft'), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
    const owners = await draftSessions(db, rows.map(r => r.id))
    const sessionIds = [...new Set([...owners.values()].map(o => o.id))]
    if (sessionIds.length === 0) return []
    const sessionRows = await db.select().from(planSessions).where(inArray(planSessions.id, sessionIds)).orderBy(desc(planSessions.updatedAt), desc(planSessions.createdAt))
    // Newest version first, so the first row per session is its latest plan
    const planRows = await db.select({ sessionId: plans.sessionId, status: plans.status }).from(plans)
      .where(inArray(plans.sessionId, sessionIds)).orderBy(desc(plans.version))
    return sessionRows.map(session => ({
      sessionId: session.id,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
      planStatus: planRows.find(p => p.sessionId === session.id)?.status ?? null,
      drafts: rows.filter(r => owners.get(r.id)?.id === session.id).map(r => ({
        taskId: r.id, ref: taskRef(project.prefix, r.number), title: r.title, type: r.type, priority: r.priority
      }))
    }))
  }

  async publishDrafts(projectId: string): Promise<void> {
    this.#d.events.publish({ type: 'plan.drafts', projectId, sessions: await this.listDrafts(projectId) })
  }

  // Validates with core and saves a plan version. Tasks are created as
  // Drafts, seen only in the plan (D10); a revision updates, adds or deletes
  // the ones still in Draft by key. A task with a `ref` revises an existing
  // Backlog or unclaimed Ready task instead: its edits are staged on the plan
  // and written only when the human approves.
  async propose(session: PlanSessionRow, project: ProjectRow, runId: string, input: ProposedPlanInput, actor: Actor) {
    const { db } = this.#d
    if (session.projectId && project.id !== session.projectId) throw new ToolError(`The plan was not saved: this conversation belongs to another project, so it can't plan for ${project.slug}. Start a thread in ${project.slug} with ${toolName('start_thread')} and propose it there.`)
    const keepsReview = new Set(input.tasks.filter(t => t.humanReview === undefined).map(t => t.key))
    const proposed = normalizeProposedPlan(input)
    const { found, targets } = await this.#lookupRefs(project, proposed)
    // A new top-level task that leaves the flag out takes the project's
    // default, and can't turn it off: that lowers a gate, so it takes the
    // human's confirmation through update_task once the task exists. A new
    // sub-task gets its review from its parent's mode, so it starts off.
    const lowered: string[] = []
    for (const task of proposed.tasks) {
      if (task.ref || task.epic) continue
      if (keepsReview.has(task.key)) task.humanReview = requiresHumanReview(task.type, project.humanReviewDefault)
      else if (newTaskLowersReview(project, task)) lowered.push(`"${task.title}"`)
    }
    if (lowered.length > 0) {
      throw new ToolError(`The plan was not saved: ${project.name} has human review on by default, so a new task can't set humanReview to false (${lowered.join(', ')}). Leave humanReview out so it takes the project default. If the human wants a task without human review, once the plan is approved call ${toolName('update_task')} with humanReview false, which asks them to confirm.`)
    }
    // A revision that leaves the flag out keeps the task's
    for (const task of proposed.tasks) {
      const target = task.ref ? targets.get(task.ref) : undefined
      if (!target || !keepsReview.has(task.key)) continue
      const [row] = await db.select({ humanReview: tasks.humanReview }).from(tasks).where(eq(tasks.id, target.id))
      task.humanReview = requiresHumanReview(task.type, row?.humanReview ?? false)
    }
    const { found: designs, versionIds } = await this.#lookupDesigns(project, proposed)

    const [latest] = await db.select().from(plans).where(eq(plans.sessionId, session.id)).orderBy(desc(plans.version)).limit(1)
    if (latest?.status === 'proposed' && latest.projectId !== project.id) throw new ToolError('Approve or discard the current plan before proposing a plan for another project.')
    // A discarded plan's Drafts are gone, so the next version starts afresh
    const previous = latest?.status === 'discarded' || latest?.projectId !== project.id ? undefined : latest
    // What a human added to the plan's Drafts stays, whatever the revision says
    const allPreviousEpics = previous ? await this.#epicsOf(previous) : new Map<string, string>()
    const previousEpics = new Map([...allPreviousEpics].filter(([key]) => !key.startsWith(HUMAN_PLAN_KEY)))
    const { existing: parentEpics, promoted } = await this.#resolveParents(project, proposed, previousEpics)
    // A lone epic that was renamed is the same epic, so its tasks aren't changed
    const renamed = proposed.epics.length === 1 && previousEpics.size === 1 && parentEpics.size === 0
    const previousTasks = previous ? (await this.#proposedTasksOf(previous, project)).filter(t => !t.key.startsWith(HUMAN_PLAN_KEY)).map(t => renamed && t.epic ? { ...t, epic: proposed.epics[0]!.key } : t) : []
    const changes = new Map(diffPlans(previousTasks, proposed.tasks).map(c => [c.key, c.change]))
    const previousEpicRows = previous ? await db.select().from(planEpics).where(eq(planEpics.planId, previous.id)) : []
    for (const epic of proposed.epics) {
      epic.dependsOn ??= previousEpicRows.find(e => e.key === epic.key)?.dependsOn ?? []
    }
    const context = await this.#dependencyContext(project, proposed, previous)
    const problems = checkPlan(proposed, found, designs, context)
    if (problems.length > 0) throw new ToolError(`The plan was not saved: ${JSON.stringify(problems)}. Fix every problem and call ${toolName('propose_plan')} again.`)

    const plan = await db.transaction(async (tx) => {
      // A tool already past the orchestrator's fence can still be in flight
      // when close stops its run. Serialize its writes with the close.
      const [current] = await tx.select().from(planSessions).where(eq(planSessions.id, session.id)).for('update')
      const [active] = await tx.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.id, runId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
      if (current!.closedAt || !active) throw new ToolError('This Plan turn has stopped; the plan was not saved.')
      // Each epic the revision still names keeps its row; a lone epic is
      // kept even if its key changed
      const epicIds = new Map<string, string>()
      for (const epic of proposed.epics) {
        const current = parentEpics.get(epic.key) ?? (renamed ? [...previousEpics.values()][0] : previousEpics.get(epic.key))
        // A revision that leaves the mode out keeps the epic's; a new epic
        // without one takes the project's default (D27)
        if (current) {
          const [row] = await tx.select().from(epics).where(eq(epics.id, current)).for('update')
          if (epic.reviewMode && epic.reviewMode !== row!.reviewMode) {
            const taskRows = await tx.select({ status: tasks.status, prNumber: tasks.prNumber, integrationProtocol: tasks.integrationProtocol }).from(tasks).where(eq(tasks.epicId, current))
            if (reviewModeLocked(row!, taskRows)) throw new ToolError('The plan was not saved: the review mode can\'t change once a subtask in the task has submitted work or opened a PR.')
            // Only an epic still being planned is the plan's to set: its tasks are all Drafts
            const live = previous?.status === 'approved' || taskRows.some(t => t.status !== 'draft')
            if (live && lowersMode(row!.reviewMode, epic.reviewMode)) throw new ToolError(`The plan was not saved: it would lower ${row!.title} to ${reviewModeName(epic.reviewMode)} review. Use ${toolName('update_parent')}, which asks the human.`)
          }
          await tx.update(epics).set({ title: epic.title, description: epic.summary, ...(epic.reviewMode && { reviewMode: epic.reviewMode }), updatedAt: new Date() }).where(eq(epics.id, current))
          await syncParentContent(tx, current, { title: epic.title, description: epic.summary })
          epicIds.set(epic.key, current)
        } else {
          // A task to promote is linked now and changes only on approval
          epicIds.set(epic.key, await createDelivery(tx, project, { taskId: promoted.get(epic.key) ?? null, title: epic.title, description: epic.summary, reviewMode: epic.reviewMode }, actor))
        }
      }
      if (previous) await tx.update(plans).set({ status: 'superseded' }).where(eq(plans.id, previous.id))
      const [row] = await tx.insert(plans).values({
        sessionId: session.id, projectId: project.id, epicId: proposed.epics[0] ? epicIds.get(proposed.epics[0].key)! : null, version: (latest?.version ?? 0) + 1, title: proposed.title, summary: proposed.summary
      }).returning()
      const planId = row!.id
      if (proposed.epics.length > 0) {
        await tx.insert(planEpics).values(proposed.epics.map((epic, position) => ({ planId, key: epic.key, epicId: epicIds.get(epic.key)!, dependsOn: epic.dependsOn ?? [], position })))
      }
      const humanEpics = [...allPreviousEpics].filter(([key]) => key.startsWith(HUMAN_PLAN_KEY))
      if (humanEpics.length > 0) await tx.insert(planEpics).values(humanEpics.map(([key, epicId], i) => ({ planId, key, epicId, position: proposed.epics.length + i })))
      const epicOf = (task: ProposedTask) => task.epic ? epicIds.get(task.epic)! : null
      const pinOf = (task: ProposedTask) => task.design ? { designVersionId: versionIds.get(designPinKey(task.design))!, screens: task.design.screens } : null

      // The previous version's tasks by key, and of those, the Drafts it
      // created (not the tasks it only revised)
      const allPreviousItems = previous
        ? await tx.select().from(planTasks).where(and(eq(planTasks.planId, previous.id), ne(planTasks.change, 'removed')))
        : []
      const previousItems = allPreviousItems.filter(r => !r.key.startsWith(HUMAN_PLAN_KEY))
      const humanItems = allPreviousItems.filter(r => r.key.startsWith(HUMAN_PLAN_KEY))
      const existing = new Map<string, string>()
      for (const r of previousItems) if (r.taskId && !r.revision) existing.set(r.key, r.taskId)
      const owned = new Set(existing.values())
      // Create or update in dependency order isn't needed: dependencies are
      // set in a second pass once every task has a number
      const ids = new Map<string, string>()
      const revising = new Set<string>()
      for (const task of proposed.tasks) {
        const target = task.ref ? targets.get(task.ref)! : null
        // A task an earlier approved version put on the board or in the
        // Backlog is revised like any other
        if (target && (target.status !== 'draft' || !owned.has(target.id))) {
          // Staged below, once every dependency has a number
          ids.set(task.key, target.id)
          revising.add(task.key)
          continue
        }
        // A ref to one of this plan's own Drafts is that Draft
        const current = target?.id ?? existing.get(task.key)
        const input = {
          title: task.title,
          description: markdownToRichText(task.description),
          implementationPlan: optionalMarkdownToRichText(task.implementationPlan),
          type: task.type,
          priority: task.priority,
          humanReview: task.humanReview,
          acceptanceCriteria: task.acceptanceCriteria
        }
        if (current) {
          const [row] = await tx.select().from(tasks).where(and(eq(tasks.id, current), isNull(tasks.deletedAt)))
          if (row && row.status === 'draft') {
            await patchTask(tx, project, current, { ...input, acceptanceCriteria: await keepCriterionIds(tx, current, task.acceptanceCriteria) }, actor)
            await setDesignPin(tx, current, pinOf(task))
            ids.set(task.key, current)
            continue
          }
          if (row) {
            // Already on the board or in the Backlog: the plan can't change it
            ids.set(task.key, current)
            continue
          }
        }
        const created = await createTask(tx, project, { ...input, epicId: epicOf(task) }, actor, { draft: true })
        await setDesignPin(tx, created, pinOf(task))
        ids.set(task.key, created)
      }
      const numbers = new Map<string, number>()
      for (const [key, id] of ids) {
        const [row] = await tx.select({ number: tasks.number, status: tasks.status }).from(tasks).where(eq(tasks.id, id))
        numbers.set(key, row!.number)
      }
      // A dependency is a key in the plan, the ref of a task it revises, or
      // any other task in the project
      const keyOfRef = new Map(proposed.tasks.filter(t => t.ref).map(t => [t.ref!, t.key]))
      const numberOf = (dep: string) => numbers.get(dep) ?? numbers.get(keyOfRef.get(dep) ?? '') ?? targets.get(dep)!.number
      const revisions = new Map<string, PlanRevision>()
      for (const task of proposed.tasks) {
        const dependsOn = task.dependsOn.map(numberOf)
        if (revising.has(task.key)) {
          revisions.set(task.key, {
            title: task.title,
            description: task.description,
            ...(task.implementationPlan && { implementationPlan: task.implementationPlan }),
            type: task.type,
            priority: task.priority,
            humanReview: task.humanReview,
            acceptanceCriteria: task.acceptanceCriteria,
            epicId: epicOf(task),
            dependsOn,
            design: pinOf(task)
          })
          const lowered = await revisionLowers(tx, ids.get(task.key)!, revisions.get(task.key)!)
          if (lowered) throw new ToolError(`The plan was not saved: for ${task.ref}, ${lowered}`)
          continue
        }
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, ids.get(task.key)!))
        if (row?.status !== 'draft') continue
        await patchTask(tx, project, ids.get(task.key)!, { dependsOn, epicId: epicOf(task) }, actor)
      }
      // Removed Drafts are deleted outright (D10). A revised task the plan
      // drops is only un-staged: it was never changed.
      // A Draft the plan now makes a parent stays too
      const kept = new Set([...ids.values(), ...promoted.values()])
      for (const [, taskId] of existing) {
        if (kept.has(taskId)) continue
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
        if (row?.status === 'draft') await deleteTaskRows(tx, taskId, actor, 'Removed from the plan')
      }
      // So are epics the revision dropped, once nothing is left in them
      for (const epicId of previousEpics.values()) {
        if ([...epicIds.values()].includes(epicId)) continue
        const [left] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).limit(1)
        if (!left) await deleteEpicWithParent(tx, epicId)
      }
      for (const epicId of epicIds.values()) await collapseUnstartedParent(tx, epicId)
      await this.#checkPromotions(tx, project, promoted, epicIds)
      const dropped = previousItems.filter(r => !ids.has(r.key) && !(r.taskId && kept.has(r.taskId)))
      await insertPlanTasks(tx, [
        ...proposed.tasks.map((task, position): PlanTaskWrite => {
          const change = changes.get(task.key) ?? 'added'
          if (change === 'removed') throw new Error('A proposed task cannot be removed')
          return { planId, key: task.key, taskId: ids.get(task.key)!, change, position, revision: revisions.get(task.key) ?? null }
        }),
        ...dropped.map((r, i) => ({ planId, key: r.key, taskId: r.revision ? r.taskId : null, change: 'removed' as const, position: proposed.tasks.length + i })),
        ...humanItems.flatMap((r, i) => r.taskId ? [{ planId, key: r.key, taskId: r.taskId, change: 'unchanged' as const, revision: null, position: proposed.tasks.length + dropped.length + i }] : [])
      ])
      await insertMessage(tx, session.id, { role: 'pm', kind: 'message', text: proposed.summary || `Proposed plan v${row!.version}: ${proposed.title}` }, { planId, runId })
      await appendAudit(tx, { projectId: project.id, actor }, auditEvent('plan.proposed', { planId, version: row!.version, tasks: proposed.tasks.length, revises: revisions.size }))
      return row!
    })

    const full = await this.toPlan(plan)
    this.#d.events.publish({ type: 'plan.updated', plan: full })
    const planned = new Set(full.epics.map(e => e.id))
    for (const epic of await listEpics(db, project)) {
      if (planned.has(epic.id)) this.#d.events.publish({ type: 'epic.updated', epic })
    }
    const [message] = await db.select().from(planMessages).where(eq(planMessages.planId, plan.id))
    if (message) this.#d.sessions.messageSaved(message)
    // The session now needs approval: its Inbox item moves up (D11)
    await this.#d.sessions.publish(session.id, runId)
    await this.#publishTasks(full)
    await this.publishDrafts(project.id)
    return { ok: true, planId: plan.id, version: plan.version, tasks: full.tasks.map(t => ({ key: t.key, ref: t.ref, change: t.change, revises: t.revises })), message: 'The plan is saved and shown to the human for approval. Tell them what you proposed and why.' }
  }

  // Approve plan (design/plan.md): human only. Its Drafts go to the board
  // (Ready) or to the Backlog for later or for refining. Tasks it revises
  // get their staged edits first, then go the same way, except that a revised
  // Ready task stays in Ready.
  // `via` is the PM run that carried out the human's say-so in chat
  async approve(planId: string, actor: Actor, to: 'ready' | 'backlog' = 'ready', via: { runId: string } | null = null): Promise<Plan> {
    requireHuman(actor, () => new ApiFailure(409, { code: 'transition_rejected', reason: { code: 'actor_not_allowed', actor: null, event: 'approve' } }))
    const { db } = this.#d
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId))
    if (!plan) throw notFound()
    if (plan.status !== 'proposed') throw new ApiFailure(409, { code: 'conflict', constraint: `plan_${plan.status}` })
    const [project] = await db.select().from(projects).where(eq(projects.id, plan.projectId))
    if (!project) throw notFound()
    const items = await db.select().from(planTasks).where(and(eq(planTasks.planId, planId), ne(planTasks.change, 'removed')))
    const proposed = await this.#planProposal(plan, project)
    await withInvalidatedEpics(db, this.#d.events, invalidatedEpics => db.transaction(async (tx) => {
      await tx.select().from(planSessions).where(eq(planSessions.id, plan.sessionId)).for('update')
      const [current] = await tx.select().from(plans).where(eq(plans.id, planId)).for('update')
      if (current?.status !== 'proposed') throw new ApiFailure(409, { code: 'conflict', constraint: `plan_${current?.status}` })
      // A revised task someone has since claimed, moved on or deleted can't
      // take the plan's edits; nothing is written then. The lock holds off a
      // claim until these edits are in.
      const refused: { code: string, key: string, ref: string, message: string }[] = []
      for (const item of items) {
        if (!item.taskId || !item.revision) continue
        const [row] = await tx.select({ status: tasks.status, leaseRunId: tasks.leaseRunId, deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, item.taskId)).for('update')
        const ref = proposed.tasks.find(t => t.key === item.key)?.ref ?? item.key
        const found: PlanRef = row && !row.deletedAt ? { kind: 'task', status: row.status, pickedUp: await pickedUp(tx, item.taskId, row.leaseRunId) } : { kind: 'deleted' }
        const problem = revisionProblem(item.key, ref, found)
        if (problem) refused.push({ code: problem.code, key: item.key, ref, message: 'message' in problem ? problem.message : `${ref} can't be revised.` })
        const lowered = !problem && await revisionLowers(tx, item.taskId, item.revision)
        if (lowered) refused.push({ code: 'lowers_gate', key: item.key, ref, message: `For ${ref}, ${lowered}` })
      }
      if (refused.length) throw new ApiFailure(409, { code: 'plan_not_approvable', problems: refused })
      const problems = checkPlanEpicDependencies(proposed, await this.#dependencyContext(project, proposed, plan, tx))
      if (problems.length) throw new ApiFailure(409, { code: 'invalid_dependencies', problems })

      for (const item of items) {
        if (!item.taskId) continue
        if (item.revision) await reviseTask(tx, project, item.taskId, item.revision, { planId, version: plan.version }, actor, invalidatedEpics)
        const [row] = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, item.taskId), isNull(tasks.deletedAt)))
        if (row?.status === 'draft') await transitionTask(tx, item.taskId, { type: to === 'ready' ? 'approve' : 'accept' }, actor, { invalidatedEpics })
        // Revised Backlog tasks, and plans proposed before Drafts existed
        else if (row?.status === 'backlog' && to === 'ready') await transitionTask(tx, item.taskId, { type: 'approve' }, actor, { invalidatedEpics })
      }
      const epicIds = await this.#epicsOf(plan, tx)
      for (const epicId of epicIds.values()) await this.#promote(tx, project, epicId, actor)
      for (const epic of proposed.epics) {
        const epicId = epicIds.get(epic.key)!
        await replaceEpicDependencies(tx, project.id, epicId, (epic.dependsOn ?? []).map(dep => epicIds.get(dep) ?? dep))
      }
      // Approving the plan closes its session
      const now = new Date()
      await recordApproval(tx, planId, { approvedBy: actor, approvedAt: now })
      await tx.update(planSessions).set({ closedAt: now }).where(eq(planSessions.id, plan.sessionId))
    }))
    await appendAudit(db, { projectId: plan.projectId, actor }, auditEvent('plan.approved', { planId, version: plan.version, to, ...(via && { viaPmRun: via.runId }) }))
    const full = await this.toPlan((await db.select().from(plans).where(eq(plans.id, planId)))[0]!)
    this.#d.events.publish({ type: 'plan.updated', plan: full })
    await this.#publishTasks(full)
    await this.#d.sessions.publish(plan.sessionId)
    await this.publishDrafts(plan.projectId)
    this.#d.wake(full.tasks.flatMap(t => t.taskId ? [t.taskId] : []))
    return full
  }

  // Discard plan: human only. The Drafts it created are deleted outright
  // (D10); tasks it only revised keep what they have, and a Draft revised
  // from another session goes back to that session.
  async discard(planId: string, actor: Actor): Promise<Plan> {
    requireHuman(actor, () => new ApiFailure(409, { code: 'conflict', constraint: 'plan_discard_human_only' }))
    const { db, events } = this.#d
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId))
    if (!plan) throw notFound()
    if (plan.status !== 'proposed') throw new ApiFailure(409, { code: 'conflict', constraint: `plan_${plan.status}` })
    const items = await db.select().from(planTasks).where(and(eq(planTasks.planId, planId), ne(planTasks.change, 'removed')))
    const deleted: string[] = []
    for (const item of items) {
      if (!item.taskId || item.revision) continue
      const [row] = await db.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.id, item.taskId), isNull(tasks.deletedAt)))
      if (row?.status !== 'draft') continue
      await deleteTaskRows(db, item.taskId, actor, 'Plan discarded')
      deleted.push(item.taskId)
    }
    // So are its epics, once nothing is left in them
    for (const epicId of (await this.#epicsOf(plan)).values()) {
      const [left] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).limit(1)
      if (!left) await db.transaction(tx => deleteEpicWithParent(tx, epicId))
    }
    await db.update(plans).set({ status: 'discarded' }).where(eq(plans.id, planId))
    await appendAudit(db, { projectId: plan.projectId, actor }, auditEvent('plan.discarded', { planId, version: plan.version, deleted: deleted.length }))
    for (const taskId of deleted) events.publish({ type: 'task.deleted', taskId, projectId: plan.projectId })
    const full = await this.toPlan((await db.select().from(plans).where(eq(plans.id, planId)))[0]!)
    events.publish({ type: 'plan.updated', plan: full })
    await this.#publishTasks(full)
    await this.#d.sessions.publish(plan.sessionId)
    await this.publishDrafts(plan.projectId)
    return full
  }

  // The plan's tasks that still exist, e.g. after approval moves them on
  async #publishTasks(plan: Plan): Promise<void> {
    const ids = plan.tasks.flatMap(t => t.taskId ? [t.taskId] : [])
    const loaded = await loadTasks(this.#d.db, ids)
    const parents = [...new Set(loaded.flatMap(t => t.parentTask ? [t.parentTask.id] : []))]
    for (const task of [...loaded, ...await loadTasks(this.#d.db, parents)]) this.#d.events.publish({ type: 'task.updated', task })
  }

  async toPlan(row: PlanRow): Promise<Plan> {
    return (await this.toPlans([row]))[0]!
  }

  // Plans of one project, such as a session's versions
  async toPlans(rows: PlanRow[]): Promise<Plan[]> {
    if (rows.length === 0) return []
    const { db } = this.#d
    const planIds = rows.map(r => r.id)
    const projectId = rows[0]!.projectId
    const [[project], itemRows, snapshotRows, allEpics] = await Promise.all([
      db.select({ prefix: projects.prefix }).from(projects).where(eq(projects.id, projectId)),
      db.select({
        item: planTasks,
        task: { id: tasks.id, number: tasks.number, epicId: tasks.epicId, title: tasks.title, description: tasks.description, implementationPlan: tasks.implementationPlan, status: tasks.status, priority: tasks.priority, humanReview: tasks.humanReview }
      }).from(planTasks).leftJoin(tasks, eq(tasks.id, planTasks.taskId))
        .where(inArray(planTasks.planId, planIds)).orderBy(asc(planTasks.position)),
      db.select().from(planEpics).where(inArray(planEpics.planId, planIds)).orderBy(asc(planEpics.position)),
      db.select({ id: epics.id, title: epics.title, reviewMode: epics.reviewMode }).from(epics).where(eq(epics.projectId, projectId))
    ])
    const ids = [...new Set(itemRows.flatMap(i => i.task ? [i.task.id] : []))]
    const depRows = ids.length > 0
      ? await db.select({ taskId: taskDependencies.taskId, number: tasks.number }).from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId)).where(inArray(taskDependencies.taskId, ids))
      : []
    const itemsOf = Map.groupBy(itemRows, i => i.item.planId)
    const snapshotsOf = Map.groupBy(snapshotRows, e => e.planId)
    const deps = Map.groupBy(depRows, d => d.taskId)
    const epicOf = new Map(allEpics.map(e => [e.id, e]))
    return rows.map((row) => {
      const snapshots = snapshotsOf.get(row.id) ?? []
      const keyed = epicKeys(row, snapshots)
      const items = itemsOf.get(row.id) ?? []
      const dependenciesOf = (key: string) => (snapshots.find(e => e.key === key)?.dependsOn ?? []).map((dep) => {
        const id = keyed.get(dep) ?? dep
        return { id, title: epicOf.get(id)?.title ?? dep }
      })
      return {
        id: row.id,
        sessionId: row.sessionId,
        projectId: row.projectId,
        epicId: row.epicId,
        version: row.version,
        title: row.title,
        summary: row.summary,
        status: row.status,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        epics: [...keyed].flatMap(([key, id]) => {
          const epic = epicOf.get(id)
          return epic ? [{ key, id, title: epic.title, reviewMode: epic.reviewMode, dependsOn: dependenciesOf(key) }] : []
        }),
        // A revised task shows the plan's staged edits, not what it has now
        tasks: items.map(({ item, task }) => ({
          key: item.key,
          change: item.change,
          revises: Boolean(item.revision),
          taskId: task?.id ?? null,
          epicId: item.revision ? item.revision.epicId : task?.epicId ?? null,
          ref: task && project ? taskRef(project.prefix, task.number) : null,
          title: item.revision?.title ?? task?.title ?? item.key,
          description: item.revision ? item.revision.description : richTextToMarkdown(task?.description ?? null),
          implementationPlan: item.revision ? item.revision.implementationPlan ?? '' : richTextToMarkdown(task?.implementationPlan ?? null),
          status: task?.status ?? null,
          priority: item.revision?.priority ?? task?.priority ?? 'medium',
          humanReview: item.revision?.humanReview ?? task?.humanReview ?? false,
          dependsOn: item.revision
            ? item.revision.dependsOn.map(n => taskRef(project!.prefix, n))
            : (task ? deps.get(task.id) ?? [] : []).map(d => taskRef(project!.prefix, d.number))
        })),
        createdAt: row.createdAt.toISOString()
      }
    })
  }

  async #proposedTasksOf(plan: PlanRow, project: ProjectRow): Promise<ProposedTask[]> {
    const full = await this.toPlan(plan)
    const keyOf = new Map([...await this.#epicsOf(plan)].map(([key, id]) => [id, key]))
    const keys = new Map(full.tasks.filter(t => t.ref).map(t => [t.ref!, t.key]))
    const revisions = new Map((await this.#d.db.select().from(planTasks).where(eq(planTasks.planId, plan.id))).map(r => [r.key, r.revision]))
    const pinIds = [...revisions.values()].flatMap(r => r?.design ? [r.design.designVersionId] : [])
    const pinned = pinIds.length > 0
      ? await this.#d.db.select({ id: designVersions.id, version: designVersions.version, number: tasks.number }).from(designVersions)
          .innerJoin(tasks, eq(tasks.id, designVersions.taskId)).where(inArray(designVersions.id, pinIds))
      : []
    const pinOf = (pin: { designVersionId: string, screens: string[] } | null | undefined): DesignPin | undefined => {
      const row = pin && pinned.find(p => p.id === pin.designVersionId)
      return row ? { taskRef: taskRef(project.prefix, row.number), version: row.version, screens: pin.screens } : undefined
    }
    const result: ProposedTask[] = []
    for (const item of full.tasks) {
      if (item.change === 'removed' || !item.taskId) continue
      const revision = revisions.get(item.key)
      if (revision) {
        result.push({
          ...revision,
          design: pinOf(revision.design),
          key: item.key,
          ref: item.ref!,
          epic: revision.epicId ? keyOf.get(revision.epicId) ?? revision.epicId : undefined,
          dependsOn: revision.dependsOn.map(n => taskRef(project.prefix, n)).map(ref => keys.get(ref) ?? ref)
        })
        continue
      }
      const [task] = await loadTasks(this.#d.db, [item.taskId])
      if (!task) continue
      result.push({
        key: item.key,
        epic: task.epicId ? keyOf.get(task.epicId) ?? task.epicId : undefined,
        title: task.title,
        description: richTextToMarkdown(task.description),
        ...(task.implementationPlan ? { implementationPlan: richTextToMarkdown(task.implementationPlan) } : {}),
        type: task.type,
        priority: task.priority,
        humanReview: task.humanReview,
        acceptanceCriteria: task.acceptanceCriteria.map(c => c.checkedByHuman ? { text: c.text, checkedByHuman: true } : c.text),
        dependsOn: task.dependsOn.map(ref => keys.get(ref) ?? ref),
        design: task.design ?? undefined
      })
    }
    return result
  }

  // Looks up every existing-task ref the plan names, for checkPlan, and the
  // tasks the valid ones point at
  async #lookupRefs(project: ProjectRow, plan: ProposedPlan): Promise<{ found: Map<string, PlanRef>, targets: Map<string, RefTarget> }> {
    const { db } = this.#d
    const keys = new Set(plan.tasks.map(t => t.key))
    const names = new Set([
      ...plan.tasks.flatMap(t => t.ref ? [t.ref] : []),
      ...plan.tasks.flatMap(t => t.dependsOn.filter(dep => !keys.has(dep) && TASK_REF_PATTERN.test(dep)))
    ])
    const found = new Map<string, PlanRef>()
    const targets = new Map<string, RefTarget>()
    const [current] = await db.select({ nextTaskNumber: projects.nextTaskNumber }).from(projects).where(eq(projects.id, project.id))
    for (const name of names) {
      const ref = parseTaskRef(name)
      if (!ref) {
        found.set(name, { kind: 'unknown' })
        continue
      }
      const { prefix, number } = ref
      if (prefix !== project.prefix) {
        const [other] = await db.select({ name: projects.name }).from(projects).where(eq(projects.prefix, prefix))
        found.set(name, other ? { kind: 'other_project', project: other.name } : { kind: 'unknown' })
        continue
      }
      const [row] = await db.select({ id: tasks.id, number: tasks.number, status: tasks.status, leaseRunId: tasks.leaseRunId, deletedAt: tasks.deletedAt }).from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.number, number)))
      if (row && !row.deletedAt) {
        found.set(name, { kind: 'task', status: row.status, pickedUp: await pickedUp(db, row.id, row.leaseRunId) })
        targets.set(name, { id: row.id, number: row.number, status: row.status })
      } else {
        // Backlog tasks are deleted outright, but their number stays used
        found.set(name, row || (number > 0 && number < (current?.nextTaskNumber ?? 0)) ? { kind: 'deleted' } : { kind: 'unknown' })
      }
    }
    return { found, targets }
  }

  // Looks up every design version the plan pins, for checkPlan, and the IDs
  // of the ones that exist. Only this project's design tasks count.
  async #lookupDesigns(project: ProjectRow, plan: ProposedPlan): Promise<{ found: Map<string, DesignPinTarget>, versionIds: Map<string, string> }> {
    const { db } = this.#d
    const found = new Map<string, DesignPinTarget>()
    const versionIds = new Map<string, string>()
    for (const task of plan.tasks) {
      if (!task.design) continue
      const key = designPinKey(task.design)
      if (found.has(key)) continue
      const row = await taskByRef(db, project, task.design.taskRef)
      if (!row) {
        found.set(key, { kind: 'unknown' })
        continue
      }
      if (row.type !== 'design') {
        found.set(key, { kind: 'not_design', status: row.status })
        continue
      }
      const [version] = await db.select({ id: designVersions.id, status: designVersions.status }).from(designVersions)
        .where(and(eq(designVersions.taskId, row.id), eq(designVersions.version, task.design.version)))
      found.set(key, version ? { kind: 'version', status: version.status } : { kind: 'unknown' })
      if (version) versionIds.set(key, version.id)
    }
    return { found, versionIds }
  }

  // Resolves refs on a plan's parents (D31): existing parents by their
  // delivery record, and the tasks to promote once the plan is approved. Fills
  // in what the PM may leave out, and checks the shape a parent must have.
  async #resolveParents(project: ProjectRow, proposed: ProposedPlan, previousEpics: ReadonlyMap<string, string>): Promise<{ existing: Map<string, string>, promoted: Map<string, string> }> {
    const { db } = this.#d
    const existing = new Map<string, string>()
    const promoted = new Map<string, string>()
    const subTasks = (key: string) => proposed.tasks.filter(t => t.epic === key).length
    for (const parent of proposed.epics) {
      if (parent.ref) {
        const target = await taskByRef(db, project, parent.ref)
        if (!target) throw new ToolError(`The plan was not saved: there is no task ${parent.ref} in this project.`)
        if (isParent(target)) {
          const [delivery] = await db.select().from(epics).where(eq(epics.taskId, target.id))
          existing.set(parent.key, delivery!.id)
          parent.title ||= delivery!.title
          parent.summary ||= delivery!.description
          // Left out, a parent keeps what it waits on
          parent.dependsOn ??= (await db.select({ id: epicDependencies.dependsOnEpicId }).from(epicDependencies).where(eq(epicDependencies.epicId, delivery!.id))).map(d => d.id)
          continue
        }
        const refusal = await promotionRefusal(db, target)
        if (refusal) throw new ToolError(`The plan was not saved: ${parent.ref}: ${refusal}`)
        const [claimed] = await db.select({ id: epics.id }).from(epics).where(eq(epics.taskId, target.id))
        if (claimed && ![...previousEpics.values()].includes(claimed.id)) throw new ToolError(`The plan was not saved: another plan already gives ${parent.ref} subtasks. Wait for that plan, or use it.`)
        promoted.set(parent.key, target.id)
        parent.title ||= target.title
        parent.summary ||= richTextToMarkdown(target.description)
      }
      if (parent.asParent && subTasks(parent.key) < 2) throw new ToolError(`The plan was not saved: ${parent.title || parent.key} needs at least two subtasks. A single unit of work is one task, not a task with one subtask.`)
    }
    // Refs of existing parents, for the delivery records dependencies are stored
    // on. A key in this plan may look like a ref.
    const keys = new Set(proposed.epics.map(e => e.key))
    for (const parent of proposed.epics) {
      if (!parent.dependsOn) continue
      parent.dependsOn = await Promise.all(parent.dependsOn.map(async (dep) => {
        if (keys.has(dep) || !TASK_REF_PATTERN.test(dep)) return dep
        const target = await taskByRef(db, project, dep.toUpperCase())
        const [delivery] = target ? await db.select({ id: epics.id }).from(epics).where(eq(epics.taskId, target.id)) : []
        if (!delivery) throw new ToolError(`The plan was not saved: ${dep} isn't a task with subtasks.`)
        return delivery.id
      }))
    }
    return { existing, promoted }
  }

  // What approving would do to the dependency graph, seen when the plan is
  // proposed: a promoted task's dependencies move to its first sub-task
  async #checkPromotions(tx: Executor, project: ProjectRow, promoted: ReadonlyMap<string, string>, epicIds: ReadonlyMap<string, string>) {
    const changed = new Map<string, string[]>()
    for (const [key, taskId] of promoted) {
      const [first] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, epicIds.get(key)!), isNull(tasks.deletedAt))).orderBy(asc(tasks.number)).limit(1)
      if (!first) continue
      const edges = await tx.select().from(taskDependencies).where(inArray(taskDependencies.taskId, [taskId, first.id]))
      changed.set(taskId, [])
      changed.set(first.id, [...new Set(edges.map(e => e.dependsOnId))].filter(id => id !== first.id))
    }
    if (changed.size === 0) return
    await checkParentCycles(tx, project, { changed, promoting: new Set(promoted.values()) }).catch((error: unknown) => {
      if (error instanceof ApiFailure) throw new ToolError(`The plan was not saved: ${JSON.stringify(error.body)}`)
      throw error
    })
  }

  // The approved plan makes a parent of a task it named. A parent's tasks with
  // no parent row can only be a target that went away: don't lose that quietly.
  async #promote(tx: Executor, project: ProjectRow, epicId: string, actor: Actor) {
    const [row] = await tx.select({ task: tasks }).from(epics).innerJoin(tasks, eq(tasks.id, epics.taskId)).where(eq(epics.id, epicId))
    if (row && isParent(row.task)) return
    const subs = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
    if (!row) {
      if (subs.length > 1) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'The task this plan would give subtasks to has gone. Ask for the plan again.' }] })
      return
    }
    if (!subs[0]) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: `${row.task.title} has no subtasks left to include.` }] })
    await promoteToParent(tx, project, row.task, subs[0].id, actor)
  }

  async #planProposal(plan: PlanRow, project: ProjectRow): Promise<ProposedPlan> {
    const full = await this.toPlan(plan)
    const snapshots = await this.#d.db.select().from(planEpics).where(eq(planEpics.planId, plan.id))
    return { title: plan.title, summary: plan.summary, tasks: await this.#proposedTasksOf(plan, project),
      epics: full.epics.map(e => ({ key: e.key, title: e.title, summary: '', dependsOn: snapshots.find(s => s.key === e.key)?.dependsOn ?? [] })) }
  }

  async #dependencyContext(project: ProjectRow, proposed: ProposedPlan, previous?: PlanRow, db: Executor = this.#d.db): Promise<PlanDependencyContext> {
    const epicRows = await db.select().from(epics).where(eq(epics.projectId, project.id))
    const edges = await db.select().from(epicDependencies).innerJoin(epics, eq(epics.id, epicDependencies.epicId)).where(eq(epics.projectId, project.id))
    const rows = await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)))
    const deps = await db.select().from(taskDependencies).innerJoin(tasks, eq(tasks.id, taskDependencies.taskId)).where(eq(tasks.projectId, project.id))
    const previousItems = previous ? await db.select().from(planTasks).where(and(eq(planTasks.planId, previous.id), ne(planTasks.change, 'removed'))) : []
    const previousEpics = previous ? await this.#epicsOf(previous, db) : new Map<string, string>()
    const renamed = proposed.epics.length === 1 && previousEpics.size === 1
    const taskIds = new Map(previousItems.flatMap(t => t.taskId ? [[t.key, t.taskId] as const] : []))
    const removedDrafts = new Set(previousItems.filter(t => !t.key.startsWith(HUMAN_PLAN_KEY) && !proposed.tasks.some(p => p.key === t.key || p.ref === taskRef(project.prefix, rows.find(r => r.id === t.taskId)?.number ?? 0)) && !t.revision).map(t => t.taskId))
    return {
      epics: new Map(epicRows.map(e => [e.id, edges.filter(d => d.epic_dependencies.epicId === e.id).map(d => d.epic_dependencies.dependsOnEpicId)])),
      titles: new Map(epicRows.map(e => [e.id, e.title])),
      epicIds: new Map(proposed.epics.flatMap((e) => {
        const id = renamed ? [...previousEpics.values()][0] : previousEpics.get(e.key)
        return id ? [[e.key, id] as const] : []
      })),
      taskIds,
      refIds: new Map(rows.map(t => [taskRef(project.prefix, t.number), t.id])),
      tasks: rows.filter(t => t.status !== 'draft' || !removedDrafts.has(t.id)).map(t => ({
        id: t.id, type: t.type, epicId: t.epicId, status: t.status, parentOf: epicRows.find(e => e.taskId === t.id && isParent(t))?.id ?? null,
        dependsOn: deps.filter(d => d.task_dependencies.taskId === t.id).map(d => d.task_dependencies.dependsOnId)
      }))
    }
  }

  // A plan's epics by key, in order. Plans saved before plan_epics have
  // only plans.epicId, under ONLY_EPIC.
  async #epicsOf(plan: PlanRow, db: Executor = this.#d.db): Promise<Map<string, string>> {
    return epicKeys(plan, await db.select().from(planEpics).where(eq(planEpics.planId, plan.id)).orderBy(asc(planEpics.position)))
  }
}

// Each epic key of a plan and the epic it made. Plans saved before plan_epics
// existed have no rows, only plans.epicId.
function epicKeys(plan: Pick<PlanRow, 'epicId'>, rows: (typeof planEpics.$inferSelect)[]): Map<string, string> {
  if (rows.length === 0) return new Map(plan.epicId ? [[ONLY_EPIC, plan.epicId]] : [])
  return new Map(rows.filter(r => r.epicId).map(r => [r.key, r.epicId!]))
}

// Whether an agent holds the task now or has ever run on it
async function pickedUp(db: Executor, taskId: string, leaseRunId: string | null): Promise<boolean> {
  if (leaseRunId) return true
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId)).limit(1)
  return Boolean(run)
}

// Writes a plan's staged edits to the task it revises, keeping criterion IDs
// where the text is unchanged
async function reviseTask(tx: Executor, project: ProjectRow, taskId: string, revision: PlanRevision, plan: { planId: string, version: number }, actor: Actor, invalidatedEpics: InvalidatedEpics): Promise<void> {
  await patchTask(tx, project, taskId, {
    title: revision.title,
    description: markdownToRichText(revision.description),
    implementationPlan: optionalMarkdownToRichText(revision.implementationPlan),
    type: revision.type,
    priority: revision.priority,
    humanReview: revision.humanReview,
    epicId: revision.epicId,
    dependsOn: revision.dependsOn,
    acceptanceCriteria: await keepCriterionIds(tx, taskId, revision.acceptanceCriteria)
  }, actor, { invalidatedEpics })
  // Revisions saved before pins existed leave the task's pin alone
  if (revision.design !== undefined) await setDesignPin(tx, taskId, revision.design)
  await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.revised', { ...plan, fields: ['title', 'description', 'implementationPlan', 'type', 'priority', 'humanReview', 'acceptanceCriteria', 'epicId', 'dependsOn', ...(revision.design !== undefined ? ['design'] : [])] }))
}

async function keepCriterionIds(tx: Executor, taskId: string, texts: (string | { text: string, checkedByHuman?: boolean | undefined })[]) {
  return matchCriteria(await taskCriteria(tx, taskId), texts)
}

// How a revision would lower a gate on the task it revises, or null. A plan
// can raise a gate but never lower one on existing work: that takes
// update_task's confirm card, which names it (D30).
async function revisionLowers(tx: Executor, taskId: string, revision: PlanRevision): Promise<string | null> {
  const [row] = await tx.select({ task: tasks, mode: epics.reviewMode }).from(tasks).leftJoin(epics, eq(epics.id, tasks.epicId)).where(eq(tasks.id, taskId))
  if (!row) return null
  const [epic] = revision.epicId ? await tx.select({ mode: epics.reviewMode }).from(epics).where(eq(epics.id, revision.epicId)) : []
  const criteria = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId))
  const lowered = taskGatesLowered({ ...row.task, mode: row.mode, criteria }, {
    type: revision.type,
    humanReview: revision.humanReview,
    acceptanceCriteria: await keepCriterionIds(tx, taskId, revision.acceptanceCriteria),
    ...(revision.epicId !== row.task.epicId && { movesTo: { mode: epic?.mode ?? null } })
  })
  return lowered.length ? `the plan would ${lowered.join('; ')}. Use ${toolName('update_task')}, which asks the human.` : null
}
