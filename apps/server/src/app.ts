import {
  addCommentInput,
  AVATAR_MAX_BYTES,
  approvePlanInput,
  checkRepoInput,
  createProjectInput,
  createTaskInput,
  humanTransitionInput,
  inboxActionInput,
  patchAgentInput,
  patchEpicInput,
  patchProjectInput,
  patchTaskInput,
  planMessageInput,
  SSE_HEARTBEAT_MS,
  startPlanSessionInput,
  taskListQuery,
  type ApiErrorBody,
  type InboxActionInput,
  type ServerEvent
} from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { zValidator } from '@hono/zod-validator'
import { Hono, type Context, type ValidationTargets } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import type { ZodType } from 'zod'
import { ApiFailure, fromDatabaseError } from './errors.ts'
import { checkAvatar, getProfile, readAvatar, setAgentAvatar, setUserAvatar } from './avatars.ts'
import { getEpic, listEpics, patchEpic } from './epics.ts'
import type { EventBus } from './events.ts'
import { loadInbox } from './inbox.ts'
import { createProject, findProjectBySlug, listProjects, patchProject, toProject } from './projects.ts'
import type { BlobStore } from './blob-store.ts'
import type { Orchestrator } from './orchestrator.ts'
import type { PlanService } from './plan.ts'
import type { RunnerHub } from './runner-hub.ts'
import { getRun, listAgents, listEvidence, listReviews, listRuns, patchAgent } from './runs.ts'
import type { Transcripts } from './transcripts.ts'
import { checkRepository, detectClis, RepoCatalog } from './setup.ts'
import { addComment, createTask, findTaskId, listComments, listHistory, listTasks, loadTask, patchTask, transitionTask } from './tasks.ts'
import { and, eq, isNull } from 'drizzle-orm'

export interface AppDeps {
  db: Database
  events: EventBus
  // Who web requests act as (see owner.ts)
  actor: Actor
  runner: RunnerHub
  orchestrator: Orchestrator
  blobs: BlobStore
  transcripts: Transcripts
  plans: PlanService
}

// Validation failures get the same error shape as every other API error
function validate<T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: result.error.issues } }, 400)
    }
  })
}

const taskNumber = (value: string) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new ApiFailure(404, { code: 'not_found' })
  return number
}

export function createApp({ db, events, actor, runner, orchestrator, blobs, transcripts, plans }: AppDeps) {
  const repos = new RepoCatalog(db, runner)

  const publishTask = async (taskId: string) => {
    const task = await loadTask(db, taskId)
    events.publish({ type: 'task.updated', task })
    return task
  }

  // A task by its ref, e.g. COR-29 (design/task.md page route)
  const findByRef = async (ref: string) => {
    const match = /^([A-Z]{2,5})-(\d+)$/i.exec(ref)
    if (!match) throw new ApiFailure(404, { code: 'not_found' })
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.prefix, match[1]!.toUpperCase()))
    if (!project) throw new ApiFailure(404, { code: 'not_found' })
    return { project, taskId: await findTaskId(db, project.id, Number(match[2])) }
  }

  // design/inbox.md: what the tray does, all through D10 transitions
  const inboxAction = async (taskId: string, input: InboxActionInput) => {
    switch (input.action) {
      case 'clarify': {
        await addComment(db, taskId, { body: input.text, pinned: true }, actor)
        await transitionTask(db, taskId, { type: 'resolve', to: 'in_progress' }, actor)
        break
      }
      case 'send_back': {
        const [row] = await db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, taskId))
        await transitionTask(db, taskId, row?.status === 'ready' ? { type: 'send_back' } : { type: 'resolve', to: 'backlog' }, actor)
        break
      }
      case 'resolve':
        if (input.text) await addComment(db, taskId, { body: input.text, pinned: true }, actor)
        await transitionTask(db, taskId, { type: 'resolve', to: input.to }, actor)
        break
      case 'approve':
        await orchestrator.merges.humanApprove(taskId, actor)
        break
      case 'request_changes':
        await addComment(db, taskId, { body: input.text, pinned: true }, actor)
        await transitionTask(db, taskId, { type: 'human_request_changes' }, actor)
        break
      case 'delete':
        await orchestrator.deleteTask(taskId, actor, input.text ?? null)
        return null
    }
    const task = await publishTask(taskId)
    orchestrator.poke()
    return task
  }

  // The single human (D1 POC); hosting will take this from the session
  const ownerId = () => {
    if (actor.kind !== 'human') throw new ApiFailure(404, { code: 'not_found' })
    return actor.userId
  }
  const publishAgent = async (id: string) => {
    const agent = (await listAgents(db)).find(a => a.id === id)!
    events.publish({ type: 'agent.updated', agent })
    return agent
  }
  // The URL changes with the picture, so a served one never changes
  const serveAvatar = (c: Context, avatar: { data: Uint8Array, type: string } | null) => {
    if (!avatar) throw new ApiFailure(404, { code: 'not_found' })
    return c.body(new Uint8Array(avatar.data), 200, { 'content-type': avatar.type, 'cache-control': 'private, max-age=31536000, immutable' })
  }
  const avatarBodyLimit = bodyLimit({
    maxSize: AVATAR_MAX_BYTES,
    onError: c => c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: [{ path: ['avatar'], message: 'The image is over 2 MB' }] } }, 413)
  })

  return new Hono()
    .basePath('/api')
    .onError((error, c) => {
      const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
      if (failure) return c.json<ApiErrorBody>({ error: failure.body }, failure.status)
      console.error(error)
      return c.json({ error: { code: 'internal' } }, 500)
    })

    .get('/health', c => c.json({ ok: true }))

    .get('/runner', c => c.json(runner.status()))

    .get('/setup/repos', async c => c.json(await repos.list(c.req.query('refresh') === '1')))

    .post('/setup/check-repo', validate('json', checkRepoInput), async c =>
      c.json(await checkRepository(db, runner, c.req.valid('json').repository)))

    .get('/setup/clis', async c => c.json(await detectClis(runner)))

    .get('/projects', async c => c.json(await listProjects(db)))

    .post('/projects', validate('json', createProjectInput), async (c) => {
      const project = await createProject(db, c.req.valid('json'), actor)
      events.publish({ type: 'project.created', project })
      return c.json(project, 201)
    })

    .get('/projects/:slug', async c => c.json(toProject(await findProjectBySlug(db, c.req.param('slug')))))

    .patch('/projects/:slug', validate('json', patchProjectInput), async (c) => {
      const project = await patchProject(db, await findProjectBySlug(db, c.req.param('slug')), c.req.valid('json'), actor)
      events.publish({ type: 'project.updated', project })
      orchestrator.poke()
      return c.json(project)
    })

    .get('/tasks/:ref', async c => c.json(await loadTask(db, (await findByRef(c.req.param('ref'))).taskId)))

    .get('/projects/:slug/epics', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listEpics(db, project))
    })

    .get('/epics/:id', async c => c.json(await getEpic(db, c.req.param('id'))))

    .patch('/epics/:id', validate('json', patchEpicInput), async (c) => {
      const epic = await patchEpic(db, c.req.param('id'), c.req.valid('json'), actor)
      events.publish({ type: 'epic.updated', epic })
      return c.json(epic)
    })

    .get('/projects/:slug/tasks', validate('query', taskListQuery), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listTasks(db, project, c.req.valid('query').view))
    })

    .post('/projects/:slug/tasks', validate('json', createTaskInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const task = await loadTask(db, await createTask(db, project, c.req.valid('json'), actor))
      events.publish({ type: 'task.created', task })
      return c.json(task, 201)
    })

    .get('/projects/:slug/tasks/:number', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await loadTask(db, await findTaskId(db, project.id, taskNumber(c.req.param('number')))))
    })

    .post('/projects/:slug/tasks/:number/transitions', validate('json', humanTransitionInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      await transitionTask(db, taskId, c.req.valid('json'), actor)
      // Published after the commit, so listeners never see a rolled-back state
      const task = await loadTask(db, taskId)
      events.publish({ type: 'task.updated', task })
      // Approval triggers an immediate scheduler check (flows.md step 1)
      orchestrator.poke()
      return c.json(task)
    })

    .patch('/projects/:slug/tasks/:number', validate('json', patchTaskInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      await patchTask(db, project, taskId, c.req.valid('json'), actor)
      return c.json(await publishTask(taskId))
    })

    .delete('/projects/:slug/tasks/:number', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      const body = await c.req.json().catch(() => ({})) as { reason?: string }
      await orchestrator.deleteTask(taskId, actor, body.reason ?? null)
      return c.body(null, 204)
    })

    // Human review → Merged, after the gates are re-checked (design/inbox.md)
    .post('/projects/:slug/tasks/:number/approve', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      await orchestrator.merges.humanApprove(taskId, actor)
      orchestrator.poke()
      return c.json(await publishTask(taskId))
    })

    .get('/projects/:slug/tasks/:number/comments', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listComments(db, await findTaskId(db, project.id, taskNumber(c.req.param('number')))))
    })

    .post('/projects/:slug/tasks/:number/comments', validate('json', addCommentInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      const comment = await addComment(db, taskId, c.req.valid('json'), actor)
      events.publish({ type: 'comment.created', comment })
      return c.json(comment, 201)
    })

    // PRD §14: understand every merge decision
    .get('/projects/:slug/tasks/:number/history', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listHistory(db, await findTaskId(db, project.id, taskNumber(c.req.param('number')))))
    })

    .get('/projects/:slug/tasks/:number/evidence', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listEvidence(db, await findTaskId(db, project.id, taskNumber(c.req.param('number')))))
    })

    .get('/projects/:slug/tasks/:number/reviews', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listReviews(db, await findTaskId(db, project.id, taskNumber(c.req.param('number')))))
    })

    .get('/evidence/:id/file', async (c) => {
      const [row] = await db.select().from(schema.evidence).where(eq(schema.evidence.id, c.req.param('id')))
      const data = row ? await blobs.get(row.blob) : null
      if (!row || !data) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(new Uint8Array(data), 200, {
        'content-type': row.contentType,
        // Blobs are immutable, so they can be cached forever
        'cache-control': 'private, max-age=31536000, immutable',
        'content-disposition': `inline; filename="${row.fileName.replace(/"/g, '')}"`
      })
    })

    .get('/agents', async c => c.json(await listAgents(db)))

    .patch('/agents/:id', validate('json', patchAgentInput), async (c) => {
      const agent = await patchAgent(db, c.req.param('id'), c.req.valid('json'), actor)
      events.publish({ type: 'agent.updated', agent })
      orchestrator.poke()
      return c.json(agent)
    })

    // Profile pictures: the raw image as the body, with its content type
    .put('/agents/:id/avatar', avatarBodyLimit, async (c) => {
      const data = new Uint8Array(await c.req.arrayBuffer())
      await setAgentAvatar(db, blobs, c.req.param('id'), { data, type: checkAvatar(data, c.req.header('content-type')) })
      return c.json(await publishAgent(c.req.param('id')))
    })
    .delete('/agents/:id/avatar', async (c) => {
      await setAgentAvatar(db, blobs, c.req.param('id'), null)
      return c.json(await publishAgent(c.req.param('id')))
    })
    .get('/agents/:id/avatar', async c => serveAvatar(c, await readAvatar(db, blobs, { agentId: c.req.param('id') })))

    .get('/me', async c => c.json(await getProfile(db, ownerId())))
    .put('/me/avatar', avatarBodyLimit, async (c) => {
      const data = new Uint8Array(await c.req.arrayBuffer())
      const profile = await setUserAvatar(db, blobs, ownerId(), { data, type: checkAvatar(data, c.req.header('content-type')) })
      events.publish({ type: 'profile.updated', profile })
      return c.json(profile)
    })
    .delete('/me/avatar', async (c) => {
      const profile = await setUserAvatar(db, blobs, ownerId(), null)
      events.publish({ type: 'profile.updated', profile })
      return c.json(profile)
    })
    .get('/me/avatar', async c => serveAvatar(c, await readAvatar(db, blobs, { userId: ownerId() })))

    // Plan (D9): sessions, turns and approval
    .get('/plan/sessions', async c => c.json(await plans.listSessions()))

    .post('/plan/sessions', validate('json', startPlanSessionInput), async (c) => {
      const input = c.req.valid('json')
      return c.json(await plans.start(input.projectId, { text: input.text, taskRef: input.taskRef }, actor), 201)
    })

    .get('/plan/sessions/:id', async c => c.json(await plans.getSession(c.req.param('id'))))

    .post('/plan/sessions/:id/messages', validate('json', planMessageInput), async (c) => {
      const input = c.req.valid('json')
      return c.json(await plans.message(c.req.param('id'), { text: input.text, taskRef: input.taskRef }, actor), 201)
    })

    .post('/plan/sessions/:id/read', async c => c.json(await plans.markRead(c.req.param('id'))))

    .post('/plan/plans/:id/approve', async (c) => {
      // The body is optional; no body means the board
      const parsed = approvePlanInput.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) throw new ApiFailure(400, { code: 'invalid_input', issues: parsed.error.issues.map(i => ({ path: i.path.map(String), message: i.message })) })
      const plan = await plans.approve(c.req.param('id'), actor, parsed.data.to)
      orchestrator.poke()
      return c.json(plan)
    })

    .get('/inbox', async c => c.json(await loadInbox(db)))

    .post('/inbox/:taskId/actions', validate('json', inboxActionInput), async (c) => {
      const [row] = await db.select({ id: schema.tasks.id }).from(schema.tasks)
        .where(and(eq(schema.tasks.id, c.req.param('taskId')), isNull(schema.tasks.deletedAt)))
      if (!row) throw new ApiFailure(404, { code: 'not_found' })
      const task = await inboxAction(row.id, c.req.valid('json'))
      return c.json({ task })
    })

    // The kill switch (PRD §7.11)
    .get('/status', c => c.json(orchestrator.status))

    .post('/stop-all', async (c) => {
      await orchestrator.stopAll(actor)
      return c.json(orchestrator.status)
    })

    .post('/resume-all', async (c) => {
      await orchestrator.resumeAll(actor)
      return c.json(orchestrator.status)
    })

    // The update hold, for scripts/deploy/auto-deploy.sh
    .post('/update-hold', async c => c.json({ busy: await orchestrator.holdForUpdate() }))

    .delete('/update-hold', (c) => {
      orchestrator.releaseUpdate()
      return c.json(orchestrator.status)
    })

    .get('/runs', async (c) => {
      const agentId = c.req.query('agentId')
      const taskId = c.req.query('taskId')
      return c.json(await listRuns(db, {
        ...(agentId && { agentId }),
        ...(taskId && { taskId }),
        active: c.req.query('active') === '1'
      }))
    })

    .get('/runs/:id', async c => c.json(await getRun(db, c.req.param('id'))))

    .get('/runs/:id/transcript', async (c) => {
      const [row] = await db.select({ blob: schema.runs.transcriptBlob }).from(schema.runs).where(eq(schema.runs.id, c.req.param('id')))
      if (!row) throw new ApiFailure(404, { code: 'not_found' })
      return c.json(await transcripts.read(c.req.param('id'), row.blob))
    })

    .post('/runs/:id/stop', async (c) => {
      await orchestrator.stopRun(c.req.param('id'), actor)
      return c.json(await getRun(db, c.req.param('id')))
    })

    .get('/events', c => streamSSE(c, async (stream) => {
      const send = (event: ServerEvent) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      const unsubscribe = events.subscribe((event) => {
        void send(event)
      })
      // Cloudflare drops proxied connections idle for ~100 s (D12)
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '' })
      }, SSE_HEARTBEAT_MS)
      await stream.writeSSE({ event: 'ready', data: '' })
      await new Promise<void>(resolve => stream.onAbort(resolve))
      clearInterval(heartbeat)
      unsubscribe()
    }))
}

// The Hono typed client (hc) in apps/web is built from this type
export type AppType = ReturnType<typeof createApp>
