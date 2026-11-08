import { endpoints, type ApiErrorBody, type EndpointKey, type EndpointParams, type EndpointResponse, type Endpoints, type EndpointSpec } from '@corral/contracts'
import { zValidator } from '@hono/zod-validator'
import type { Context, Hono, MiddlewareHandler, ValidationTargets } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z, ZodType } from 'zod'

// What a handler gets, already checked against the endpoint's schemas
export interface EndpointRequest<K extends EndpointKey> {
  params: EndpointParams<K>
  body: Endpoints[K] extends { body: infer Schema extends ZodType } ? z.output<Schema> : undefined
  query: Endpoints[K] extends { query: infer Schema extends ZodType } ? z.output<Schema> : undefined
}

// The endpoint's JSON, sent with its status; or a whole response (a file, a stream)
type Answer<K extends EndpointKey> = EndpointResponse<K> | Response
export type EndpointHandler<K extends EndpointKey> = (request: EndpointRequest<K>, c: Context) => Answer<K> | Promise<Answer<K>>
export type EndpointRoute<K extends EndpointKey> = EndpointHandler<K> | { use: MiddlewareHandler[], handle: EndpointHandler<K> }

// One route per endpoint: a missing or unknown one doesn't typecheck
export type EndpointRoutes = { [K in EndpointKey]: EndpointRoute<K> }

// Validation failures get the same error shape as every other API error
function validate<Target extends keyof ValidationTargets>(target: Target, schema: ZodType): MiddlewareHandler {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: result.error.issues } }, 400)
    }
  })
}

// A JSON body that may be left out, which then reads as {}
function optionalJson(schema: ZodType): MiddlewareHandler {
  return async (c, next) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: parsed.error.issues } }, 400)
    c.set('body' as never, parsed.data as never)
    await next()
  }
}

const valid = (c: Context, target: 'json' | 'query') => (c.req.valid as (target: string) => unknown)(target)

export function registerEndpoints(app: Hono, routes: EndpointRoutes): void {
  for (const key of Object.keys(endpoints) as EndpointKey[]) {
    const spec: EndpointSpec = endpoints[key]
    const route = routes[key] as EndpointRoute<EndpointKey>
    const { use, handle } = typeof route === 'function' ? { use: [], handle: route } : route
    const [method, path] = key.split(' ') as [string, string]
    const json = spec.body && !('raw' in spec.body) ? spec.body : null
    const chain: MiddlewareHandler[] = [...use]
    if (json) chain.push(spec.optionalBody ? optionalJson(json) : validate('json', json))
    if (spec.query) chain.push(validate('query', spec.query))
    chain.push(async (c) => {
      const body = !json ? undefined : spec.optionalBody ? c.get('body' as never) : valid(c, 'json')
      const query = spec.query ? valid(c, 'query') : undefined
      const answer = await handle({ params: c.req.param(), body, query } as EndpointRequest<EndpointKey>, c)
      if (answer instanceof Response) return answer
      if (spec.status === 204) return c.body(null, 204)
      return c.json(answer as never, (spec.status ?? 200) as ContentfulStatusCode)
    })
    app.on(method, path, ...chain as [MiddlewareHandler])
  }
}
