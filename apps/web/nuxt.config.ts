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
