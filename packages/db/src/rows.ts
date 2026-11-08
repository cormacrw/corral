import type * as schema from './schema.ts'

// What a select of a whole row returns, for the tables the server passes around
export type ProjectRow = typeof schema.projects.$inferSelect
export type TaskRow = typeof schema.tasks.$inferSelect
export type EpicRow = typeof schema.epics.$inferSelect
export type RunRow = typeof schema.runs.$inferSelect
export type AgentRow = typeof schema.agents.$inferSelect
export type PlanSessionRow = typeof schema.planSessions.$inferSelect
export type OperationRow = typeof schema.taskIntegrationOperations.$inferSelect
export type SubmissionRow = typeof schema.taskSubmissions.$inferSelect
