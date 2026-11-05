import type { AgentRole, TaskStatus } from '@corral/core'
import { z } from 'zod'
import type { RunSessionStart } from './agents.ts'

// Flow durations are milliseconds; an empty sample has both percentiles zero.
export const flowMetricsQuery = z.object({ window: z.enum(['7d', '30d', '90d']).default('30d') })
export type FlowMetricsQuery = z.infer<typeof flowMetricsQuery>
export interface FlowPercentiles {
  medianMs: number
  p90Ms: number
}
// Cycle time across every project (GET /api/metrics/flow), for the window and
// the same span before it
export interface WorkspaceFlow {
  window: FlowMetricsQuery['window']
  current: { mergedTaskCount: number, cycleTime: FlowPercentiles }
  previous: { mergedTaskCount: number, cycleTime: FlowPercentiles }
}
export interface FlowMetrics {
  window: FlowMetricsQuery['window']
  mergedTaskCount: number
  leadTime: FlowPercentiles
  cycleTime: FlowPercentiles
  timeInStatus: (FlowPercentiles & { status: TaskStatus })[]
  runsByRole: { role: AgentRole, queueWait: FlowPercentiles, duration: FlowPercentiles }[]
  averageDeveloperRuns: number
  slowestTasks: { ref: string, leadTimeMs: number, dominantStatus: TaskStatus }[]
  // Rounds keeping a PR healthy that ended in the window (D29): those where the
  // work was reviewed again, and those where it kept its approval
  fixes: { reReviewed: number, skippedReview: number, epicDeveloperRuns: number }
  // Integration reviews that ended in the window, and the epics they covered
  epicReviews: { reviews: number, epics: number, perEpic: number }
  // Developer tokens in the window: up to a task's first submission, and after it
  tokens: { firstBuild: number, followUp: number }
  // Developer runs in the window by round and how their session began. A
  // revision follows the task's first submission; first builds and epic fixes
  // are `other`. `weightedCost` covers only the `costedRuns` with a known cost.
  sessions: { round: 'revision' | 'other', sessionStart: RunSessionStart, runs: number, inputTokens: number, cacheWriteTokens: number, cacheReadTokens: number, outputTokens: number, costedRuns: number, weightedCost: number }[]
}
