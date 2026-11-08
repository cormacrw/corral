import { toWireReviewMode } from '@corral/contracts'
import { approvedPlanSummary, markdownToRichText, richTextToMarkdown, taskRef } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { agentActivity, UnknownAgent } from './agent-activity.ts'
import { attachEvidence, getAttachment, getDesign } from './agent-files.ts'
import { listTaskAttachments } from './attachments.ts'
import { auditText } from './audit.ts'
import type { BlobStore } from './blob-store.ts'
import type { Commands } from './commands.ts'
import { ApiFailure } from './errors.ts'
import { parentFacts } from './parents.ts'
import type { PlanProposals } from './plan-proposals.ts'
import type { PlanSessions } from './plan-sessions.ts'
import type { PmToolHandlers } from './pm-tools.ts'
import { askRecoveryQuestion } from './retry-recovery.ts'
import { findTaskByRef } from './task-rows.ts'
import { loadTask } from './task-views.ts'
import { ToolError } from './tool-error.ts'

// The PM's board tools (flows.md §1): reading the board, commenting,
// questions and plans. None of them approve, merge or change status.

const { agents, auditLog, comments, epicDependencies, epics, plans, runs, taskDependencies, tasks } = schema

export interface PmBoardToolsDeps {
  db: Database
  blobs: BlobStore
  sessions: Pick<PlanSessions, 'post'>
  proposals: Pick<PlanProposals, 'propose' | 'approve'>
  commands: Pick<Commands, 'addComment' | 'createTask'>
}

type BoardTool = 'list_tasks' | 'get_task' | 'add_comment' | 'get_run_outcomes' | 'get_agent_activity' | 'ask_question' | 'propose_plan' | 'approve_plan' | 'flag_stale_docs'
  | 'attach_evidence' | 'get_attachment' | 'get_design'

export function pmBoardTools(deps: PmBoardToolsDeps): Pick<PmToolHandlers, BoardTool> {
  const { db, blobs, sessions, proposals, commands } = deps
  return {
    list_tasks: {
      async run({ input: { status, epic, parent, query, includeMerged }, project }) {
        const statuses = status === undefined ? [] : [status].flat()
        const rows = await db.select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status, type: tasks.type, priority: tasks.priority, epicId: tasks.epicId, humanReview: tasks.humanReview, statusReason: tasks.statusReason, prUrl: tasks.prUrl }).from(tasks)
          .where(and(
            eq(tasks.projectId, project.id),
            isNull(tasks.deletedAt),
            statuses.length > 0 ? inArray(tasks.status, statuses) : includeMerged ? undefined : ne(tasks.status, 'merged')
          ))
          .orderBy(asc(tasks.number))
        const deps = await db.select({ taskId: taskDependencies.taskId, number: tasks.number }).from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
          .where(eq(tasks.projectId, project.id))
        const epicRows = await db.select().from(epics).where(eq(epics.projectId, project.id))
        const epicDeps = await db.select().from(epicDependencies).innerJoin(epics, eq(epics.id, epicDependencies.epicId)).where(eq(epics.projectId, project.id))
        const needle = query?.toLowerCase()
        const facts = await parentFacts(db, project, rows)
        const parentOf = (t: { epicId: string | null }) => t.epicId ? facts.parents.get(t.epicId) ?? null : null
        const matches = rows
          .map(t => ({ ...t, ref: taskRef(project.prefix, t.number) }))
          // In memory: an epic id that isn't a UUID finds nothing here, where Postgres would reject it
          .filter(t => (!epic || t.epicId === epic) && (!parent || parentOf(t)?.ref === parent.toUpperCase()) && (!needle || t.ref.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle)))
          .filter(t => !facts.rollups.get(t.id)?.drafting)
        return {
          result: {
            project: { name: project.name, prefix: project.prefix, defaultBranch: project.defaultBranch, epicReviewModeDefault: project.epicReviewModeDefault },
            epics: epicRows.map(e => ({ id: e.id, title: e.title, reviewMode: e.reviewMode, dependsOn: epicDeps.filter(d => d.epic_dependencies.epicId === e.id).map(d => d.epic_dependencies.dependsOnEpicId) })),
            // `epics` and `epicId` are for runners from before D31
            parents: epicRows.filter(e => e.taskId).map(e => ({ parentId: e.id, ref: rows.find(t => t.id === e.taskId) && taskRef(project.prefix, rows.find(t => t.id === e.taskId)!.number), title: e.title, reviewMode: toWireReviewMode(e.reviewMode), dependsOn: epicDeps.filter(d => d.epic_dependencies.epicId === e.id).map(d => d.epic_dependencies.dependsOnEpicId) })),
            tasks: matches.map(t => ({
              ref: t.ref,
              title: t.title,
              status: t.status,
              type: t.type,
              priority: t.priority,
              epicId: t.epicId,
              ...(t.epicId && { parentId: t.epicId }),
              ...(t.humanReview && { humanReview: true }),
              ...(t.statusReason && { statusReason: t.statusReason }),
              ...(t.prUrl && { pr: t.prUrl }),
              dependsOn: deps.filter(d => d.taskId === t.id).map(d => taskRef(project.prefix, d.number)),
              ...(parentOf(t) && { parent: parentOf(t)!.ref }),
              ...(facts.rollups.has(t.id) && { stage: facts.rollups.get(t.id)!.stage, subTasks: { done: facts.rollups.get(t.id)!.done, total: facts.rollups.get(t.id)!.total } })
            }))
          }
        }
      }
    },

    get_task: {
      async run({ input: { taskRef: ref }, project }) {
        const task = await loadTask(db, (await findTaskByRef(db, project, ref)).id)
        const notes = await db.select().from(comments).where(eq(comments.taskId, task.id)).orderBy(asc(comments.createdAt))
        const [epic] = task.epicId ? await db.select({ id: epics.id, title: epics.title }).from(epics).where(eq(epics.id, task.epicId)) : []
        return {
          result: {
            ...task,
            description: richTextToMarkdown(task.description),
            implementationPlan: richTextToMarkdown(task.implementationPlan),
            epic: epic ?? null,
            comments: notes.map(c => ({ author: c.author.kind, body: c.body, pinned: c.pinned, at: c.createdAt.toISOString() })),
            attachments: await listTaskAttachments(db, project.id, task, notes.map(c => ({ author: c.author.kind, body: c.body, createdAt: c.createdAt })))
          }
        }
      }
    },

    add_comment: {
      async run({ input: { taskRef: ref, body }, project, actor }) {
        await commands.addComment((await findTaskByRef(db, project, ref)).id, { body, pinned: false }, actor)
        return { result: { ok: true } }
      }
    },

    get_run_outcomes: {
      async run({ input: { taskRef: ref }, project }) {
        const task = await findTaskByRef(db, project, ref)
        const rows = await db.select({ run: runs, agent: agents.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId))
          .where(eq(runs.taskId, task.id)).orderBy(desc(runs.number)).limit(20)
        return {
          result: rows.map(({ run, agent }) => ({
            number: run.number, agent, role: run.role, state: run.state, outcome: run.outcome, summary: run.summary, error: run.error,
            startedAt: run.startedAt?.toISOString() ?? null, endedAt: run.endedAt?.toISOString() ?? null
          }))
        }
      }
    },

    get_agent_activity: {
      async run({ input: { agent } }) {
        const result = await agentActivity(db, agent).catch((error: unknown) => {
          throw error instanceof UnknownAgent ? new ToolError(error.message) : error
        })
        return { result }
      }
    },

    ask_question: {
      async run({ input: { question, recommendation, options, retryOptions }, sessionId, runId }) {
        if (retryOptions?.some(choice => ![...(options ?? []), recommendation].includes(choice))) throw new ToolError('retryOptions must name exact answer options or the recommendation.')
        // The session now has a question: its Inbox item moves up (D11)
        const message = await sessions.post(sessionId, { role: 'pm', kind: 'question', text: question, recommendation, options }, { runId, unread: false })
        await askRecoveryQuestion(db, sessionId, message.id, retryOptions ?? [])
        return { result: { ok: true, message: 'The question is shown to the human. Finish your turn; their answer arrives as the next message.' } }
      }
    },

    propose_plan: {
      async run({ input, project, session, runId, actor }) {
        return { result: await proposals.propose(session, project, runId, input, actor) }
      }
    },

    // The human's approval, given in chat and carried out by the PM. It's
    // recorded as the human's, via this run, and only counts if they wrote
    // after the plan was proposed: the PM can't approve a plan unseen. The
    // audit entry is what names the human; the message row doesn't.
    approve_plan: {
      async run({ input: { to }, sessionId, runId }) {
        const [latest] = await db.select().from(plans).where(eq(plans.sessionId, sessionId)).orderBy(desc(plans.version)).limit(1)
        if (!latest || latest.status !== 'proposed') throw new ToolError('There is no plan waiting for approval in this conversation.')
        const [said] = await db.select({ actor: auditLog.actor, createdAt: auditLog.createdAt }).from(auditLog)
          .where(and(eq(auditLog.action, 'plan.message'), sql`${auditText('plan.message', 'sessionId')} = ${sessionId}`))
          .orderBy(desc(auditLog.createdAt)).limit(1)
        if (!said || said.actor.kind !== 'human' || said.createdAt < latest.createdAt) {
          throw new ToolError('Not approved. The human hasn\'t replied since this plan was proposed; only approve when their latest message asks you to.')
        }
        const approved = await proposals.approve(latest.id, said.actor, to, { runId }).catch((error: unknown) => {
          if (error instanceof ApiFailure && error.body.code === 'plan_not_approvable') {
            throw new ToolError(`The plan was not approved and nothing was changed: ${error.body.problems.map(p => p.message).join(' ')} Tell the human, and propose a new version without these revisions.`)
          }
          throw error
        })
        return { result: { ok: true, message: `Plan v${approved.version} approved for the human: ${approvedPlanSummary(approved.tasks)}. Tell them it's done.` } }
      }
    },

    flag_stale_docs: {
      async run({ input: { title, description }, project, actor }) {
        const task = await commands.createTask(project, {
          title,
          type: 'task',
          description: markdownToRichText(description),
          acceptanceCriteria: ['The documentation matches the code it describes']
        }, actor)
        return { result: { ok: true, taskRef: task.ref } }
      }
    },

    // To a task of the project, or to the conversation, shown in the chat
    attach_evidence: {
      async run({ input: { evidence: input, taskRef: ref }, project, sessionId, runId }) {
        if (ref) return { result: await attachEvidence(db, blobs, { runId, task: await findTaskByRef(db, project, ref) }, input) }
        if (input.criterionId) throw new ToolError('Pass taskRef to attach evidence for a criterion')
        const [run] = await db.select({ task: tasks }).from(runs).leftJoin(tasks, eq(tasks.id, runs.taskId)).where(eq(runs.id, runId))
        const attached = await attachEvidence(db, blobs, { runId, task: run?.task ?? null }, input)
        const label = (input.kind === 'note' ? 'Evidence' : input.fileName).replace(/[[\]\\]/g, '')
        await sessions.post(sessionId, { role: 'pm', kind: 'message', text: input.kind === 'note' ? input.note : `${input.note}\n\n[${label}](/api/evidence/${attached.id}/file)` }, { runId, unread: false })
        return { result: attached }
      }
    },

    get_attachment: {
      async run({ input: { attachmentId }, project }) {
        return { result: await getAttachment(db, blobs, project.id, attachmentId) }
      }
    },

    get_design: {
      async run({ input: { taskRef: ref, version }, project }) {
        return { result: await getDesign(db, blobs, project, ref, version) }
      }
    }
  }
}
