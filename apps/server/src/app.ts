import {
  imageTooLarge,
  THUMBNAIL_MAX_BYTES,
  clientPerfInput,
  CLIENT_PERF_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  AVATAR_MAX_BYTES,
  SSE_HEARTBEAT_MS,
  type ApiErrorBody,
  type ServerEvent
} from '@corral/contracts'
import type { Actor } from '@corral/core'
import type { Database } from '@corral/db'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { registerEndpoints } from './endpoint-routes.ts'
import { apiTiming, type PerformanceSamples } from './performance.ts'
import { ApiFailure, fromDatabaseError, notFound, requireHuman } from './errors.ts'
import { checkThumbnail, readThumbnail, thumbnailHash } from './thumbnails.ts'
import { byteRange } from './byte-range.ts'
import { createAttachment, readAttachment } from './attachments.ts'
import { recordDeployment, updateDeploymentInbox, type ReleaseNotes } from './deployments.ts'
import { flowMetrics, workspaceFlow } from './flow-metrics.ts'
import { DESIGN_BUNDLE_HEADERS, listDesignVersions, readDesignFile, readDesignScreenshot } from './designs.ts'
import { checkAvatar, getProfile, readAvatar } from './avatars.ts'
import { getEpicReview } from './epic-review.ts'
import { getEpic, listEpicHistory, listEpics } from './epics.ts'
import type { EventBus } from './events.ts'
import { loadInbox, markInboxRead } from './inbox.ts'
import type { GitHubClient } from './github.ts'
import { listPullRequests, readPullRequest } from './pull-requests.ts'
import { findProjectBySlug, listProjects, toProject } from './projects.ts'
import { IMMUTABLE_CACHE, type BlobHandle, type BlobStore } from './blob-store.ts'
import { evidenceHeaders } from './evidence-file.ts'
import type { Orchestrator } from './orchestrator.ts'
import type { RunnerHub } from './runner-hub.ts'
import { PullRequestGuides } from './pull-request-guides.ts'
import { getRun, listAgents, listEvidence, listReviews, listRuns, readEvidenceFile, readRunTranscript } from './runs.ts'
import type { Transcripts } from './transcripts.ts'
import { checkRepository, detectClis, RepoCatalog, requireRuntimeCli } from './setup.ts'
import { listComments } from './comments.ts'
import { findTaskId, taskAndProjectByRef } from './task-rows.ts'
import { listHistory } from './audit.ts'
import { listTasks, loadTask } from './task-views.ts'
import { epicHistory } from './epic-history.ts'

// The request path exactly as the client sent it, without the query. The
// Node adapter resolves `..` in the URL before routing, so this reads the
// raw request line when there is one.
function rawPath(c: Context): string {
  const incoming = (c.env as { incoming?: { url?: string } } | undefined)?.incoming?.url
  const path = incoming ?? c.req.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

// Bytes the response only reads, so they needn't be copied for it
const bytes = (data: Uint8Array) => data as Uint8Array<ArrayBuffer>

function serveBlob(c: Context, file: BlobHandle, headers: Record<string, string>) {
  const { size } = file
  const range = byteRange(c.req.header('range'), size)
  if (range === 'unsatisfiable') return c.body(null, 416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': '0' })
  if (range) {
    const { start, end } = range
    return c.body(file.stream(start, end), 206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
  }
  return c.body(file.stream(), 200, { ...headers, 'content-length': String(size) })
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  return header?.split(',').some(tag => ['*', etag].includes(tag.trim().replace(/^W\//, ''))) ?? false
}

const DESIGN_FILES = /^\/api\/designs\/([^/]*)\/files\/(.*)$/s

export interface AppDeps {
  performance: PerformanceSamples
  db: Database
  events: EventBus
  // Who web requests act as (see ensureOwner in bootstrap.ts)
  actor: Actor
  runner: RunnerHub
  orchestrator: Orchestrator
  github: GitHubClient
  blobs: BlobStore
  transcripts: Transcripts
  releaseNotes: ReleaseNotes
}

const taskNumber = (value: string) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new ApiFailure(404, { code: 'not_found' })
  return number
}

export function createApp({ db, events, actor, runner, orchestrator, github, blobs, transcripts, releaseNotes, performance }: AppDeps) {
  const repos = new RepoCatalog(db, runner)
  const guides = new PullRequestGuides({ db, github, runner })

  // The single human (D1 POC); hosting will take this from the session
  const ownerId = () => {
    requireHuman(actor, notFound)
    return actor.userId
  }
  // The URL changes with the picture, so a served one never changes
  const serveAvatar = (c: Context, avatar: { data: Uint8Array, type: string } | null) => {
    if (!avatar) throw new ApiFailure(404, { code: 'not_found' })
    return c.body(bytes(avatar.data), 200, { 'content-type': avatar.type, 'cache-control': IMMUTABLE_CACHE })
  }
  const avatarBodyLimit = bodyLimit({
    maxSize: AVATAR_MAX_BYTES,
    onError: c => c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: [{ path: ['avatar'], message: imageTooLarge(AVATAR_MAX_BYTES) }] } }, 413)
  })

  const thumbnailBodyLimit = bodyLimit({
    // Bound parsing memory, including a small multipart envelope.
    maxSize: THUMBNAIL_MAX_BYTES + 64 * 1024,
    onError: c => c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: [{ path: ['file'], message: imageTooLarge(THUMBNAIL_MAX_BYTES) }] } }, 413)
  })

  const attachmentBodyLimit = bodyLimit({
    maxSize: ATTACHMENT_MAX_BYTES,
    onError: c => c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: [{ path: ['file'], message: imageTooLarge(ATTACHMENT_MAX_BYTES) }] } }, 413)
  })

  const taskIdOf = async (params: { slug: string, number: string }) =>
    findTaskId(db, (await findProjectBySlug(db, params.slug)).id, taskNumber(params.number))

  const app = new Hono()
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
      return c.body(bytes(file.data), 200, { ...DESIGN_BUNDLE_HEADERS, 'content-type': file.type })
    })

  registerEndpoints(app, {
    'POST /perf/client': {
      use: [bodyLimit({ maxSize: CLIENT_PERF_MAX_BYTES, onError: c => c.json({ error: { code: 'invalid_input' } }, 400) })],
      handle: async (_, c) => {
        // Parse text as well as application/json: sendBeacon can use either.
        const input = clientPerfInput.safeParse(await c.req.json().catch(() => null))
        if (!input.success) return c.json({ error: { code: 'invalid_input' } }, 400)
        const createdAt = new Date()
        for (const sample of input.data.samples) {
          performance.record({ kind: 'page', name: sample.name, metric: sample.metric,
            durationMs: sample.value, sessionId: input.data.sessionId, createdAt })
        }
      }
    },
    'GET /perf/summary': ({ query }) => performance.summary(query.window),
    'GET /health': () => ({ ok: true }),

    'POST /runners/:runnerId/update': ({ params }) => runner.drain(params.runnerId, true),
    'GET /runner': () => runner.status(),

    'GET /setup/repos': ({ query }) => repos.list(query.refresh),
    'POST /setup/check-repo': ({ body }) => checkRepository(db, runner, body.repository),
    'GET /setup/clis': () => detectClis(runner),

    'GET /projects': () => listProjects(db),
    'POST /projects': ({ body }) => orchestrator.commands.createProject(body, actor),
    'GET /projects/:slug': async ({ params }) => toProject(await findProjectBySlug(db, params.slug)),
    'GET /projects/:slug/metrics/flow': async ({ params, query }) => flowMetrics(db, await findProjectBySlug(db, params.slug), query.window),
    'GET /metrics/flow': ({ query }) => workspaceFlow(db, query.window),
    'PUT /projects/:slug/thumbnail': {
      use: [thumbnailBodyLimit],
      handle: async ({ params }, c) => {
        const project = await findProjectBySlug(db, params.slug)
        const invalid = () => new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['file'], message: 'Provide a multipart file image' }] })
        const form = await c.req.formData().catch(() => {
          throw invalid()
        })
        const files = form.getAll('file')
        const file = files[0]
        if (files.length !== 1 || !(file instanceof File)) throw invalid()
        const data = new Uint8Array(await file.arrayBuffer())
        checkThumbnail(data, file.type)
        return orchestrator.commands.setProjectThumbnail(project, await blobs.put(data), actor)
      }
    },
    'GET /projects/:slug/thumbnail': async ({ params }, c) => {
      const hash = await thumbnailHash(db, params.slug, c.req.query('v'))
      if (!hash) throw new ApiFailure(404, { code: 'not_found' })
      // The hash is the content, so a revalidation needn't read the blob
      const validators = { 'cache-control': 'private, no-cache', 'etag': `"${hash}"` }
      if (matchesEtag(c.req.header('if-none-match'), validators.etag)) return c.body(null, 304, validators)
      const file = await readThumbnail(blobs, hash)
      if (!file) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(bytes(file.data), 200, { ...validators, 'content-type': file.type, 'x-content-type-options': 'nosniff' })
    },
    'DELETE /projects/:slug/thumbnail': async ({ params }) => orchestrator.commands.setProjectThumbnail(await findProjectBySlug(db, params.slug), null, actor),
    'PATCH /projects/:slug': async ({ params, body }) => orchestrator.commands.patchProject(await findProjectBySlug(db, params.slug), body, actor),
    'GET /tasks/:ref': async ({ params }) => {
      const found = await taskAndProjectByRef(db, params.ref)
      if (!found) throw notFound()
      return loadTask(db, found.task.id)
    },
    'DELETE /projects/:slug': async ({ params, body }) => {
      const project = await findProjectBySlug(db, params.slug)
      if (body.confirm !== project.name) {
        throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['confirm'], message: 'Type the project name to remove it' }] })
      }
      await orchestrator.human.deleteProject(project.id, actor)
    },
    'GET /projects/:slug/epics': async ({ params }) => listEpics(db, await findProjectBySlug(db, params.slug)),
    'GET /projects/:slug/drafts': async ({ params }) => orchestrator.proposals.listDrafts((await findProjectBySlug(db, params.slug)).id),

    'POST /epics/:id/review': ({ params, body }) => orchestrator.epicPrs.humanAction(params.id, body, actor),
    'POST /epics/:id/sync/retry': ({ params }) => orchestrator.epicPrs.retrySync(params.id, actor),
    'GET /epics/:id/activity': ({ params }) => listEpicHistory(db, params.id),
    'GET /epics/:id/review': ({ params }) => getEpicReview(db, github, params.id),
    'GET /epics/:id': ({ params }) => getEpic(db, params.id),
    'GET /epics/:id/history': async ({ params }) => epicHistory(db, (await getEpic(db, params.id)).id),
    'PUT /epics/:id/dependencies': async ({ params, body }) => {
      const updated = await orchestrator.commands.setEpicDependencies(params.id, body.dependsOn, actor)
      return updated.find(e => e.id === params.id)!
    },
    'PATCH /epics/:id': ({ params, body }) => orchestrator.commands.patchEpic(params.id, body, actor),

    'GET /projects/:slug/tasks': async ({ params, query }) => listTasks(db, await findProjectBySlug(db, params.slug), query.view),
    'GET /projects/:slug/pull-requests': async ({ params }) => listPullRequests(db, orchestrator.merges, await findProjectBySlug(db, params.slug)),
    'GET /projects/:slug/pull-requests/:number': async ({ params }) => readPullRequest(github, await findProjectBySlug(db, params.slug), taskNumber(params.number)),
    'GET /projects/:slug/pull-requests/:number/guide': async ({ params }) => guides.get(await findProjectBySlug(db, params.slug), taskNumber(params.number)),
    'POST /projects/:slug/pull-requests/:number/guide': async ({ params }) => guides.generate(await findProjectBySlug(db, params.slug), taskNumber(params.number)),

    'POST /projects/:slug/tasks/:number/subtasks': async ({ params, body }) => {
      const project = await findProjectBySlug(db, params.slug)
      return orchestrator.commands.addSubtask(project, await findTaskId(db, project.id, taskNumber(params.number)), body, actor)
    },
    'POST /projects/:slug/tasks': async ({ params, body }) => orchestrator.commands.createTask(await findProjectBySlug(db, params.slug), body, actor),
    'GET /projects/:slug/tasks/:number/pull-request': async ({ params }) => {
      const project = await findProjectBySlug(db, params.slug)
      const task = await loadTask(db, await findTaskId(db, project.id, taskNumber(params.number)))
      if (task.pr === null) throw new ApiFailure(404, { code: 'no_pull_request' })
      return readPullRequest(github, project, task.pr.number)
    },
    'GET /projects/:slug/tasks/:number': async ({ params }) => loadTask(db, await taskIdOf(params)),
    'POST /projects/:slug/tasks/:number/transitions': async ({ params, body }) => orchestrator.commands.transitionTask(await taskIdOf(params), body, actor),
    'PATCH /projects/:slug/tasks/:number': async ({ params, body }) => {
      const project = await findProjectBySlug(db, params.slug)
      return orchestrator.commands.patchTask(project, await findTaskId(db, project.id, taskNumber(params.number)), body, actor)
    },
    'DELETE /projects/:slug/tasks/:number': async ({ params, body }) => {
      await orchestrator.human.deleteTask(await taskIdOf(params), actor, body.reason ?? null)
    },
    'POST /projects/:slug/tasks/:number/approve': async ({ params }) => orchestrator.commands.approveTask(await taskIdOf(params), actor),
    'POST /projects/:slug/tasks/:number/resume': async ({ params }) => orchestrator.human.resumeTask(await taskIdOf(params), actor),
    'GET /projects/:slug/tasks/:number/designs': async ({ params }) => listDesignVersions(db, blobs, await taskIdOf(params)),
    'POST /projects/:slug/tasks/:number/designs/:version/approve': async ({ params, body }) => {
      const taskId = await taskIdOf(params)
      await orchestrator.human.approveDesign(taskId, taskNumber(params.version), body.note || undefined, actor)
      return loadTask(db, taskId)
    },
    'GET /projects/:slug/tasks/:number/comments': async ({ params }) => listComments(db, await taskIdOf(params)),
    'POST /projects/:slug/tasks/:number/comments': async ({ params, body }) => orchestrator.commands.addComment(await taskIdOf(params), body, actor),
    'GET /projects/:slug/tasks/:number/history': async ({ params }) => listHistory(db, await taskIdOf(params)),
    'GET /projects/:slug/tasks/:number/evidence': async ({ params }) => listEvidence(db, await taskIdOf(params)),
    'GET /projects/:slug/tasks/:number/reviews': async ({ params }) => listReviews(db, await taskIdOf(params)),
    'GET /evidence/:id/file': async ({ params }, c) => {
      c.header('accept-ranges', 'bytes')
      const found = await readEvidenceFile(db, blobs, params.id)
      if (!found) throw notFound()
      return serveBlob(c, found.file, evidenceHeaders(found.contentType, found.fileName))
    },

    'GET /agents': () => listAgents(db),
    'POST /agents': ({ body }) => orchestrator.commands.createAgent(body, actor),
    'PATCH /agents/:id': ({ params, body }) => orchestrator.commands.patchAgent(params.id, body, actor),
    'PUT /agents/:id/avatar': {
      use: [avatarBodyLimit],
      handle: async ({ params }, c) => {
        const data = new Uint8Array(await c.req.arrayBuffer())
        return orchestrator.commands.setAgentAvatar(params.id, { data, type: checkAvatar(data, c.req.header('content-type')) })
      }
    },
    'DELETE /agents/:id/avatar': ({ params }) => orchestrator.commands.setAgentAvatar(params.id, null),
    'GET /agents/:id/avatar': async ({ params }, c) => serveAvatar(c, await readAvatar(db, blobs, { agentId: params.id })),
    'POST /projects/:slug/attachments': {
      use: [attachmentBodyLimit],
      handle: async ({ params, query }, c) => {
        const data = new Uint8Array(await c.req.arrayBuffer())
        return createAttachment(db, blobs, params.slug, { data, contentType: c.req.header('content-type'), name: query.name }, actor)
      }
    },
    // An attachment never changes, so it can be cached for good. nosniff
    // keeps browsers to the stored (always raster image) type.
    'GET /attachments/:id/file': async ({ params }, c) => {
      const attachment = await readAttachment(db, blobs, params.id)
      if (!attachment) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(attachment.file.stream(), 200, {
        'content-type': attachment.type,
        'content-length': String(attachment.file.size),
        'cache-control': IMMUTABLE_CACHE,
        'x-content-type-options': 'nosniff'
      })
    },
    'GET /designs/:versionId/screenshots/:index': async ({ params }, c) => {
      const file = await readDesignScreenshot(db, blobs, params.versionId, Number(params.index))
      if (!file) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(bytes(file.data), 200, { ...DESIGN_BUNDLE_HEADERS, 'content-type': file.type })
    },
    // Without the trailing slash, a prototype's relative asset paths would
    // resolve outside its bundle
    'GET /designs/:versionId/files': (_, c) => c.redirect(`${c.req.path}/`, 301),
    'GET /me': () => getProfile(db, ownerId()),
    'PATCH /me': ({ body }) => orchestrator.commands.patchProfile(ownerId(), body),
    'PUT /me/avatar': {
      use: [avatarBodyLimit],
      handle: async (_, c) => {
        const data = new Uint8Array(await c.req.arrayBuffer())
        return orchestrator.commands.setUserAvatar(ownerId(), { data, type: checkAvatar(data, c.req.header('content-type')) })
      }
    },
    'DELETE /me/avatar': () => orchestrator.commands.setUserAvatar(ownerId(), null),
    'GET /me/avatar': async (_, c) => serveAvatar(c, await readAvatar(db, blobs, { userId: ownerId() })),

    'GET /plan/sessions': () => orchestrator.plans.listSessions(),
    'POST /plan/sessions': ({ body }) => orchestrator.plans.start(body.projectId, body, actor),
    'GET /plan/sessions/:id': ({ params }) => orchestrator.plans.getSession(params.id),
    'PATCH /plan/sessions/:id': async ({ params, body }) => {
      await requireRuntimeCli(runner, body.runtime)
      return orchestrator.plans.setRuntime(params.id, body.runtime, actor)
    },
    'POST /plan/sessions/:id/messages': ({ params, body }) => orchestrator.plans.message(params.id, { text: body.text, taskRef: body.taskRef }, actor),
    'POST /plan/sessions/:id/actions/:actionId': ({ params, body }) => orchestrator.pmActions.resolve(params.id, params.actionId, body.decision, actor),
    'POST /plan/sessions/:id/close': ({ params }) => orchestrator.plans.close(params.id, actor),
    'POST /plan/sessions/:id/read': ({ params }) => orchestrator.plans.markRead(params.id),
    'POST /plan/plans/:id/approve': ({ params, body }) => orchestrator.proposals.approve(params.id, actor, body.to),
    'POST /plan/plans/:id/discard': ({ params }) => orchestrator.proposals.discard(params.id, actor),

    'GET /inbox': () => loadInbox(db, runner),
    'POST /inbox/read': async ({ body }) => {
      await markInboxRead(db, body)
      events.publish({ type: 'inbox.read', itemType: body.type, id: body.id })
      return { ok: true }
    },
    'POST /inbox/:taskId/actions': async ({ params, body }) => ({ task: await orchestrator.human.inboxAction(params.taskId, body, actor) }),

    'GET /status': () => ({ ...orchestrator.controls.status, runners: runner.status().runners }),
    'POST /stop-all': async () => {
      await orchestrator.controls.stopAll(actor)
      return orchestrator.controls.status
    },
    'POST /resume-all': async () => {
      await orchestrator.controls.resumeAll(actor)
      return orchestrator.controls.status
    },
    'POST /update-hold': async () => ({ busy: await orchestrator.controls.holdForUpdate() }),
    'DELETE /update-hold': () => {
      orchestrator.controls.releaseUpdate()
      return orchestrator.controls.status
    },
    'POST /deployments': async ({ body }, c) => {
      const { deployment, created } = await recordDeployment(db, body)
      // The response doesn't wait for the notes
      if (created) {
        events.publish({ type: 'deployment.updated', deployment })
        setImmediate(() => void releaseNotes.sweep())
      }
      return c.json(deployment, created ? 201 : 200)
    },
    'POST /deployments/:id/read': ({ params }) => updateDeploymentInbox(db, events, params.id),
    'POST /deployments/:id/dismiss': ({ params }) => updateDeploymentInbox(db, events, params.id, true),

    'GET /runs': ({ query: { agentId, taskId, since, active } }) => listRuns(db, { ...(agentId && { agentId }), ...(taskId && { taskId }), ...(since && { since }), active }),
    'GET /runs/:id': ({ params }) => getRun(db, params.id),
    'GET /runs/:id/transcript': ({ params }) => readRunTranscript(db, transcripts, params.id),
    'POST /runs/:id/stop': async ({ params }) => {
      await orchestrator.human.stopRun(params.id, actor)
      return getRun(db, params.id)
    },
    'POST /projects/:slug/runs/:runId/messages': async ({ params, body }) => orchestrator.human.messageRun((await findProjectBySlug(db, params.slug)).id, params.runId, body, actor),

    'GET /events': (_, c) => streamSSE(c, async (stream) => {
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
    })
  })
  return app
}
