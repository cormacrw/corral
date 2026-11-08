import tailwindcss from '@tailwindcss/vite'
import { DEFAULT_SERVER_URL } from '@corral/contracts/client'
import { darkNeutralInit } from './app/utils/dark-neutral'

// https://nuxt.com/docs/api/configuration/nuxt-config

// `pnpm prototype` (D20): the same app on fixture data, generated as static
// files with relative paths and hash routes, so it runs from any sub-path in
// a sandboxed iframe with no server. Off for dev and production builds.
const prototype = process.env.CORRAL_PROTOTYPE === '1'
const viewport = { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover' }

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/icon',
    '@nuxtjs/color-mode',
    'shadcn-nuxt'
  ],

  // UI only; all data is live from apps/server (docs/architecture.md)
  ssr: false,

  // Feature folders own their components and composables; names stay global
  // and unique, so a feature can be reorganised without touching its callers
  components: [
    { path: '~/components/app', pathPrefix: false },
    { path: '~/components/shared', pathPrefix: false },
    { path: '~/features', pattern: '*/components/**/*.{vue,ts}', ignore: ['**/*.test.ts'], pathPrefix: false }
  ],
  imports: { dirs: ['features/*/composables'], presets: [{ from: '~/queries/shell', imports: ['useShell'] }] },

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
      ? { script: [{ innerHTML: darkNeutralInit }], meta: [viewport] }
      : {
          script: [{ innerHTML: darkNeutralInit }],
          meta: [
            viewport,
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

  css: ['~/assets/css/main.css', 'vue-sonner/style.css'],

  // A sub-path inside a sandbox can't use history routes or a server
  router: {
    options: { hashMode: prototype }
  },

  colorMode: { classSuffix: '' },

  routeRules: prototype
    ? {}
    : {
        '/api/**': { proxy: `${process.env.CORRAL_SERVER_URL || DEFAULT_SERVER_URL}/api/**` }
      },

  // Set by scripts/dev.ts so several checkouts can run at once
  devServer: {
    port: Number(process.env.CORRAL_WEB_PORT) || 3000
  },

  compatibilityDate: '2026-06-30',

  // Hashed assets are served precompressed when the client accepts it, so
  // direct access to the home server gets them small too (D12)
  nitro: prototype
    ? { output: { publicDir: 'prototype-dist' } }
    : { compressPublicAssets: { gzip: true, brotli: true } },

  // Swaps the API for fixtures (app/prototype); a constant, so dev and
  // production builds drop the fixtures entirely
  vite: {
    plugins: [tailwindcss()],
    define: { 'import.meta.prototype': JSON.stringify(prototype) }
  },

  // No icon server and no network, in every build: bundle each icon the code
  // names. A name built at runtime would not be found, so write names out in full.
  // Its CSS goes in Tailwind's base layer, so `size-*` and other utilities win.
  icon: { provider: 'none', cssLayer: 'base', clientBundle: { scan: { globInclude: ['app/**/*.{vue,ts}'] }, sizeLimitKb: 0 } },

  ...(prototype && { plugins: ['~/prototype/storage.client.ts'] }),

  // A misspelled or unregistered component fails typecheck instead of
  // rendering as an empty unknown element
  typescript: {
    tsConfig: { vueCompilerOptions: { checkUnknownComponents: true } }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  // Stock shadcn-vue primitives, auto-imported as <UiButton> and so on
  shadcn: { prefix: 'Ui', componentDir: '@/components/ui' }
})
