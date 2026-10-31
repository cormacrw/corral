import { z } from 'zod'
import { AGENT_RUNTIMES, type AgentRuntime } from './client.ts'

export { AGENT_RUNTIMES, RUNTIMES_TAKING_MESSAGES, type AgentRuntime } from './client.ts'
export const agentRuntime = z.enum(Object.keys(AGENT_RUNTIMES) as [AgentRuntime, ...AgentRuntime[]], {
  message: `Unknown runtime; use one of ${Object.keys(AGENT_RUNTIMES).join(', ')}`
})
