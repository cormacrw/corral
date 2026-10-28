import { defineConfig } from 'drizzle-kit'

// `pnpm --filter @corral/db generate` writes a migration for schema changes.
// The same migrations run on Postgres and PGlite (D14).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  casing: 'snake_case'
})
