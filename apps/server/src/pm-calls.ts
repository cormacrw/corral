import { storedProjectFields, toolName } from '@corral/contracts'
import { canChangeType, clip, isActiveRun, isPrFree, optionalMarkdownToRichText, statusWords, taskRef } from '@corral/core'
import { schema, type Database, type TaskRow } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { Commands } from './commands.ts'
import type { Controls } from './controls.ts'
import { getEpic } from './epics.ts'
import { ApiFailure } from './errors.ts'
import type { HumanActions } from './human-actions.ts'
import { heldHumanChecks, humanApprovalSummary } from './pm-approval-summary.ts'
import { resetNote } from './pm-decisions.ts'
import { type PmToolCall, type PmToolHandlers, type PreparedPmAction } from './pm-tools.ts'
import { findProjectBySlug } from './projects.ts'
import { newTaskLowersReview, PROJECT_GATES, projectGatesLowered, reviewModeName, lowersMode, taskGatesLowered } from './review-gates.ts'
import type { RunContexts } from './run-context.ts'
import { ToolError } from './tool-error.ts'
import { isProjectRef, taskByRef } from './task-rows.ts'

// The PM's calls that change tasks, parents, projects and the factory: what a
// confirm card proposes and does once the human agrees, and the gated edits
// that act directly unless they lower a gate (D30).

const { epics, projects } = schema

// A card shows what will change, so a clipped value still shows its start
const VALUE_MAX = 80
const shown = (value: unknown) => {
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value)
  return clip(text, VALUE_MAX)
}

// The other changes an edit makes, which the card also names
const others = (changes: Record<string, unknown>, gates: readonly string[]) => Object.entries(changes).filter(([key, value]) => value !== undefined && !gates.includes(key)).map(([key, value]) => `${key} to ${shown(value)}`)

function gateCard(subject: string, lowered: string[], also: string[], target: { id: string, taskId: string | null, projectId: string }): Omit<PreparedPmAction, 'input'> | null {
  if (lowered.length === 0) return null
  return { summary: `Lower the gates on ${subject}: ${lowered.join('; ')}${also.length ? `. Also changes ${also.join(', ')}` : ''}`, targetId: target.id, taskId: target.taskId, projectId: target.projectId }
}

// Deleting a task takes its human gates with it, so the card says which
async function lostByDeleting(db: Database, task: TaskRow): Promise<string> {
  const lost = [...(task.humanReview ? ['its human review'] : []), ...(await heldHumanChecks(db, task.id)).map(c => `the human check "${c.text}"`)]
  return lost.length ? `. This drops ${lost.join(', ')}` : ''
}

export interface PmCallsDeps {
  db: Database
  runs: Pick<RunContexts, 'load'>
  human: Pick<HumanActions, 'deleteTask' | 'deleteProject' | 'stopRun'>
  controls: Pick<Controls, 'holdForUpdate' | 'stopAll' | 'resumeAll' | 'status'>
  commands: Pick<Commands, 'createTask' | 'patchTask' | 'transitionTask' | 'approveTask' | 'addComment' | 'updateParent' | 'patchProject'>
}

type CallTool = 'create_task' | 'update_task' | 'update_parent' | 'update_project' | 'move_task' | 'approve_task' | 'delete_task' | 'delete_project' | 'stop_run' | 'set_update_hold' | 'stop_all' | 'resume_all'

export function pmCalls(deps: PmCallsDeps): Pick<PmToolHandlers, CallTool> {
  const { db, human, controls, commands } = deps

  const updateTask = async ({ input, project, actor }: PmToolCall<'update_task'>) => {
    const { taskRef: ref, paused, parentId, implementationPlan, ...edits } = input
    if (!isProjectRef(project, ref)) throw new ToolError('Use a task ref from this conversation’s project')
    const row = await taskByRef(db, project, ref)
    if (!row) throw new ToolError('Task no longer exists')
    const fields = { ...edits, ...parentId !== undefined && { epicId: parentId }, ...implementationPlan !== undefined && { implementationPlan: optionalMarkdownToRichText(implementationPlan) } }
    const task = await commands.patchTask(project, row.id, fields, actor, {
      paused,
      check: (locked) => {
        if (paused && locked.leaseRunId) throw new ToolError(`Use ${toolName('stop_run')} to stop a leased task with human confirmation`)
        if (fields.type && !canChangeType(locked, fields.type)) throw new ToolError('A task’s type is fixed once it is approved or awaiting merge, and it can’t enter or leave the spike or design type once it has left Draft or Backlog')
      }
    })
    return { result: task, projectId: project.id, target: { taskId: task.id, taskRef: task.ref }, summary: `Updated ${task.ref}: ${task.title}` }
  }

  const createTask = async ({ input, project, actor }: PmToolCall<'create_task'>) => {
    const { parentId, implementationPlan, ...fields } = input
    const task = await commands.createTask(project, { ...fields, implementationPlan: optionalMarkdownToRichText(implementationPlan), epicId: parentId ?? null }, actor)
    return { result: task, projectId: project.id, target: { taskId: task.id, taskRef: task.ref }, summary: `Created ${task.ref}: ${task.title}` }
  }

  const updateParent = async ({ input, project, actor }: PmToolCall<'update_parent'>) => {
    const { parentId: epicId, dependsOn, summary, ...fields } = input
    if ((await getEpic(db, epicId)).projectId !== project.id) throw new ToolError('Use a task with subtasks from this conversation’s project')
    const epic = await commands.updateParent(epicId, { fields: { ...fields, ...(summary !== undefined && { description: summary }) }, dependsOn }, actor)
    return { result: epic, projectId: project.id, summary: `Updated task ${epic.title}` }
  }

  const updateProject = async ({ input: { project: slug, ...neutral }, actor }: PmToolCall<'update_project'>) => {
    const changes = storedProjectFields(neutral)
    const fields = Object.entries(changes).filter(([, value]) => value !== undefined)
    if (fields.length === 0) throw new Error('Nothing to change: pass at least one setting')
    const updated = await commands.patchProject(await findProjectBySlug(db, slug), changes, actor)
    const list = fields.map(([key, value]) => `${key} to ${JSON.stringify(value)}`).join(', ')
    return { result: updated, projectId: updated.id, summary: `Set ${list} on ${updated.name}` }
  }

  // A card for one of the conversation project's tasks
  const taskCard = async ({ input, project }: PmToolCall<'delete_task' | 'approve_task' | 'move_task'>, verb: string, check: (task: TaskRow) => void, detail: (task: TaskRow, ref: string) => Promise<string>): Promise<PreparedPmAction> => {
    if (!isProjectRef(project, input.taskRef)) throw new ToolError(`Use a task ref from ${project.name}`)
    const task = await taskByRef(db, project, input.taskRef)
    if (!task) throw new ToolError(`Task ${input.taskRef} no longer exists`)
    check(task)
    const ref = taskRef(project.prefix, task.number)
    const summary = `${verb} ${ref}${await detail(task, ref)}`
    return { input: { ...input, project: project.slug, taskRef: ref }, summary: 'reason' in input && input.reason ? `${summary} — ${input.reason}` : summary, targetId: task.id, taskId: task.id, projectId: project.id }
  }

  const factoryCard = (summary: string) => async ({ input, session }: PmToolCall<'set_update_hold' | 'stop_all' | 'resume_all'>): Promise<PreparedPmAction> =>
    ({ input, summary, targetId: null, taskId: null, projectId: session.projectId })

  return {
    create_task: {
      goal: 'create a task',
      run: createTask,
      async lowers({ input, project }) {
        const lowered = newTaskLowersReview(project, input) ? [`create it without human review, which ${project.name} has by default`] : []
        return gateCard(`new task "${input.title}"`, lowered, [], { id: project.id, taskId: null, projectId: project.id })
      },
      execute: async call => (await createTask(call)).summary
    },
    update_task: {
      goal: 'change a task',
      run: updateTask,
      async lowers({ input, project }) {
        const { taskRef: ref, paused, parentId, ...edits } = input
        const changes = { ...edits, ...parentId !== undefined && { epicId: parentId } }
        const task = await taskByRef(db, project, ref)
        // Merged work refuses the edit outright
        if (!task || task.status === 'merged') return null
        const modeOf = async (id: string | null) => id ? (await db.select({ mode: epics.reviewMode }).from(epics).where(eq(epics.id, id)))[0]?.mode ?? null : null
        // A task with a PR or submitting to its parent's branch can't move: the edit refuses that itself
        const moves = changes.epicId !== undefined && changes.epicId !== task.epicId && task.prNumber === null && !isPrFree(task)
        const lowered = taskGatesLowered(
          { ...task, mode: await modeOf(task.epicId), criteria: changes.acceptanceCriteria ? await heldHumanChecks(db, task.id) : [] },
          { ...changes, paused, ...(moves && { movesTo: { mode: await modeOf(changes.epicId ?? null) } }) }
        )
        return gateCard(`${taskRef(project.prefix, task.number)}: ${task.title}`, lowered, others({ ...changes, paused: paused || undefined }, ['humanReview']), { id: task.id, taskId: task.id, projectId: project.id })
      },
      execute: async call => (await updateTask(call)).summary
    },
    update_parent: {
      goal: 'change a task with subtasks',
      run: updateParent,
      async lowers({ input, project }) {
        const { parentId: epicId, ...changes } = input
        const epic = await getEpic(db, epicId).catch((error: unknown) => {
          if (error instanceof ApiFailure && error.status === 404) return null
          throw error
        })
        if (epic?.projectId !== project.id) return null
        const lowered = !epic.reviewModeLocked && lowersMode(epic.reviewMode, changes.reviewMode) ? [`change its review mode from ${reviewModeName(epic.reviewMode)} to ${reviewModeName(changes.reviewMode)}`] : []
        return gateCard(`task ${epic.title}`, lowered, others(changes, ['reviewMode']), { id: epic.id, taskId: null, projectId: project.id })
      },
      execute: async call => (await updateParent(call)).summary
    },
    update_project: {
      goal: 'change a project',
      run: updateProject,
      async lowers({ input }) {
        const { project: slug, ...neutral } = input
        const changes = storedProjectFields(neutral)
        const [project] = await db.select().from(projects).where(eq(projects.slug, slug))
        if (!project) return null
        return gateCard(project.name, projectGatesLowered(project, changes), others(changes, PROJECT_GATES), { id: project.id, taskId: null, projectId: project.id })
      },
      execute: async call => `Changed ${(await updateProject(call)).result.name}.`
    },
    move_task: {
      prepare: call => taskCard(call, 'Move', () => undefined, async (task) => {
        const event = call.input.transition
        const destination = event.type === 'resolve' ? event.to : event.type === 'approve' ? 'ready' : event.type === 'human_request_changes' ? 'in_progress' : 'backlog'
        return ` to ${statusWords(destination)}: ${task.title}${event.type === 'human_request_changes' && event.feedback ? ` — Feedback: ${event.feedback}` : ''}${event.type === 'resolve' ? resetNote(task) : ''}`
      }),
      async execute({ input, actor }, prepared) {
        const task = await commands.transitionTask(prepared.taskId!, input.transition, actor)
        if (input.reason) await commands.addComment(task.id, { body: input.reason, pinned: false }, actor)
        return `Moved ${task.ref} to ${statusWords(task.status)}.`
      }
    },
    approve_task: {
      prepare: call => taskCard(call, 'Approve', (task) => {
        if (task.type === 'design') throw new ToolError(`Use ${toolName('approve_design')} to approve a design`)
        if (task.status !== 'human_review') throw new ToolError('Task must be in Human review')
      }, async task => `: ${task.title} (${task.prNumber ? `PR #${task.prNumber} at ` : 'head: '}${task.headSha ?? 'none'})${await humanApprovalSummary(db, task.id)}`),
      async execute({ actor }, prepared) {
        return `Approved ${(await commands.approveTask(prepared.taskId!, actor)).ref}.`
      }
    },
    delete_task: {
      prepare: call => taskCard(call, 'Delete', (task) => {
        if (task.status === 'merged') throw new ToolError('Merged tasks cannot be deleted')
      }, async task => `: ${task.title}${await lostByDeleting(db, task)}`),
      async execute({ input, actor }, prepared) {
        await human.deleteTask(prepared.targetId!, actor, input.reason ?? null)
        return `Deleted ${input.taskRef}.`
      }
    },
    delete_project: {
      async prepare({ input }) {
        const [target] = await db.select().from(projects).where(eq(projects.slug, input.project))
        if (!target) throw new ToolError(`Project ${input.project} no longer exists`)
        return { input, summary: `Remove project ${target.name} (${target.repository}) with all its tasks, runs and Plan sessions`, targetId: target.id, taskId: null, projectId: target.id }
      },
      async execute({ actor }, prepared) {
        await human.deleteProject(prepared.targetId!, actor)
        return 'The project was removed.'
      }
    },
    stop_run: {
      async prepare({ input }) {
        const ctx = await deps.runs.load(input.runId)
        if (!ctx) throw new ToolError('This run no longer exists')
        if (!isActiveRun(ctx.run.state)) throw new ToolError(`Run #${ctx.run.number} isn't live: it's ${ctx.run.state}`)
        const about = ctx.task ? ` on ${taskRef(ctx.project!.prefix, ctx.task.number)}: ${ctx.task.title}` : ctx.project ? ` in ${ctx.project.name}` : ' in a global conversation'
        return { input, summary: `Stop run #${ctx.run.number}, the ${ctx.run.role} run${about}`, targetId: ctx.run.id, taskId: ctx.task?.id ?? null, projectId: ctx.project?.id ?? null }
      },
      async execute({ actor }, prepared) {
        await human.stopRun(prepared.targetId!, actor)
        return 'The run was stopped.'
      }
    },
    set_update_hold: {
      prepare: factoryCard('Hold Corral for an update; after running work drains, all new turns wait until you Lift the hold in the app banner'),
      async execute() {
        const busy = await controls.holdForUpdate()
        return { ...controls.status, busy }
      }
    },
    stop_all: {
      prepare: factoryCard('Stop every run in Corral and start no new ones'),
      async execute({ actor }) {
        await controls.stopAll(actor)
        return 'Corral is stopped.'
      }
    },
    resume_all: {
      prepare: factoryCard('Resume Corral so runs start again'),
      async execute({ actor }) {
        await controls.resumeAll(actor)
        return 'Corral is running again.'
      }
    }
  }
}
