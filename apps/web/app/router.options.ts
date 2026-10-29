import type { RouterConfig } from '@nuxt/schema'

export default {
  routes: routes => [...routes, { path: '/agents', redirect: '/home' }]
} satisfies RouterConfig
