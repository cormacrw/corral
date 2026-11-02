import { DESIGNER_RUN_OUTCOMES, DEVELOPER_RUN_OUTCOMES, REVIEWER_RUN_OUTCOMES, type AgentRole } from '@corral/core'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pmDirectTools, type PmDirectTool } from './pm-tools.ts'
import { askQuestionInput, listTasksInput, proposedPlanInput, EVIDENCE_KINDS, reportOutcomeInput, type AgentTool } from './index.ts'

// What agents are told they can call, by role. The runner serves these and the
// server checks reports against the same schemas, so a runner built from other
// definitions would offer agents a tool the server doesn't agree with. Both
// sides hash this file's result: AGENT_TOOL_CONTRACT goes in the runner's hello,
// and the server gives no new runs to one that differs (COR-435). Node only,
// which is why it's its own entry rather than part of the index web imports.

const reported = (outcome: string) => outcome !== 'rate_limited'
const outcomes: Record<AgentRole, readonly string[]> = {
  designer: DESIGNER_RUN_OUTCOMES.filter(reported),
  developer: DEVELOPER_RUN_OUTCOMES.filter(outcome => reported(outcome) && outcome !== 'design_submitted'),
  reviewer: REVIEWER_RUN_OUTCOMES.filter(reported),
  pm: []
}

export interface ToolDefinition {
  description: string
  input: z.ZodRawShape
}

export const toolDefinitions = {
  ...pmDirectTools,
  get_task: {
    description: 'The task you are working on: title, description, acceptance criteria with their IDs, comments and evidence attached so far.',
    input: {}
  },
  add_comment: {
    description: 'Leave a note on the task for the human and the other agents.',
    input: { body: z.string().min(1).describe('Markdown text') }
  },
  attach_evidence: {
    description: 'Attach a file as evidence that an acceptance criterion is met. Save the file outside the repository first (your scratch folder), then pass its path. For a criterion with nothing to show, such as a refactor with no behaviour change, leave out path and use kind "note" with a written explanation; a note is not a replacement for screenshots or video of a visible change.',
    input: {
      criterionId: z.string().nullable().optional().describe('The acceptance criterion this proves, or null for the task as a whole'),
      kind: z.enum(EVIDENCE_KINDS).describe('screenshot, video, test_output, log, request, text or other for a file; note for a written explanation with no file'),
      note: z.string().optional().describe('What the file shows and how it was produced; for kind note, the explanation of how the criterion is met (required)'),
      path: z.string().min(1).optional().describe('Absolute path of the file to attach; leave out for kind note')
    }
  },
  get_evidence: {
    description: 'List the evidence attached to this task, or fetch one item by ID (screenshots come back as images).',
    input: { evidenceId: z.string().optional().describe('Omit to list everything for the current review round') }
  },
  get_attachment: {
    description: 'Fetch an image attached to this project’s task text, written there as ![name](attachment:<id>). It comes back as an image, with its file name and mime type.',
    input: { attachmentId: z.string().min(1).describe('The id after attachment: in the image link') }
  },
  get_design: {
    description: 'Read a design version (D20): its design.md spec, screenshots, branch and commit. Pass the design task\'s ref, or a build task pinned to a design. With no version you get the design task\'s latest version, or the build task\'s pinned one. Corral saves the spec and screenshots in your scratch folder and extracts the prototype\'s static bundle there; the result lists the paths.',
    input: {
      taskRef: z.string().describe('A design task, or a task pinned to one, e.g. COR-70'),
      version: z.number().int().positive().optional().describe('The version number; leave out for the latest (or pinned) one')
    }
  },
  submit_design: {
    description: 'Design tasks only (D20): submit your prototype as a new design version. Pass the folder of the static bundle (it must have index.html at its root, with relative paths to its assets), the path of design.md and the screenshot paths. Corral pushes your branch and uploads the files; the version is recorded at the pushed commit. Commit your work first. Then finish with report_outcome "design_submitted".',
    input: {
      bundleDir: z.string().min(1).describe('Absolute path of the folder holding the static bundle, with index.html at its root'),
      specPath: z.string().min(1).describe('Absolute path of design.md'),
      screenshots: z.array(z.string().min(1)).min(1).describe('Absolute paths of the screenshots (PNG, JPEG or WebP), at least one per screen, desktop and mobile widths')
    }
  },
  report_outcome: {
    description: 'Finish your run by reporting what happened. Corral validates it; if something is missing, the call fails and tells you what to fix.',
    input: reportOutcomeInput.shape
  },
  list_tasks: {
    description: 'The live board: one compact row per task (ref, title, status, type, priority, epicId, dependsOn refs), and every epic with its dependsOn epic ids. Merged tasks are left out unless you set includeMerged or ask for that status. Filters combine. Read a task’s description and acceptance criteria with get_task.',
    input: listTasksInput.shape
  },
  get_run_outcomes: {
    description: 'Recent run outcomes for a task.',
    input: { taskRef: z.string().describe('e.g. COR-12') }
  },
  get_agent_activity: {
    description: 'What the team is doing, across every project: each agent with its role, runtime, status, paused state and pausedUntil, its active runs and a few recent ones. Each run has its state, outcome, project, task or epic, runner, summary, error and times. Long summaries and errors are shortened. Pass `agent` for one agent with more of its run history.',
    input: { agent: z.string().min(1).optional().describe('An agent\'s name, e.g. Jack; leave out for the whole team') }
  },
  ask_question: {
    description: 'Ask the human a question in the Plan conversation. Add `recommendation` with the answer you suggest, and `options` (2–5 short choices) when the answer is one of a few.',
    input: askQuestionInput.shape
  },
  propose_plan: {
    description: 'Propose a plan: epics and tasks with acceptance criteria and dependencies. Corral validates it and shows it to the human for approval. Use `epics` to group the tasks of a feature, and put each of those tasks in one with `epic`. A task without `epic` gets no epic, and a plan without `epics` creates none: leave them out for an independent fix. A big feature always gets an epic, even with a single task. Split a feature into tasks only when the parts can run in parallel on different code; work that would run in sequence or change the same files is one task. A revision keeps the epic and task keys it reuses. To refine an existing Backlog task or an unclaimed Ready task (one no developer has picked up), read it with get_task and include it in the plan with its `ref`: the plan then revises that task instead of creating a new one, and the edits are applied when the human approves; a revised Ready task stays in Ready. Set each epic’s dependsOn to epic keys in this plan or existing epic ids from list_tasks; omit it on revision to preserve dependencies, or use [] to clear them. Pin a task that builds part of an approved design with `design`; only an approved version can be pinned.',
    input: proposedPlanInput.shape
  },
  approve_plan: {
    description: 'Approve the current plan on the human\'s behalf, only when their latest message explicitly asks you to (e.g. "looks good, add it to the board"). Never approve on your own initiative. "ready" adds the tasks to the board; "backlog" keeps them for later. A revised Ready task stays in Ready either way.',
    input: { to: z.enum(['ready', 'backlog']).describe('ready = add to the board; backlog = add to the Backlog') }
  },
  flag_stale_docs: {
    description: 'Create a documentation task when the wiki or CORRAL.md no longer matches the code.',
    input: { title: z.string().min(1), description: z.string().min(1) }
  }
} satisfies Record<AgentTool, ToolDefinition>

// Where a role's tool differs: the PM reads and comments on any task in the
// project by ref, while developers and reviewers only ever touch their own
export const roleToolDefinitions: Record<AgentRole, Partial<Record<AgentTool, ToolDefinition>>> = {
  designer: {},
  developer: {},
  reviewer: {},
  pm: {
    attach_evidence: {
      description: 'Attach a file from your scratch directory to this chat, or to a task in this project when taskRef is given. Files are limited to 25 MB.',
      input: { ...toolDefinitions.attach_evidence.input, taskRef: z.string().optional().describe('Task ref, e.g. COR-12; omit to attach to this chat') }
    },
    get_task: {
      description: 'Read any task in this project by ref: title, description, acceptance criteria with their IDs, status, epic, dependencies and comments.',
      input: { taskRef: z.string().describe('e.g. COR-12') }
    },
    add_comment: {
      description: 'Leave a note on any task in this project, for the human and the other agents, e.g. that a follow-up task changes its behaviour.',
      input: {
        taskRef: z.string().describe('e.g. COR-12'),
        body: z.string().min(1).describe('Markdown text')
      }
    }
  }
}

export const ROLE_TOOLS: Record<AgentRole, AgentTool[]> = {
  designer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'submit_design', 'report_outcome'],
  developer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'report_outcome'],
  reviewer: ['get_task', 'add_comment', 'get_evidence', 'get_attachment', 'get_design', 'report_outcome'],
  pm: ['attach_evidence', 'list_tasks', 'get_task', 'add_comment', 'get_run_outcomes', 'get_agent_activity', 'get_attachment', 'get_design', 'ask_question', 'propose_plan', 'approve_plan', 'flag_stale_docs', ...Object.keys(pmDirectTools) as PmDirectTool[]]
}

export function outcomesFor(role: AgentRole): readonly string[] {
  return outcomes[role]
}

export function toolDefinition(role: AgentRole, tool: AgentTool): ToolDefinition {
  return roleToolDefinitions[role][tool] ?? toolDefinitions[tool]
}

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

export const AGENT_TOOL_CONTRACT = createHash('sha256').update(JSON.stringify(agentToolManifest())).digest('hex').slice(0, 16)
