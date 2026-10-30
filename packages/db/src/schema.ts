// One logical schema and one migration stream, split into a file per feature
// (D14). Add new modules here: this is the file drizzle-kit and the db package
// read, and columns.ts stays out of it because its helpers aren't schema.
//
// Postgres dialect only, and only features PGlite also supports, so the
// same migrations run on both (D14)
//
// Tables reference each other in cycles (tasks and runs, runs and plans), and
// ESM can load those modules in either order. That's safe because of three
// rules:
// - a table only touches another table inside its `references(() => ...)`
//   callback, which Drizzle calls after every module has loaded;
// - anything used while a table is defined comes from enums.ts or columns.ts,
//   which import no tables;
// - the reference that closes a cycle is annotated `(): AnyPgColumn =>`, or
//   TypeScript can't infer the table types.
export * from './schema/attachments.ts'
export * from './schema/deployments.ts'
export * from './schema/designs.ts'
export * from './schema/enums.ts'
export * from './schema/epics.ts'
export * from './schema/plans.ts'
export * from './schema/projects.ts'
export * from './schema/reviews.ts'
export * from './schema/runs.ts'
export * from './schema/system.ts'
export * from './schema/tasks.ts'
export * from './schema/users.ts'
