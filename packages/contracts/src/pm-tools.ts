import { z } from 'zod'
import type { AgentTool } from './runner.ts'

// Shared, authoritative policy: the runner's definition and the server's
// dispatcher both read this flag. A caller cannot opt out of confirmation.
export const pmActionTools = {
  delete_task: {
    confirmRequired: true,
    description: 'Propose deleting a task in this project. Nothing is deleted until the human clicks Confirm in the conversation. Merged tasks cannot be deleted.',
    input: { taskRef: z.string().trim().min(1), reason: z.string().trim().min(1).optional() }
  }
} satisfies Partial<Record<AgentTool, { confirmRequired: boolean, description: string, input: z.ZodRawShape }>>

export function requiresPmConfirmation(tool: string): tool is keyof typeof pmActionTools {
  return Object.hasOwn(pmActionTools, tool) && pmActionTools[tool as keyof typeof pmActionTools].confirmRequired
}
