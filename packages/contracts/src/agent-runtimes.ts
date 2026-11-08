import { AGENT_RUNTIME_IDS } from '@corral/core'
import { z } from 'zod'

export const agentRuntime = z.enum(AGENT_RUNTIME_IDS, {
  message: `Unknown runtime; use one of ${AGENT_RUNTIME_IDS.join(', ')}`
})
