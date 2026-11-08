import type { AgentRole } from '@corral/core'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { outcomesFor, ROLE_TOOLS, toolDefinition } from './tool-definitions.ts'

// Both sides hash the agent tools: AGENT_TOOL_CONTRACT goes in the runner's
// hello, and the server gives no new runs to one that differs (COR-435). Node
// only, which is why it's its own entry rather than part of the index web imports.

// Exactly what a role's agent sees: names, descriptions and input schemas, plus
// the outcomes its report_outcome takes. Exported for the test that pins it.
export function agentToolManifest() {
  return Object.fromEntries((Object.keys(ROLE_TOOLS) as AgentRole[]).sort().map(role => [role, {
    outcomes: outcomesFor(role),
    tools: Object.fromEntries(ROLE_TOOLS[role].map((tool) => {
      const { description, input } = toolDefinition(role, tool)
      return [tool, { description, input: z.toJSONSchema(z.object(input), { io: 'input', unrepresentable: 'any' }) }]
    }))
  }]))
}

export const toolContractHash = (manifest: unknown) => createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16)

export const AGENT_TOOL_CONTRACT = toolContractHash(agentToolManifest())
