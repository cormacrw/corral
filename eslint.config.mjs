// @ts-check
// Lint config for every package except apps/web, which has its own Nuxt config.
// Stylistic options match apps/web/nuxt.config.ts so the whole repo reads alike.
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', 'apps/web/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  stylistic.configs.customize({ commaDangle: 'never', braceStyle: '1tbs' })
)
