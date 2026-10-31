// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import betterTailwindcss from 'eslint-plugin-better-tailwindcss'
import { getDefaultAttributes } from 'eslint-plugin-better-tailwindcss/api/defaults'

export default withNuxt(
  betterTailwindcss.configs['correctness-error'],
  {
    files: ['app/**/*.{ts,vue}'],
    ignores: ['app/queries/**', '**/*.test.ts'],
    rules: {
      // nuxt.config.ts keeps these out of auto-imports too
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '(^|/)useApi$',
            message: 'Only app/queries talks to the server: add a query or mutation there. ApiError is exported from ~/queries/client.'
          },
          {
            regex: '(^|/)useLive$',
            importNames: ['subscribeLive', 'subscribeReconnect'],
            message: 'Server events reach pages through the query cache. Add the query to the event in queries/dependencies.ts.'
          }
        ]
      }]
    }
  },
  {
    settings: {
      'better-tailwindcss': {
        entryPoint: 'app/assets/css/main.css',
        attributes: [
          ...getDefaultAttributes(),
          ['^v-bind:ui$', [{ match: 'objectValues' }]]
        ]
      }
    }
  }
)
