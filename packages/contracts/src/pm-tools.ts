import { z } from 'zod'
import { createTaskInput, patchTaskInput, patchEpicInput, humanTransitionInput } from './api.ts'
import type { AgentTool } from './runner.ts'

// Shared, authoritative policy: the runner's definition and the server's
// dispatcher both read this flag. A caller cannot opt out of confirmation.
export const pmActionTools = {
  create_task: {
    confirmRequired: false,
    description: 'Create a single Backlog task in this conversation’s project, outside a plan.',
    input: createTaskInput.shape
  },
  update_task: {
    confirmRequired: false,
    description: 'Edit a task in any status. Criteria and dependencies replace the lists; preserve criterion IDs. paused stops or resumes work.',
    input: { taskRef: z.string().trim().min(1), ...patchTaskInput.shape, paused: z.boolean().optional() }
  },
  move_task: {
    confirmRequired: true,
    description: 'Propose a board transition. Human-only transitions run after confirmation. The approve transition places Draft or Backlog on the board; use approve_task for Human review approval.',
    input: { taskRef: z.string().trim().min(1), transition: humanTransitionInput, reason: z.string().trim().min(1).optional() }
  },
  approve_task: {
    confirmRequired: true,
    description: 'Propose approving a task in Human review. Runs only after human confirmation.',
    input: { taskRef: z.string().trim().min(1) }
  },
  update_epic: {
    confirmRequired: false,
    description: 'Edit an epic in this project; dependsOn replaces its epic dependencies.',
    input: { epicId: z.uuid(), ...patchEpicInput.omit({ description: true }).shape, summary: z.string().optional(), dependsOn: z.array(z.uuid()).optional() }
  },
  delete_task: {
    confirmRequired: true,
    description: 'Propose deleting a task in this project. Nothing is deleted until the human clicks Confirm in the conversation. Merged tasks cannot be deleted.',
    input: { taskRef: z.string().trim().min(1), reason: z.string().trim().min(1).optional() }
  }
} satisfies Partial<Record<AgentTool, { confirmRequired: boolean, description: string, input: z.ZodRawShape }>>

export function requiresPmConfirmation(tool: string): tool is keyof typeof pmActionTools {
  return Object.hasOwn(pmActionTools, tool) && pmActionTools[tool as keyof typeof pmActionTools].confirmRequired
}
