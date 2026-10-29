// https://nuxt.com/docs/api/configuration/nuxt-config
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
    head: {
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

  routeRules: {
    '/api/**': { proxy: `${process.env.CORRAL_SERVER_URL || 'http://127.0.0.1:4100'}/api/**` }
  },

  // Set by scripts/dev.ts so several checkouts can run at once
  devServer: {
    port: Number(process.env.CORRAL_WEB_PORT) || 3000
  },

  compatibilityDate: '2026-06-30',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
