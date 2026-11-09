import type { z, ZodType } from 'zod'
import { createAgentInput, patchAgentInput, runListQuery, runMessageInput, type Agent, type GlobalStatus, type Run, type RunMessageAccepted, type ServerStatus } from './agents.ts'
import { createDeploymentInput, type Deployment } from './deployments.ts'
import { approveDesignInput, type DesignVersion } from './designs.ts'
import { patchEpicInput, setEpicDependenciesInput, type Epic, type EpicDetail, type EpicHistoryEntry } from './epics.ts'
import { flowMetricsQuery, type FlowMetrics, type WorkspaceFlow } from './flow-metrics.ts'
import { epicReviewActionInput, inboxActionInput, inboxReadInput, type EpicReview, type Inbox } from './inbox.ts'
import { uploadAttachmentQuery, type Attachment } from './media.ts'
import { perfSummaryQuery, type PerfSummary } from './performance.ts'
import { approvePlanInput, patchPlanSessionInput, planMessageInput, pmActionDecisionInput, startPlanSessionInput, type DraftSession, type Plan, type PlanMessage, type PlanSession, type PlanSessionDetail } from './plans.ts'
import { patchProfileInput, type Profile } from './profile.ts'
import { createProjectInput, deleteProjectInput, patchProjectInput, type Project } from './projects.ts'
import type { PullRequestDetail, PullRequestGuide, PullRequestStatus } from './pull-requests.ts'
import type { RunEvent } from './runner.ts'
import type { RunnerInfo, RunnerStatus } from './runner-status.ts'
import { checkRepoInput, repoListQuery, type CliStatus, type RepoCheck, type RepoList } from './setup.ts'
import { addCommentInput, createTaskInput, deleteTaskInput, humanTransitionInput, patchTaskInput, taskListQuery, type AuditEntry, type Comment, type Evidence, type Review, type Task } from './tasks.ts'
import type { PmTool } from './tool-definitions.ts'

// Every HTTP endpoint under /api, in the order the server registers them.
// The server's routes, the web client (apps/web/app/queries/api.ts) and the
// prototype's mock server (apps/web/app/prototype/mock-api.ts) are all keyed
// by it.
//
// Each endpoint either names the PM tools that do the same thing, or says in
// `noPm` why the PM has none (the PM can do what the human can, unless there
// is a reason it shouldn't).

declare const typeOnly: unique symbol
// The JSON an endpoint answers with. Only its type exists.
export interface Reply<T> { readonly [typeOnly]?: T }
const reply = <T>(): Reply<T> => ({})
// A body sent as it is (an image, a form) instead of as JSON
interface RawBody<T> { readonly raw: true, readonly [typeOnly]?: T }
const raw = <T extends Blob | FormData>(): RawBody<T> => ({ raw: true })

type PmCoverage =
  | { pm: readonly [PmTool, ...PmTool[]], noPm?: never }
  | { noPm: string, pm?: never }

export type EndpointSpec = PmCoverage & {
  // A JSON body checked against this schema, or a raw body
  body?: ZodType | RawBody<Blob | FormData>
  // The JSON body may be left out, and then reads as {}
  optionalBody?: true
  query?: ZodType
  // Left out when the answer isn't JSON (a file, a stream or a redirect)
  response?: Reply<unknown>
  status?: 201 | 202 | 204
  // The web app's API client calls it, so the prototype must answer it too
  web?: true
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export const endpoints = {
  // clientPerfInput as JSON, from sendBeacon, which may label it text
  'POST /perf/client': { body: raw<Blob>(), status: 204, response: reply<void>(), noPm: 'The browser reports its own page timings here; there is nothing for the PM to report.' },
  'GET /perf/summary': { query: perfSummaryQuery, response: reply<PerfSummary>(), web: true, noPm: 'Settings charts of request timings for the operator; no PM decision depends on them.' },
  'GET /health': { response: reply<{ ok: true }>(), noPm: 'Liveness probe for operators and container health checks.' },

  'POST /runners/:runnerId/update': { response: reply<RunnerInfo>(), web: true, noPm: 'Operator-only runner drain/update request; PM can inspect update state with get_status but cannot trigger runner replacement.' },
  'GET /runner': { response: reply<RunnerStatus>(), web: true, pm: ['get_status'] },

  'GET /setup/repos': { query: repoListQuery, response: reply<RepoList>(), web: true, noPm: 'Human onboarding repository picker; create_project accepts a repository directly and checks access.' },
  'POST /setup/check-repo': { body: checkRepoInput, response: reply<RepoCheck>(), web: true, noPm: 'Human onboarding preflight; create_project performs its own repository checks before creation.' },
  'GET /setup/clis': { response: reply<CliStatus[]>(), web: true, noPm: 'Human onboarding CLI login diagnostics; authentication stays with the operator on the runner.' },

  'GET /projects': { response: reply<Project[]>(), web: true, pm: ['list_projects'] },
  'POST /projects': { body: createProjectInput, response: reply<Project>(), status: 201, web: true, pm: ['create_project'] },
  'GET /projects/:slug': { response: reply<Project>(), pm: ['get_project'] },
  'GET /projects/:slug/metrics/flow': { query: flowMetricsQuery, response: reply<FlowMetrics>(), web: true, noPm: 'Human flow dashboard cohort and timing analytics; run tools report individual runs rather than aggregate flow metrics.' },
  // Cycle time across every project, for Home
  'GET /metrics/flow': { query: flowMetricsQuery, response: reply<WorkspaceFlow>(), web: true, noPm: 'Home dashboard cycle time across projects; the PM works per project and per run.' },
  // A multipart form with one `file` image
  'PUT /projects/:slug/thumbnail': { body: raw<FormData>(), response: reply<Project>(), web: true, noPm: 'Multipart cosmetic image upload by the human; no PM binary upload tool.' },
  'GET /projects/:slug/thumbnail': { noPm: 'Browser image download; project tools return the thumbnail URL.' },
  'DELETE /projects/:slug/thumbnail': { response: reply<Project>(), web: true, noPm: 'Human cosmetic image removal; update_project does not change binary thumbnails.' },
  'PATCH /projects/:slug': { body: patchProjectInput, response: reply<Project>(), web: true, pm: ['update_project'] },
  // A task by its ref, e.g. COR-29 (design/task.md page route)
  'GET /tasks/:ref': { response: reply<Task>(), web: true, pm: ['get_task'] },
  'DELETE /projects/:slug': { body: deleteProjectInput, response: reply<void>(), status: 204, web: true, pm: ['delete_project'] },
  'GET /projects/:slug/epics': { response: reply<Epic[]>(), web: true, pm: ['list_tasks'] },
  // Drafts by the Plan session they belong to, for the Plan tab (D10)
  'GET /projects/:slug/drafts': { response: reply<DraftSession[]>(), web: true, noPm: 'Human Plan-tab draft grouping by session; PM reads its proposed plan through read_thread and tasks through list_tasks.' },

  'POST /epics/:id/review': { body: epicReviewActionInput, response: reply<{ ok: boolean }>(), web: true, noPm: 'Epic PR merge/rejection remains a human decision; PM has no epic-review decision tool (D30: cannot merge PRs).' },
  'POST /epics/:id/sync/retry': { response: reply<{ ok: boolean }>(), web: true, noPm: 'Human retry of the epic rebase journal; no PM retry tool exists.' },
  'GET /epics/:id/activity': { response: reply<AuditEntry[]>(), web: true, noPm: 'Human Activity audit view; no PM epic audit-history reader currently exists.' },
  'GET /epics/:id/review': { response: reply<EpicReview>(), web: true, noPm: 'What the human reads in the Inbox panel to review an epic PR. The PM sees epic items through list_inbox and tasks through get_task.' },
  'GET /epics/:id': { response: reply<EpicDetail>(), web: true, noPm: 'Detailed human epic view; list_tasks exposes epic identity and dependencies, but no PM tool reads the full epic detail.' },
  // PRD §14: every approval decision can be understood afterwards
  'GET /epics/:id/history': { response: reply<EpicHistoryEntry[]>(), web: true, noPm: 'Human epic rebase and approval history; no PM epic history reader currently exists.' },
  'PUT /epics/:id/dependencies': { body: setEpicDependenciesInput, response: reply<Epic>(), web: true, pm: ['update_parent'] },
  'PATCH /epics/:id': { body: patchEpicInput, response: reply<Epic>(), web: true, pm: ['update_parent'] },

  'GET /projects/:slug/tasks': { query: taskListQuery, response: reply<Task[]>(), web: true, pm: ['list_tasks'] },
  // Open PRs and their merge gates, live from GitHub
  'GET /projects/:slug/pull-requests': { response: reply<PullRequestStatus[]>(), web: true, noPm: 'Human GitHub PR overview; PM reads task PR links via list_tasks and cannot merge PRs.' },
  // Any PR on the project's repository: its description and capped diff
  'GET /projects/:slug/pull-requests/:number': { response: reply<PullRequestDetail>(), web: true, noPm: 'Human GitHub PR detail for the Inbox panel; PM reads task PR links via list_tasks.' },
  // A PR's guided review (COR-525): read it, or start one for the head commit
  'GET /projects/:slug/pull-requests/:number/guide': { response: reply<PullRequestGuide>(), web: true, noPm: 'Human guided code review in the Inbox panel; a reading aid for the reviewer, not a PM action.' },
  'POST /projects/:slug/pull-requests/:number/guide': { response: reply<PullRequestGuide>(), status: 202, web: true, noPm: 'Human asks for a guided code review in the Inbox panel; a reading aid for the reviewer, not a PM action.' },

  'POST /projects/:slug/tasks/:number/subtasks': { body: createTaskInput, response: reply<Task>(), status: 201, web: true, noPm: 'Human Add subtask on the task page; the PM adds subtasks and promotes tasks through propose_plan, which a human approves.' },
  'POST /projects/:slug/tasks': { body: createTaskInput, response: reply<Task>(), status: 201, web: true, pm: ['create_task'] },
  'GET /projects/:slug/tasks/:number/pull-request': { response: reply<PullRequestDetail>(), noPm: 'Human PR tabs in the Inbox panel; PM reads task PR links via list_tasks.' },
  'GET /projects/:slug/tasks/:number': { response: reply<Task>(), pm: ['get_task'] },
  'POST /projects/:slug/tasks/:number/transitions': { body: humanTransitionInput, response: reply<Task>(), web: true, pm: ['move_task', 'act_on_inbox'] },
  'PATCH /projects/:slug/tasks/:number': { body: patchTaskInput, response: reply<Task>(), web: true, pm: ['update_task'] },
  'DELETE /projects/:slug/tasks/:number': { body: deleteTaskInput, optionalBody: true, response: reply<void>(), status: 204, web: true, pm: ['delete_task', 'act_on_inbox'] },
  // Approve a mergeable task for the merge pass; spikes finish here.
  // Designs must use version approval and are rejected by core.
  'POST /projects/:slug/tasks/:number/approve': { response: reply<Task>(), pm: ['approve_task', 'act_on_inbox'] },
  // Clears a stopped run's pause
  'POST /projects/:slug/tasks/:number/resume': { response: reply<Task>(), web: true, pm: ['update_task'] },
  // A design task's versions (D20), newest first
  'GET /projects/:slug/tasks/:number/designs': { response: reply<DesignVersion[]>(), web: true, pm: ['get_design'] },
  'POST /projects/:slug/tasks/:number/designs/:version/approve': { body: approveDesignInput, optionalBody: true, response: reply<Task>(), web: true, pm: ['approve_design'] },
  'GET /projects/:slug/tasks/:number/comments': { response: reply<Comment[]>(), web: true, pm: ['get_task'] },
  'POST /projects/:slug/tasks/:number/comments': { body: addCommentInput, response: reply<Comment>(), status: 201, web: true, pm: ['add_comment'] },
  // PRD §14: understand every merge decision
  'GET /projects/:slug/tasks/:number/history': { response: reply<AuditEntry[]>(), web: true, noPm: 'Human Activity audit view; no PM task audit-history reader currently exists.' },
  'GET /projects/:slug/tasks/:number/evidence': { response: reply<Evidence[]>(), web: true, noPm: 'Human review evidence listing; get_evidence is a reviewer tool, not a PM tool.' },
  'GET /projects/:slug/tasks/:number/reviews': { response: reply<Review[]>(), web: true, noPm: 'Human detailed review-round view; PM has get_run_outcomes for outcome summaries, not a full review reader.' },
  'GET /evidence/:id/file': { noPm: 'Binary evidence download for the review UI; not a PM API operation.' },

  'GET /agents': { response: reply<Agent[]>(), web: true, pm: ['list_agents'] },
  'POST /agents': { body: createAgentInput, response: reply<Agent>(), status: 201, web: true, pm: ['create_agent'] },
  'PATCH /agents/:id': { body: patchAgentInput, response: reply<Agent>(), web: true, pm: ['update_agent'] },
  // Profile pictures: the raw image as the body, with its content type
  'PUT /agents/:id/avatar': { body: raw<Blob>(), response: reply<Agent>(), web: true, noPm: 'Cosmetic avatar upload by the human; no PM binary upload tool.' },
  'DELETE /agents/:id/avatar': { response: reply<Agent>(), web: true, noPm: 'Human cosmetic avatar removal; update_agent edits settings, not avatar bytes.' },
  'GET /agents/:id/avatar': { noPm: 'Browser avatar image download; list_agents supplies its URL.' },
  // Images in task text: the raw image as the body, with its content type.
  // Referenced as ![name](attachment:<id>)
  'POST /projects/:slug/attachments': { body: raw<Blob>(), query: uploadAttachmentQuery, response: reply<Attachment>(), status: 201, web: true, noPm: 'Human attachment upload; PM can read existing attachments with get_attachment.' },
  'GET /attachments/:id/file': { noPm: 'Browser binary attachment download; get_attachment uses the scoped agent transport instead.' },
  'GET /designs/:versionId/screenshots/:index': { noPm: 'Browser screenshot download; get_design supplies screenshots over the agent transport.' },
  'GET /designs/:versionId/files': { noPm: 'Browser redirect to the sandboxed prototype bundle; get_design supplies the bundle over the agent transport.' },
  'GET /me': { response: reply<Profile>(), web: true, noPm: 'The human profile, not an agent identity; PM must not impersonate the human.' },
  'PATCH /me': { body: patchProfileInput, response: reply<Profile>(), web: true, noPm: 'Human-only profile settings; PM must not change the human identity.' },
  'PUT /me/avatar': { body: raw<Blob>(), response: reply<Profile>(), web: true, noPm: 'Human profile avatar upload; PM must not change the human identity.' },
  'DELETE /me/avatar': { response: reply<Profile>(), web: true, noPm: 'Human profile avatar removal; PM must not change the human identity.' },
  'GET /me/avatar': { noPm: 'Browser human-profile image download.' },

  // Plan (D9): sessions, turns and approval
  'GET /plan/sessions': { response: reply<PlanSession[]>(), web: true, pm: ['list_threads'] },
  'POST /plan/sessions': { body: startPlanSessionInput, response: reply<PlanSessionDetail>(), status: 201, web: true, pm: ['start_thread'] },
  'GET /plan/sessions/:id': { response: reply<PlanSessionDetail>(), web: true, pm: ['read_thread'] },
  // Only the runtime, and only before the session's first message (D18)
  'PATCH /plan/sessions/:id': { body: patchPlanSessionInput, response: reply<PlanSession>(), noPm: 'Human thread title/project/runtime settings; PM starts or messages threads but has no thread-settings tool.' },
  'POST /plan/sessions/:id/messages': { body: planMessageInput, response: reply<PlanMessage>(), status: 201, web: true, pm: ['message_thread'] },
  'POST /plan/sessions/:id/actions/:actionId': { body: pmActionDecisionInput, response: reply<PlanMessage>(), web: true, noPm: 'Human confirmation/cancellation endpoint; exposing it to PM would bypass confirm cards.' },
  'POST /plan/sessions/:id/close': { response: reply<PlanSession>(), web: true, pm: ['close_thread'] },
  'POST /plan/sessions/:id/read': { response: reply<PlanSession>(), web: true, noPm: 'Human UI read receipt; PM reading a thread must not clear the human unread state.' },
  // No body means the board
  'POST /plan/plans/:id/approve': { body: approvePlanInput, optionalBody: true, response: reply<Plan>(), web: true, pm: ['approve_plan'] },
  // Its Drafts are deleted; the session stays, so the PM can propose again
  'POST /plan/plans/:id/discard': { response: reply<Plan>(), noPm: 'Human decision to discard a proposed plan; close_thread deliberately refuses threads with proposals or owned drafts.' },

  'GET /inbox': { response: reply<Inbox>(), web: true, pm: ['list_inbox'] },
  'POST /inbox/read': { body: inboxReadInput, response: reply<{ ok: true }>(), web: true, noPm: 'Human Inbox read receipt; PM listing the Inbox must not clear human unread state.' },
  'POST /inbox/:taskId/actions': { body: inboxActionInput, response: reply<{ task: Task | null }>(), web: true, pm: ['act_on_inbox', 'request_design_changes'] },

  // The kill switch (PRD §7.11)
  'GET /status': { response: reply<ServerStatus>(), web: true, pm: ['get_status'] },
  'POST /stop-all': { response: reply<GlobalStatus>(), web: true, pm: ['stop_all'] },
  'POST /resume-all': { response: reply<GlobalStatus>(), web: true, pm: ['resume_all'] },
  // The update hold, for scripts/deploy/auto-deploy.sh. `busy` counts the runs still going.
  'POST /update-hold': { response: reply<{ busy: number }>(), pm: ['set_update_hold'] },
  'DELETE /update-hold': { response: reply<GlobalStatus>(), web: true, pm: ['clear_update_hold'] },
  // What a deploy shipped, also from auto-deploy.sh once the new server
  // answers. 201 when recorded, 200 when this toSha already was.
  'POST /deployments': { body: createDeploymentInput, response: reply<Deployment>(), noPm: 'Called by the deploy script to record a deployment, not by PM.' },
  'POST /deployments/:id/read': { response: reply<Deployment>(), web: true, noPm: 'Human release-note read receipt; PM must not clear human unread state.' },
  'POST /deployments/:id/dismiss': { response: reply<Deployment>(), web: true, noPm: 'Human release-note dismissal; no PM deployment dismissal tool.' },

  'GET /runs': { query: runListQuery, response: reply<Run[]>(), web: true, pm: ['list_runs'] },
  'GET /runs/:id': { response: reply<Run>(), pm: ['get_run'] },
  'GET /runs/:id/transcript': { response: reply<RunEvent[]>(), web: true, pm: ['get_run'] },
  'POST /runs/:id/stop': { response: reply<Run>(), web: true, pm: ['stop_run'] },
  // A human's message to a live developer or reviewer run, kept as their
  // comment on the task. 409 run_not_live when no runner holds the run.
  'POST /projects/:slug/runs/:runId/messages': { body: runMessageInput, response: reply<RunMessageAccepted>(), status: 202, web: true, pm: ['message_run'] },

  'GET /events': { noPm: 'Browser SSE subscription; tools return snapshots and do not hold event streams open.' }
} as const satisfies Record<`${Method} /${string}`, EndpointSpec>

export type Endpoints = typeof endpoints
export type EndpointKey = keyof Endpoints
export type WebEndpoint = { [K in EndpointKey]: Endpoints[K] extends { web: true } ? K : never }[EndpointKey]

type PathParams<Path> =
  Path extends `${string}:${infer Name}/${infer Rest}` ? Name | PathParams<`/${Rest}`>
    : Path extends `${string}:${infer Name}` ? Name
      : never
export type EndpointParamName<K extends EndpointKey> = PathParams<K>
export type EndpointParams<K extends EndpointKey, Value = string> = { [Name in PathParams<K>]: Value }

// What a client sends, before the server's schema fills defaults
export type EndpointBody<K extends EndpointKey> =
  Endpoints[K] extends { body: RawBody<infer T> } ? T
    : Endpoints[K] extends { body: infer Schema extends ZodType } ? Endpoints[K] extends { optionalBody: true } ? z.input<Schema> | undefined : z.input<Schema>
      : undefined
export type EndpointQuery<K extends EndpointKey> = Endpoints[K] extends { query: infer Schema extends ZodType } ? z.input<Schema> : undefined
export type EndpointResponse<K extends EndpointKey> = Endpoints[K] extends { response: Reply<infer T> } ? T : never
