import { endpoints, PM_TOOL_NAMES, RUNNER_PATH, type EndpointKey, type EndpointSpec } from '@corral/contracts'

// Keys use Hono's registered method and full path, including parameter names.
// Multiple handlers (validation, body limits) for one key count as one route.
const apiRoutes = Object.entries(endpoints as Record<EndpointKey, EndpointSpec>).map(([key, spec]) => {
  const [method, path] = key.split(' ')
  return [`${method} /api${path}`, spec] as const
})

export const pmRouteTools: Record<string, readonly string[]> = Object.fromEntries(apiRoutes.flatMap(([route, spec]) => spec.pm ? [[route, spec.pm]] : []))

// Exclusions are exact keys, never prefixes that could hide a future route.
// Unsupported human operations are explicit rather than attributed to a
// nearby tool that cannot actually perform them.
export const pmRouteExclusions: Record<string, string> = {
  [`GET ${RUNNER_PATH}/version`]: 'Runner updater compatibility probe before reconnecting; protocol and build information is available to PM through get_status.',
  [`GET ${RUNNER_PATH}`]: 'Internal authenticated runner WebSocket transport; PM tools travel over it, rather than opening it themselves.',
  'ALL /api/*': 'Raw-path design-file middleware: serves sandboxed prototype bytes and rejects traversal before URL normalization; otherwise calls next. Not a general API endpoint.',
  ...Object.fromEntries(apiRoutes.flatMap(([route, spec]) => spec.noPm !== undefined ? [[route, spec.noPm]] : []))
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
  const location = 'packages/contracts/src/endpoints.ts'
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
      if (!knownTools.has(name)) errors.push(`${route}: PM tool "${name}" does not exist; use a name from PM_TOOL_NAMES in packages/contracts/src/tool-definitions.ts or implement and register the tool there.`)
    }
  }
  for (const [route, reason] of Object.entries(exclusions)) {
    if (!registered.has(route)) errors.push(`${route}: excluded route is not registered; update or remove its entry in ${location}.`)
    if (!reason.trim()) errors.push(`${route}: write a non-empty exclusion reason in ${location}.`)
  }
  if (errors.length) throw new Error(`PM route coverage failed:\n${errors.join('\n')}`)
}
