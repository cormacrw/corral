import {
  addCommentInput,
  clientPerfInput,
  CLIENT_PERF_MAX_BYTES,
  perfSummaryQuery,
  ATTACHMENT_MAX_BYTES,
  AVATAR_MAX_BYTES,
  approveDesignInput,
  approvePlanInput,
  checkRepoInput,
  createAgentInput,
  createDeploymentInput,
  createProjectInput,
  createTaskInput,
  deleteProjectInput,
  humanTransitionInput,
  flowMetricsQuery,
  inboxActionInput,
  epicReviewActionInput,
  patchAgentInput,
  patchEpicInput,
  setEpicDependenciesInput,
  patchPlanSessionInput,
  patchProfileInput,
  patchProjectInput,
  patchTaskInput,
  planMessageInput,
  runMessageInput,
  SSE_HEARTBEAT_MS,
  startPlanSessionInput,
  taskListQuery,
  uploadAttachmentQuery,
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
import { publishDependents } from './dependent-tasks.ts'
import { apiTiming, type PerformanceSamples } from './performance.ts'
import { ApiFailure, fromDatabaseError } from './errors.ts'
import { checkThumbnail, readThumbnail, THUMBNAIL_MAX_BYTES } from './thumbnails.ts'
import { byteRange } from './byte-range.ts'
import { createAttachment, readAttachment } from './attachments.ts'
import { recordDeployment, updateDeploymentInbox, type ReleaseNotes } from './deployments.ts'
import { flowMetrics } from './flow-metrics.ts'
import { approveDesign, DESIGN_BUNDLE_HEADERS, listDesignVersions, readDesignFile, readDesignScreenshot } from './designs.ts'
import { checkAvatar, getProfile, patchProfile, readAvatar, setAgentAvatar, setUserAvatar } from './avatars.ts'
import { getEpic, listEpics, patchEpic, setEpicDependencies } from './epics.ts'
import type { EventBus } from './events.ts'
import { loadInbox } from './inbox.ts'
import { listPullRequests } from './pull-requests.ts'
import { createProject, findProjectBySlug, listProjects, patchProject, setProjectThumbnail, toProject } from './projects.ts'
import type { BlobStore } from './blob-store.ts'
import type { Orchestrator } from './orchestrator.ts'
import type { PlanService } from './plan.ts'
import type { RunnerHub } from './runner-hub.ts'
import { createAgent, getRun, listAgents, listEvidence, listReviews, listRuns, patchAgent } from './runs.ts'
import type { Transcripts } from './transcripts.ts'
import { checkRepository, detectClis, RepoCatalog, requireRuntimeCli } from './setup.ts'
import { addComment, createTask, findTaskId, listComments, listHistory, listTasks, loadTask, patchTask, transitionTask } from './tasks.ts'
import { and, eq, isNull } from 'drizzle-orm'

// The request path exactly as the client sent it, without the query. The
// Node adapter resolves `..` in the URL before routing, so this reads the
// raw request line when there is one.
function rawPath(c: Context): string {
  const incoming = (c.env as { incoming?: { url?: string } } | undefined)?.incoming?.url
  const path = incoming ?? c.req.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

const DESIGN_FILES = /^\/api\/designs\/([^/]*)\/files\/(.*)$/s

export interface AppDeps {
  performance: PerformanceSamples
  db: Database
  events: EventBus
  // Who web requests act as (see owner.ts)
  actor: Actor
  runner: RunnerHub
  orchestrator: Orchestrator
  blobs: BlobStore
  transcripts: Transcripts
  plans: PlanService
  releaseNotes: ReleaseNotes
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

export function createApp({ db, events, actor, runner, orchestrator, blobs, transcripts, plans, releaseNotes, performance }: AppDeps) {
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
        await transitionTask(db, taskId, { type: 'human_request_changes', feedback: input.text }, actor)
        break
      case 'delete':
        await orchestrator.deleteTask(taskId, actor, input.text ?? null)
        return null
    }
    const task = await publishTask(taskId)
    orchestrator.poke([taskId])
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

  const thumbnailBodyLimit = bodyLimit({
    // Bound parsing memory, including a small multipart envelope.
    maxSize: THUMBNAIL_MAX_BYTES + 64 * 1024,
    onError: c => c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: [{ path: ['file'], message: 'The image is over 2 MB' }] } }, 413)
  })

  const attachmentBodyLimit = bodyLimit({
    maxSize: ATTACHMENT_MAX_BYTES,
    onError: c => c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: [{ path: ['file'], message: 'The image is over 10 MB' }] } }, 413)
  })

  return new Hono()
    .basePath('/api')
    .use('*', apiTiming(performance))
    .onError((error, c) => {
      const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
      if (failure) return c.json<ApiErrorBody>({ error: failure.body }, failure.status)
      console.error(error)
      return c.json({ error: { code: 'internal' } }, 500)
    })

    // A design version's prototype (D20): untrusted HTML, served only with
    // the sandbox CSP so it runs in an opaque origin. Matched on the raw path
    // ahead of every route, so `..` and encoded slashes are refused as sent
    // instead of resolving to some other route.
    .use('*', async (c, next) => {
      const match = c.req.method === 'GET' ? DESIGN_FILES.exec(rawPath(c)) : null
      if (!match) return next()
      c.set('performanceRoute', '/api/designs/:versionId/files/*')
      const file = await readDesignFile(db, blobs, match[1]!, match[2]!)
      if (!file) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(new Uint8Array(file.data), 200, { ...DESIGN_BUNDLE_HEADERS, 'content-type': file.type })
    })

    .post('/perf/client', bodyLimit({
      maxSize: CLIENT_PERF_MAX_BYTES,
      onError: c => c.json({ error: { code: 'invalid_input' } }, 400)
    }), async (c) => {
      // Parse text as well as application/json: sendBeacon can use either.
      const input = clientPerfInput.safeParse(await c.req.json().catch(() => null))
      if (!input.success) return c.json({ error: { code: 'invalid_input' } }, 400)
      const createdAt = new Date()
      for (const sample of input.data.samples) {
        performance.record({ kind: 'page', name: sample.name, metric: sample.metric,
          durationMs: sample.value, sessionId: input.data.sessionId, createdAt })
      }
      return c.body(null, 204)
    })

    .get('/perf/summary', validate('query', perfSummaryQuery), async c =>
      c.json(await performance.summary(c.req.valid('query').window)))

    .get('/health', c => c.json({ ok: true }))

    .post('/runners/:runnerId/update', c => c.json(runner.drain(c.req.param('runnerId'), true)))
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

    .get('/projects/:slug/metrics/flow', validate('query', flowMetricsQuery), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await flowMetrics(db, project, c.req.valid('query').window))
    })

    .put('/projects/:slug/thumbnail', thumbnailBodyLimit, async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const invalid = () => new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['file'], message: 'Provide a multipart file image' }] })
      const form = await c.req.formData().catch(() => {
        throw invalid()
      })
      const files = form.getAll('file')
      const file = files[0]
      if (files.length !== 1 || !(file instanceof File)) throw invalid()
      const data = new Uint8Array(await file.arrayBuffer())
      checkThumbnail(data, file.type)
      const saved = await setProjectThumbnail(db, project, await blobs.put(data), actor)
      events.publish({ type: 'project.updated', project: saved })
      return c.json(saved)
    })
    .get('/projects/:slug/thumbnail', async (c) => {
      const file = await readThumbnail(db, blobs, c.req.param('slug'), c.req.query('v'))
      if (!file) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(new Uint8Array(file.data), 200, {
        'content-type': file.type,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff'
      })
    })
    .delete('/projects/:slug/thumbnail', async (c) => {
      const project = await setProjectThumbnail(db, await findProjectBySlug(db, c.req.param('slug')), null, actor)
      events.publish({ type: 'project.updated', project })
      return c.json(project)
    })

    .patch('/projects/:slug', validate('json', patchProjectInput), async (c) => {
      const project = await patchProject(db, await findProjectBySlug(db, c.req.param('slug')), c.req.valid('json'), actor)
      events.publish({ type: 'project.updated', project })
      orchestrator.poke()
      return c.json(project)
    })

    .get('/tasks/:ref', async c => c.json(await loadTask(db, (await findByRef(c.req.param('ref'))).taskId)))

    .delete('/projects/:slug', validate('json', deleteProjectInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      if (c.req.valid('json').confirm !== project.name) {
        throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['confirm'], message: 'Type the project name to remove it' }] })
      }
      await orchestrator.deleteProject(project.id, actor)
      return c.body(null, 204)
    })

    .get('/projects/:slug/epics', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listEpics(db, project))
    })

    // Drafts by the Plan session they belong to, for the Plan tab (D10)
    .get('/projects/:slug/drafts', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await plans.listDrafts(project.id))
    })

    .post('/epics/:id/review', validate('json', epicReviewActionInput), async c => c.json(await orchestrator.epicPrs.humanAction(c.req.param('id'), c.req.valid('json'), actor)))

    .get('/epics/:id', async c => c.json(await getEpic(db, c.req.param('id'))))

    .put('/epics/:id/dependencies', validate('json', setEpicDependenciesInput), async (c) => {
      const id = c.req.param('id')
      const updated = await setEpicDependencies(db, id, c.req.valid('json').dependsOn, actor)
      for (const epic of updated) events.publish({ type: 'epic.updated', epic })
      const detail = await getEpic(db, id)
      for (const task of detail.tasks) events.publish({ type: 'task.updated', task })
      orchestrator.poke(detail.tasks.map(t => t.id))
      return c.json(updated.find(e => e.id === id)!)
    })

    .patch('/epics/:id', validate('json', patchEpicInput), async (c) => {
      const epic = await patchEpic(db, c.req.param('id'), c.req.valid('json'), actor)
      events.publish({ type: 'epic.updated', epic })
      return c.json(epic)
    })

    .get('/projects/:slug/tasks', validate('query', taskListQuery), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listTasks(db, project, c.req.valid('query').view))
    })

    // Open PRs and their merge gates, live from GitHub
    .get('/projects/:slug/pull-requests', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listPullRequests(db, orchestrator.merges, project))
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
      orchestrator.poke([taskId])
      return c.json(task)
    })

    .patch('/projects/:slug/tasks/:number', validate('json', patchTaskInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      const edit = await patchTask(db, project, taskId, c.req.valid('json'), actor)
      // The edit is saved either way; telling the run is best effort (PRD §7.3)
      if (edit) await orchestrator.noticeTaskEdit(taskId, edit, actor).catch(error => console.error(`Telling the run about the edit to task ${taskId} failed`, error))
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
      orchestrator.poke([taskId])
      return c.json(await publishTask(taskId))
    })

    // Clears a stopped run's pause. The task is what this is about, so it
    // starts right away even inside its agent's wake interval (flows.md §3)
    .post('/projects/:slug/tasks/:number/resume', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      await orchestrator.resumeTask(taskId, actor)
      const task = await publishTask(taskId)
      orchestrator.poke([taskId])
      return c.json(task)
    })

    // A design task's versions (D20), newest first
    .get('/projects/:slug/tasks/:number/designs', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listDesignVersions(db, blobs, await findTaskId(db, project.id, taskNumber(c.req.param('number')))))
    })

    // Approve a design version (D20): it's approved, earlier ones superseded,
    // and a Plan session opens for its build with the human's note. The
    // approval is a PM message, so it needs the runner like any other.
    .post('/projects/:slug/tasks/:number/designs/:version/approve', async (c) => {
      const parsed = approveDesignInput.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) throw new ApiFailure(400, { code: 'invalid_input', issues: parsed.error.issues.map(i => ({ path: i.path.map(String), message: i.message })) })
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      plans.assertTurnPossible()
      const versionId = await approveDesign(db, taskId, taskNumber(c.req.param('version')), actor)
      orchestrator.poke(await publishDependents(db, events, taskId))
      await plans.startDesignBuild(versionId, parsed.data.note || undefined, actor)
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
      c.header('accept-ranges', 'bytes')
      const [row] = await db.select().from(schema.evidence).where(eq(schema.evidence.id, c.req.param('id')))
      // A note has no file
      const data = row?.blob ? await blobs.get(row.blob) : null
      if (!row || !data) throw new ApiFailure(404, { code: 'not_found' })
      const headers = {
        'content-type': row.contentType!,
        // Blobs are immutable, so they can be cached forever
        'cache-control': 'private, max-age=31536000, immutable',
        'content-disposition': `inline; filename="${row.fileName!.replace(/"/g, '')}"`
      }
      const range = byteRange(c.req.header('range'), data.byteLength)
      if (range === 'unsatisfiable') {
        return c.body(null, 416, { ...headers, 'content-range': `bytes */${data.byteLength}`, 'content-length': '0' })
      }
      if (range) {
        const { start, end } = range
        return c.body(new Uint8Array(data.subarray(start, end + 1)), 206, {
          ...headers,
          'content-range': `bytes ${start}-${end}/${data.byteLength}`,
          'content-length': String(end - start + 1)
        })
      }
      return c.body(new Uint8Array(data), 200, { ...headers, 'content-length': String(data.byteLength) })
    })

    .get('/agents', async c => c.json(await listAgents(db)))

    .post('/agents', validate('json', createAgentInput), async (c) => {
      const input = c.req.valid('json')
      await requireRuntimeCli(runner, input.runtime)
      const agent = await createAgent(db, input, actor)
      events.publish({ type: 'agent.updated', agent })
      orchestrator.poke()
      return c.json(agent, 201)
    })

    .patch('/agents/:id', validate('json', patchAgentInput), async (c) => {
      const input = c.req.valid('json')
      if (input.runtime) await requireRuntimeCli(runner, input.runtime)
      const agent = await patchAgent(db, c.req.param('id'), input, actor)
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

    // Images in task text: the raw image as the body, with its content type
    .post('/projects/:slug/attachments', attachmentBodyLimit, validate('query', uploadAttachmentQuery), async (c) => {
      const data = new Uint8Array(await c.req.arrayBuffer())
      const upload = { data, contentType: c.req.header('content-type'), name: c.req.valid('query').name }
      return c.json(await createAttachment(db, blobs, c.req.param('slug'), upload, actor), 201)
    })
    // An attachment never changes, so it can be cached for good. nosniff
    // keeps browsers to the stored (always raster image) type.
    .get('/attachments/:id/file', async (c) => {
      const file = await readAttachment(db, blobs, c.req.param('id'))
      if (!file) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(new Uint8Array(file.data), 200, {
        'content-type': file.type,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff'
      })
    })

    .get('/designs/:versionId/screenshots/:index', async (c) => {
      const file = await readDesignScreenshot(db, blobs, c.req.param('versionId'), Number(c.req.param('index')))
      if (!file) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(new Uint8Array(file.data), 200, { ...DESIGN_BUNDLE_HEADERS, 'content-type': file.type })
    })

    // Without the trailing slash, a prototype's relative asset paths would
    // resolve outside its bundle
    .get('/designs/:versionId/files', c => c.redirect(`${c.req.path}/`, 301))
    .get('/me', async c => c.json(await getProfile(db, ownerId())))
    .patch('/me', validate('json', patchProfileInput), async (c) => {
      const profile = await patchProfile(db, ownerId(), c.req.valid('json'))
      events.publish({ type: 'profile.updated', profile })
      return c.json(profile)
    })
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
      return c.json(await plans.start(input.projectId, input, actor), 201)
    })

    .get('/plan/sessions/:id', async c => c.json(await plans.getSession(c.req.param('id'))))

    // Only the runtime, and only before the session's first message (D18)
    .patch('/plan/sessions/:id', validate('json', patchPlanSessionInput), async (c) => {
      const input = c.req.valid('json')
      await requireRuntimeCli(runner, input.runtime)
      return c.json(await plans.setRuntime(c.req.param('id'), input.runtime, actor))
    })

    .post('/plan/sessions/:id/messages', validate('json', planMessageInput), async (c) => {
      const input = c.req.valid('json')
      return c.json(await plans.message(c.req.param('id'), { text: input.text, taskRef: input.taskRef }, actor), 201)
    })

    .post('/plan/sessions/:id/close', async c => c.json(await plans.close(c.req.param('id'), actor)))

    .post('/plan/sessions/:id/read', async c => c.json(await plans.markRead(c.req.param('id'))))

    .post('/plan/plans/:id/approve', async (c) => {
      // The body is optional; no body means the board
      const parsed = approvePlanInput.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) throw new ApiFailure(400, { code: 'invalid_input', issues: parsed.error.issues.map(i => ({ path: i.path.map(String), message: i.message })) })
      const plan = await plans.approve(c.req.param('id'), actor, parsed.data.to)
      orchestrator.poke(plan.tasks.flatMap(t => t.taskId ? [t.taskId] : []))
      return c.json(plan)
    })

    // Its Drafts are deleted; the session stays, so the PM can propose again
    .post('/plan/plans/:id/discard', async c => c.json(await plans.discard(c.req.param('id'), actor)))

    .get('/inbox', async c => c.json(await loadInbox(db)))

    .post('/inbox/:taskId/actions', validate('json', inboxActionInput), async (c) => {
      const [row] = await db.select({ id: schema.tasks.id }).from(schema.tasks)
        .where(and(eq(schema.tasks.id, c.req.param('taskId')), isNull(schema.tasks.deletedAt)))
      if (!row) throw new ApiFailure(404, { code: 'not_found' })
      const task = await inboxAction(row.id, c.req.valid('json'))
      return c.json({ task })
    })

    // The kill switch (PRD §7.11)
    .get('/status', c => c.json({ ...orchestrator.status, runners: runner.status().runners }))

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

    // What a deploy shipped, also from auto-deploy.sh once the new server
    // answers. 201 when recorded, 200 when this toSha already was.
    .post('/deployments', validate('json', createDeploymentInput), async (c) => {
      const { deployment, created } = await recordDeployment(db, c.req.valid('json'))
      // The response doesn't wait for the notes
      if (created) {
        events.publish({ type: 'deployment.updated', deployment })
        setImmediate(() => void releaseNotes.sweep())
      }
      return c.json(deployment, created ? 201 : 200)
    })

    .post('/deployments/:id/read', async c => c.json(await updateDeploymentInbox(db, events, c.req.param('id'))))
    .post('/deployments/:id/dismiss', async c => c.json(await updateDeploymentInbox(db, events, c.req.param('id'), true)))

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

    // A human's message to a live developer or reviewer run, kept as their
    // comment on the task. 409 run_not_live when no runner holds the run.
    .post('/projects/:slug/runs/:runId/messages', validate('json', runMessageInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await orchestrator.messageRun(project.id, c.req.param('runId'), c.req.valid('json'), actor), 202)
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
