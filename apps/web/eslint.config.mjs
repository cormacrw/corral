// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import betterTailwindcss from 'eslint-plugin-better-tailwindcss'
import { getDefaultAttributes } from 'eslint-plugin-better-tailwindcss/api/defaults'
import { sharedVocabulary } from '../../eslint.config.mjs'

export default withNuxt(
  // Vendored from shadcn-vue, kept stock so `shadcn-vue diff` stays meaningful
  { ignores: ['app/components/ui/**'] },
  betterTailwindcss.configs['correctness-error'],
  {
    files: ['app/**/*.{ts,vue}'],
    ignores: ['app/queries/**', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '(^|/)queries/api(\\.[cm]?[jt]s)?$',
            message: 'Only app/queries talks to the server: add a query or mutation there. ApiError is exported from ~/queries/client.'
          },
          {
            regex: '(^|/)queries/stream(\\.[cm]?[jt]s)?$',
            importNames: ['subscribeLive', 'subscribeReconnect'],
            message: 'Server events reach pages through the query cache. Add the query to the event in queries/dependencies.ts.'
          }
        ]
      }],
      'no-restricted-syntax': ['error', ...sharedVocabulary, {
        selector: 'ImportExpression[source.value=/(^|\\/)queries\\/api(\\.[cm]?[jt]s)?$/]',
        message: 'Only app/queries talks to the server: add a query or mutation there.'
      }]
    }
  },
  {
    files: ['app/queries/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...sharedVocabulary] }
  },
  {
    settings: {
      'better-tailwindcss': {
        entryPoint: 'app/assets/css/main.css',
        attributes: [
          ...getDefaultAttributes(),
          ['-class$', [{ match: 'strings' }]],
          ['^v-bind:.*-class$', [{ match: 'strings' }]]
        ]
      }
    }
  },
  {
    // The main entry brings zod along. Types are fine; values come from /client.
    // The prototype's fixtures load apart from the app.
    files: ['app/**/*.{ts,vue}'],
    ignores: ['app/prototype/**', 'app/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [{ name: '@corral/contracts', allowTypeImports: true, message: 'Import runtime values from @corral/contracts/client.' }] }]
    }
  }
)
