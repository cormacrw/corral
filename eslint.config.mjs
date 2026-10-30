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
  stylistic.configs.customize({ commaDangle: 'never', braceStyle: '1tbs' }),
  {
    rules: {
      // Keep `type X =` on its own line above a multi-line union
      '@stylistic/operator-linebreak': ['error', 'before', { overrides: { '=': 'after' } }]
    }
  },
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/audit.ts', '**/*.test.ts'],
    rules: {
      // Entries go through appendAudit, which links an action to its detail
      'no-restricted-syntax': ['error', {
        selector: 'CallExpression[callee.property.name=/^(insert|update|delete)$/] > :matches(Identifier[name="auditLog"], MemberExpression[property.name="auditLog"])',
        message: 'Write audit entries with appendAudit from audit.ts. The audit log is append-only.'
      }]
    }
  }
)
