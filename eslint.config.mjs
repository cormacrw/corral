// @ts-check
// Lint config for every package except apps/web, which has its own Nuxt config.
// Stylistic options match apps/web/nuxt.config.ts so the whole repo reads alike.
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

// Values with one home in @corral/core, re-typed by hand (.corral/wiki/shared-vocabulary.md).
// A package config that sets no-restricted-syntax itself must include these.
export const sharedVocabulary = [
  {
    selector: 'Literal[value="claude-code"]',
    message: 'Runtime ids come from @corral/core: DEFAULT_AGENT_RUNTIME, AGENT_RUNTIMES, runtimeOfCli.'
  },
  {
    selector: 'Literal[regex.pattern="^([A-Za-z]+)-(\\\\d+)$"]',
    message: 'Read task refs with parseTaskRef or TASK_REF_PATTERN from @corral/core.'
  }
]

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', 'apps/web/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  stylistic.configs.customize({ commaDangle: 'never', braceStyle: '1tbs' }),
  {
    rules: {
      // Keep `type X =` on its own line above a multi-line union
      '@stylistic/operator-linebreak': ['error', 'before', { overrides: { '=': 'after' } }]
    }
  },
  {
    files: ['**/*.ts'],
    ignores: ['packages/core/**', '**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...sharedVocabulary] }
  }
)
