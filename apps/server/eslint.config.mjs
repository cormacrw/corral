// @ts-check
import root, { sharedVocabulary } from '../../eslint.config.mjs'

export default [
  ...root,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/audit.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...sharedVocabulary, {
        // Entries go through appendAudit, which links an action to its detail
        selector: 'CallExpression[callee.property.name=/^(insert|update|delete)$/] > :matches(Identifier[name="auditLog"], MemberExpression[property.name="auditLog"])',
        message: 'Write audit entries with appendAudit from audit.ts. The audit log is append-only.'
      }]
    }
  }
]
