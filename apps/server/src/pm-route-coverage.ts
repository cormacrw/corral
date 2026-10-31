import { PM_TOOL_NAMES } from '@corral/contracts'

// Keys use Hono's registered method and full path, including parameter names.
// Multiple handlers (validation, body limits) for one key count as one route.
export const pmRouteTools: Record<string, readonly string[]> = {
  'GET /api/runner': ['get_status'],
  'GET /api/projects': ['list_projects'],
  'POST /api/projects': ['create_project'],
  'GET /api/projects/:slug': ['get_project'],
  'PATCH /api/projects/:slug': ['update_project'],
  'DELETE /api/projects/:slug': ['delete_project'],
  'GET /api/tasks/:ref': ['get_task'],
  'GET /api/projects/:slug/epics': ['list_tasks'],
  'PUT /api/epics/:id/dependencies': ['update_epic'],
  'PATCH /api/epics/:id': ['update_epic'],
  'GET /api/projects/:slug/tasks': ['list_tasks'],
  'POST /api/projects/:slug/tasks': ['create_task'],
  'GET /api/projects/:slug/tasks/:number': ['get_task'],
  'POST /api/projects/:slug/tasks/:number/transitions': ['move_task', 'act_on_inbox'],
  'PATCH /api/projects/:slug/tasks/:number': ['update_task'],
  'DELETE /api/projects/:slug/tasks/:number': ['delete_task', 'act_on_inbox'],
  'POST /api/projects/:slug/tasks/:number/approve': ['approve_task', 'act_on_inbox'],
  'POST /api/projects/:slug/tasks/:number/resume': ['update_task'],
  'GET /api/projects/:slug/tasks/:number/designs': ['get_design'],
  'POST /api/projects/:slug/tasks/:number/designs/:version/approve': ['approve_design'],
  'POST /api/projects/:slug/tasks/:number/comments': ['add_comment'],
  'GET /api/projects/:slug/tasks/:number/comments': ['get_task'],
  'GET /api/agents': ['list_agents'],
  'POST /api/agents': ['create_agent'],
  'PATCH /api/agents/:id': ['update_agent'],
  'GET /api/plan/sessions': ['list_threads'],
  'POST /api/plan/sessions': ['start_thread'],
  'GET /api/plan/sessions/:id': ['read_thread'],
  'POST /api/plan/sessions/:id/messages': ['message_thread'],
  'POST /api/plan/sessions/:id/close': ['close_thread'],
  'POST /api/plan/plans/:id/approve': ['approve_plan'],
  'GET /api/inbox': ['list_inbox'],
  'POST /api/inbox/:taskId/actions': ['act_on_inbox', 'request_design_changes'],
  'GET /api/status': ['get_status'],
  'POST /api/stop-all': ['stop_all'],
  'POST /api/resume-all': ['resume_all'],
  'POST /api/update-hold': ['set_update_hold'],
  'DELETE /api/update-hold': ['clear_update_hold'],
  'GET /api/runs': ['list_runs'],
  'GET /api/runs/:id': ['get_run'],
  'GET /api/runs/:id/transcript': ['get_run'],
  'POST /api/runs/:id/stop': ['stop_run'],
  'POST /api/projects/:slug/runs/:runId/messages': ['message_run']
}

// Exclusions are exact keys, never prefixes that could hide a future route.
// Unsupported human operations are explicit here rather than attributed to a
// nearby tool that cannot actually perform them.
export const pmRouteExclusions: Record<string, string> = {
  'GET /runner/version': 'Runner updater compatibility probe before reconnecting; protocol and build information is available to PM through get_status.',
  'GET /runner': 'Internal authenticated runner WebSocket transport; PM tools travel over it, rather than opening it themselves.',
  'ALL /api/*': 'Raw-path design-file middleware: serves sandboxed prototype bytes and rejects traversal before URL normalization; otherwise calls next. Not a general API endpoint.',
  'GET /api/health': 'Liveness probe for operators and container health checks.',
  'POST /api/runners/:runnerId/update': 'Operator-only runner drain/update request; PM can inspect update state with get_status but cannot trigger runner replacement.',
  'GET /api/setup/repos': 'Human onboarding repository picker; create_project accepts a repository directly and checks access.',
  'POST /api/setup/check-repo': 'Human onboarding preflight; create_project performs its own repository checks before creation.',
  'GET /api/setup/clis': 'Human onboarding CLI login diagnostics; authentication stays with the operator on the runner.',
  'PUT /api/projects/:slug/thumbnail': 'Multipart cosmetic image upload by the human; no PM binary upload tool.',
  'GET /api/projects/:slug/thumbnail': 'Browser image download; project tools return the thumbnail URL.',
  'DELETE /api/projects/:slug/thumbnail': 'Human cosmetic image removal; update_project does not change binary thumbnails.',
  'GET /api/projects/:slug/drafts': 'Human Plan-tab draft grouping by session; PM reads its proposed plan through read_thread and tasks through list_tasks.',
  'POST /api/epics/:id/review': 'Epic PR merge/rejection remains a human decision; PM has no epic-review decision tool (D29: cannot merge PRs).',
  'GET /api/epics/:id/history': 'Human Activity audit view; no PM epic audit-history reader currently exists.',
  'GET /api/epics/:id': 'Detailed human epic view; list_tasks exposes epic identity and dependencies, but no PM tool reads the full epic detail.',
  'GET /api/projects/:slug/pull-requests': 'Human GitHub PR overview; PM reads task PR links via list_tasks and cannot merge PRs.',
  'GET /api/projects/:slug/tasks/:number/history': 'Human Activity audit view; no PM task audit-history reader currently exists.',
  'GET /api/projects/:slug/tasks/:number/evidence': 'Human review evidence listing; get_evidence is a reviewer tool, not a PM tool.',
  'GET /api/projects/:slug/tasks/:number/reviews': 'Human detailed review-round view; PM has get_run_outcomes for outcome summaries, not a full review reader.',
  'GET /api/evidence/:id/file': 'Binary evidence download for the review UI; not a PM API operation.',
  'PUT /api/agents/:id/avatar': 'Multipart cosmetic avatar upload by the human; no PM binary upload tool.',
  'DELETE /api/agents/:id/avatar': 'Human cosmetic avatar removal; update_agent edits settings, not avatar bytes.',
  'GET /api/agents/:id/avatar': 'Browser avatar image download; list_agents supplies its URL.',
  'POST /api/projects/:slug/attachments': 'Human multipart attachment upload; PM can read existing attachments with get_attachment.',
  'GET /api/attachments/:id/file': 'Browser binary attachment download; get_attachment uses the scoped agent transport instead.',
  'GET /api/designs/:versionId/screenshots/:index': 'Browser screenshot download; get_design supplies screenshots over the agent transport.',
  'GET /api/designs/:versionId/files': 'Browser redirect to the sandboxed prototype bundle; get_design supplies the bundle over the agent transport.',
  'GET /api/me': 'The human profile, not an agent identity; PM must not impersonate the human.',
  'PATCH /api/me': 'Human-only profile settings; PM must not change the human identity.',
  'PUT /api/me/avatar': 'Human profile avatar upload; PM must not change the human identity.',
  'DELETE /api/me/avatar': 'Human profile avatar removal; PM must not change the human identity.',
  'GET /api/me/avatar': 'Browser human-profile image download.',
  'PATCH /api/plan/sessions/:id': 'Human thread title/project/runtime settings; PM starts or messages threads but has no thread-settings tool.',
  'POST /api/plan/sessions/:id/actions/:actionId': 'Human confirmation/cancellation endpoint; exposing it to PM would bypass confirm cards.',
  'POST /api/plan/sessions/:id/read': 'Human UI read receipt; PM reading a thread must not clear the human unread state.',
  'POST /api/plan/plans/:id/discard': 'Human decision to discard a proposed plan; close_thread deliberately refuses threads with proposals or owned drafts.',
  'POST /api/deployments': 'Called by the deploy script to record a deployment, not by PM.',
  'POST /api/deployments/:id/read': 'Human release-note read receipt; PM must not clear human unread state.',
  'POST /api/deployments/:id/dismiss': 'Human release-note dismissal; no PM deployment dismissal tool.',
  'GET /api/projects/:slug/metrics/flow': 'Human flow dashboard cohort and timing analytics; run tools report individual runs rather than aggregate flow metrics.',
  'GET /api/events': 'Browser SSE subscription; tools return snapshots and do not hold event streams open.'
}

interface RegisteredRoute { method: string, path: string }

export function checkPmRouteCoverage(
  routes: readonly RegisteredRoute[],
  mapping: Readonly<Record<string, readonly string[]>> = pmRouteTools,
  exclusions: Readonly<Record<string, string>> = pmRouteExclusions,
  tools: readonly string[] = PM_TOOL_NAMES
): void {
  const registered = new Set(routes.map(route => `${route.method} ${route.path}`))
  const knownTools = new Set(tools)
  const errors: string[] = []
  const location = 'apps/server/src/pm-route-coverage.ts'
  for (const route of registered) {
    if (!Object.hasOwn(mapping, route) && !Object.hasOwn(exclusions, route)) {
      errors.push(`${route}: add a PM tool mapping or an exclusion with a written reason in ${location}.`)
    }
  }
  for (const [route, names] of Object.entries(mapping)) {
    if (!registered.has(route)) errors.push(`${route}: mapped route is not registered; update or remove its entry in ${location}.`)
    if (!names.length) errors.push(`${route}: map at least one existing PM tool, or move it to the reasoned exclusions in ${location}.`)
    if (Object.hasOwn(exclusions, route)) errors.push(`${route}: choose either a PM tool mapping or a reasoned exclusion in ${location}, not both.`)
    for (const name of names) {
      if (!knownTools.has(name)) errors.push(`${route}: PM tool "${name}" does not exist; use a name from PM_TOOL_NAMES in packages/contracts/src/pm-tools.ts or implement and register the tool there.`)
    }
  }
  for (const [route, reason] of Object.entries(exclusions)) {
    if (!registered.has(route)) errors.push(`${route}: excluded route is not registered; update or remove its entry in ${location}.`)
    if (!reason.trim()) errors.push(`${route}: write a non-empty exclusion reason in ${location}.`)
  }
  if (errors.length) throw new Error(`PM route coverage failed:\n${errors.join('\n')}`)
}
