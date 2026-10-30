import type { AgentRole, TaskStatus } from '@corral/core'
import { z } from 'zod'

// Flow durations are milliseconds; an empty sample has both percentiles zero.
export const flowMetricsQuery = z.object({ window: z.enum(['7d', '30d', '90d']).default('30d') })
export type FlowMetricsQuery = z.infer<typeof flowMetricsQuery>
export interface FlowPercentiles {
  medianMs: number
  p90Ms: number
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
}
