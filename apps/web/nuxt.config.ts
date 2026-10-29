// https://nuxt.com/docs/api/configuration/nuxt-config

// `pnpm prototype` (D20): the same app on fixture data, generated as static
// files with relative paths and hash routes, so it runs from any sub-path in
// a sandboxed iframe with no server. Off for dev and production builds.
const prototype = process.env.CORRAL_PROTOTYPE === '1'

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  // UI only; all data is live from apps/server (docs/architecture.md)
  ssr: false,

  devtools: {
    enabled: true
  },

  // The installable app (D17, design/mobile.md). In the static shell, not
  // useHead, so browsers find the manifest and iOS reads its tags before any
  // script runs. Paths are relative to the origin: Corral runs behind
  // whatever hostname the tunnel gives it (D12).
  app: {
    ...(prototype && { cdnURL: './' }),
    head: prototype
      ? {}
      : {
          meta: [
            { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' },
            { name: 'theme-color', content: '#0f172b', media: '(prefers-color-scheme: dark)' },
            { name: 'mobile-web-app-capable', content: 'yes' },
            { name: 'apple-mobile-web-app-capable', content: 'yes' },
            { name: 'apple-mobile-web-app-title', content: 'Corral' },
            { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }
          ],
          link: [
            { rel: 'manifest', href: '/manifest.webmanifest' },
            { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }
          ]
        }
  },

  css: ['~/assets/css/main.css'],

  // A sub-path inside a sandbox can't use history routes or a server
  router: {
    options: { hashMode: prototype }
  },

  routeRules: prototype
    ? {}
    : {
        '/api/**': { proxy: `${process.env.CORRAL_SERVER_URL || 'http://127.0.0.1:4100'}/api/**` }
      },

  // Set by scripts/dev.ts so several checkouts can run at once
  devServer: {
    port: Number(process.env.CORRAL_WEB_PORT) || 3000
  },

  compatibilityDate: '2026-06-30',

  // Swaps the API for fixtures (app/prototype); a constant, so dev and
  // production builds drop the fixtures entirely
  vite: {
    define: { 'import.meta.prototype': JSON.stringify(prototype) }
  },

  ...(prototype && {
    nitro: { output: { publicDir: 'prototype-dist' } },
    // No icon server and no network: bundle every icon the code names
    icon: { provider: 'none', clientBundle: { scan: { globInclude: ['app/**/*.{vue,ts}'] }, sizeLimitKb: 0 } }
  }),

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
