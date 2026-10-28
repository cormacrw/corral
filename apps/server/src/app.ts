import { Hono } from 'hono'

export function createApp() {
  return new Hono()
    .basePath('/api')
    .get('/health', c => c.json({ ok: true }))
}

// The Hono typed client (hc) in apps/web is built from this type
export type AppType = ReturnType<typeof createApp>
