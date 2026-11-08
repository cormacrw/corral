import { DESIGNER_RUN_OUTCOMES, DEVELOPER_RUN_OUTCOMES, EVIDENCE_KINDS, PLAN_APPROVAL_TARGETS, REVIEWER_RUN_OUTCOMES, type AgentRole, type RunOutcome } from '@corral/core'
import { z } from 'zod'
import { EVIDENCE_MAX_BYTES, megabytes } from './limits.ts'
import { reportOutcomeInput } from './outcome-report.ts'
import { advertisedPlanInput } from './plan.ts'
import { askQuestionInput, listTasksInput, pmActionTools, pmDirectTools, type ToolDefinition } from './pm-tools.ts'
import { LEGACY_AGENT_TOOLS, RENAMED_INPUT_TOOLS } from './wire-compat.ts'

// What agents are told they can call, by role. The runner serves these and the
// server checks calls and reports against the same definitions, and both hash
// them into the tool contract (agent-tools.ts).

const reported = (outcome: string) => outcome !== 'rate_limited'
const outcomes: Record<AgentRole, readonly RunOutcome[]> = {
  designer: DESIGNER_RUN_OUTCOMES.filter(reported),
  developer: DEVELOPER_RUN_OUTCOMES.filter(outcome => reported(outcome) && outcome !== 'design_submitted'),
  reviewer: REVIEWER_RUN_OUTCOMES.filter(reported),
  pm: []
}

const FILE_EVIDENCE_KINDS = EVIDENCE_KINDS.filter(kind => kind !== 'note')

// In the order the PM is offered them
const generalTools = {
  attach_evidence: {
    pm: true,
    projectScoped: true,
    description: 'Attach a file as evidence that an acceptance criterion is met. Save the file outside the repository first (your scratch folder), then pass its path. For a criterion with nothing to show, such as a refactor with no behaviour change, leave out path and use kind "note" with a written explanation; a note is not a replacement for screenshots or video of a visible change.',
    input: {
      criterionId: z.string().nullable().optional().describe('The acceptance criterion this proves, or null for the task as a whole'),
      kind: z.enum(EVIDENCE_KINDS).describe(`${FILE_EVIDENCE_KINDS.slice(0, -1).join(', ')} or ${FILE_EVIDENCE_KINDS.at(-1)} for a file; note for a written explanation with no file`),
      note: z.string().optional().describe('What the file shows and how it was produced; for kind note, the explanation of how the criterion is met (required)'),
      path: z.string().min(1).optional().describe('Absolute path of the file to attach; leave out for kind note')
    }
  },
  add_comment: {
    pm: true,
    projectScoped: true,
    description: 'Leave a note on the task for the human and the other agents.',
    input: { body: z.string().min(1).describe('Markdown text') }
  },
  get_agent_activity: {
    pm: true,
    description: 'What the team is doing, across every project: each agent with its role, runtime, status, paused state and pausedUntil, its active runs and a few recent ones. Each run has its state, outcome, project, task or subtask, runner, summary, error and times. Long summaries and errors are shortened. Pass `agent` for one agent with more of its run history.',
    input: { agent: z.string().min(1).optional().describe('An agent\'s name, e.g. Jack; leave out for the whole team') }
  },
  list_tasks: {
    pm: true,
    projectScoped: true,
    description: 'The live board: one compact row per task (ref, title, status, type, priority, parent ref, parentId, dependsOn refs). A task with subtasks shows its computed stage and how many subtasks are done. The `parents` field lists each with its parentId, ref, review mode and dependencies. Merged tasks are left out unless you set includeMerged or ask for that status. Filters combine. Read a task’s description and acceptance criteria with get_task.',
    input: listTasksInput.omit({ epic: true }).shape
  },
  get_task: {
    pm: true,
    projectScoped: true,
    description: 'The task you are working on: title, description, acceptance criteria with their IDs, comments and evidence attached so far.',
    input: {}
  },
  get_run_outcomes: {
    pm: true,
    projectScoped: true,
    description: 'Recent run outcomes for a task.',
    input: { taskRef: z.string().describe('e.g. COR-12') }
  },
  get_attachment: {
    pm: true,
    projectScoped: true,
    description: 'Fetch an image attached to this project’s task text, written there as ![name](attachment:<id>). It comes back as an image, with its file name and mime type.',
    input: { attachmentId: z.string().min(1).describe('The id after attachment: in the image link') }
  },
  get_design: {
    pm: true,
    projectScoped: true,
    description: 'Read a design version (D20): its design.md spec, screenshots, branch and commit. Pass the design task\'s ref, or a build task pinned to a design. With no version you get the design task\'s latest version, or the build task\'s pinned one. Corral saves the spec and screenshots in your scratch folder and extracts the prototype\'s static bundle there; the result lists the paths.',
    input: {
      taskRef: z.string().describe('A design task, or a task pinned to one, e.g. COR-70'),
      version: z.number().int().positive().optional().describe('The version number; leave out for the latest (or pinned) one')
    }
  },
  ask_question: {
    pm: true,
    description: 'Ask the human a question in the Plan conversation. Add `recommendation` with the answer you suggest, and `options` (2–5 short choices) when the answer is one of a few. For a stopped task, mark only choices explicitly authorizing retry in retryOptions; other replies never restart work.',
    input: askQuestionInput.shape
  },
  propose_plan: {
    pm: true,
    projectScoped: true,
    projectHelp: 'Project slug. Required in global sessions. A project session plans only for its own project.',
    description: 'Propose a plan: tasks with acceptance criteria and dependencies. Corral validates it and shows it to the human for approval. A feature with parts that can run in parallel on different code is a task with subtasks: list it in `parents` and put each subtask in it with `parent`. A task planned with subtasks needs at least two. A single unit of work is one task with no subtasks, and work that would run in sequence or change the same files is one task. To add to an existing task, give its ref; to turn a Draft, Backlog or unclaimed Ready task with no runs into a task with subtasks, give that task\'s ref in `parents`: it keeps its ref and comments, and its criteria and dependencies move to its first subtask when the human approves. A revision keeps the task and subtask keys it reuses. To refine an existing Backlog task or an unclaimed Ready task (one no developer has picked up), read it with get_task and include it in the plan with its `ref`: the plan then revises that task instead of creating a new one, and the edits are applied when the human approves; a revised Ready task stays in Ready. Set each task\'s dependsOn to task keys in this plan or refs of existing tasks with subtasks; omit it on revision to preserve dependencies, or use [] to clear them. Pin a task that builds part of an approved design with `design`; only an approved version can be pinned.',
    input: advertisedPlanInput
  },
  approve_plan: {
    pm: true,
    description: 'Approve the current plan on the human\'s behalf, only when their latest message explicitly asks you to (e.g. "looks good, add it to the board"). Never approve on your own initiative. "ready" adds the tasks to the board; "backlog" keeps them for later. A revised Ready task stays in Ready either way.',
    input: { to: z.enum(PLAN_APPROVAL_TARGETS).describe('ready = add to the board; backlog = add to the Backlog') }
  },
  flag_stale_docs: {
    pm: true,
    projectScoped: true,
    description: 'Create a documentation task when the wiki or CORRAL.md no longer matches the code.',
    input: { title: z.string().min(1), description: z.string().min(1) }
  },
  get_evidence: {
    description: 'List the evidence attached to this task, or fetch one item by ID (screenshots come back as images).',
    input: { evidenceId: z.string().optional().describe('Omit to list everything for the current review round') }
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
  }
} satisfies Record<string, ToolDefinition>

export const toolDefinitions = {
  ...generalTools,
  // The confirm-required flag is shared with the server dispatcher.
  ...pmActionTools,
  ...pmDirectTools
} satisfies Record<string, ToolDefinition>

// Tools an agent can call. The runner forwards each one with the run's lease
// epoch, so a stale run's calls are rejected (stale-runners-and-fencing.md).
const AGENT_TOOLS = [...Object.keys(toolDefinitions) as (keyof typeof toolDefinitions)[], ...LEGACY_AGENT_TOOLS]
export const agentToolSchema = z.enum(AGENT_TOOLS)
export type AgentTool = typeof AGENT_TOOLS[number]
export type DefinedTool = keyof typeof toolDefinitions

// Where a role's tool differs: the PM reads and comments on any task in the
// project by ref, while developers and reviewers only ever touch their own
const pmRoleTools = {
  attach_evidence: {
    description: `Attach a file from your scratch directory to this chat, or to a task in this project when taskRef is given. Files are limited to ${megabytes(EVIDENCE_MAX_BYTES)}.`,
    input: { ...toolDefinitions.attach_evidence.input, taskRef: z.string().optional().describe('Task ref, e.g. COR-12; omit to attach to this chat') }
  },
  get_task: {
    description: 'Read any task in this project by ref: title, description, acceptance criteria with their IDs, status, task, dependencies and comments.',
    input: { taskRef: z.string().describe('e.g. COR-12') }
  },
  add_comment: {
    description: 'Leave a note on any task in this project, for the human and the other agents, e.g. that a follow-up task changes its behaviour.',
    input: {
      taskRef: z.string().describe('e.g. COR-12'),
      body: z.string().min(1).describe('Markdown text')
    }
  }
} satisfies Partial<Record<DefinedTool, ToolDefinition>>

const roleToolDefinitions: Record<AgentRole, Partial<Record<DefinedTool, ToolDefinition>>> = {
  designer: {},
  developer: {},
  reviewer: {},
  pm: pmRoleTools
}

type GeneralPmTool = { [T in keyof typeof generalTools]: typeof generalTools[T] extends { pm: true } ? T : never }[keyof typeof generalTools]
export type PmTool = GeneralPmTool | keyof typeof pmActionTools | keyof typeof pmDirectTools
// Older runners' renamed inputs must still name PM tools, or the shim stops applying
RENAMED_INPUT_TOOLS satisfies readonly PmTool[]

// The PM's tools, in the order it is offered them
export const PM_TOOL_NAMES: PmTool[] = [
  ...(Object.keys(generalTools) as (keyof typeof generalTools)[]).filter((tool): tool is GeneralPmTool => (generalTools[tool] as ToolDefinition).pm === true),
  ...Object.keys(pmActionTools) as (keyof typeof pmActionTools)[],
  ...Object.keys(pmDirectTools) as (keyof typeof pmDirectTools)[]
]

export function isPmTool(tool: string): tool is PmTool {
  return (PM_TOOL_NAMES as string[]).includes(tool)
}

export const ROLE_TOOLS: Record<AgentRole, DefinedTool[]> = {
  designer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'submit_design', 'report_outcome'],
  developer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'report_outcome'],
  reviewer: ['get_task', 'add_comment', 'get_evidence', 'get_attachment', 'get_design', 'report_outcome'],
  pm: PM_TOOL_NAMES
}

// The tools a run gets: its role's, except that a developer on a parent's
// delivery run has no task to comment on, attach evidence to or read
// attachments from (D29). Only a designer submits designs (D23).
export function toolsForJob(job: { role: AgentRole, taskId?: string | null | undefined }): readonly DefinedTool[] {
  if (job.role === 'developer' && job.taskId === null) return ['get_task', 'report_outcome']
  return ROLE_TOOLS[job.role]
}

export function toolRefusal(role: AgentRole, tool: string): string {
  return `The ${role} can't use ${tool}${tool === 'submit_design' ? ': only a designer submits a design' : ''}`
}

export function isDefinedTool(tool: string): tool is DefinedTool {
  return Object.hasOwn(toolDefinitions, tool)
}

export function outcomesFor(role: AgentRole): readonly RunOutcome[] {
  return outcomes[role]
}

const PROJECT_HELP = 'Project slug. Required in global sessions; defaults to the session project in project sessions. Name another project to act there.'

export function toolDefinition(role: AgentRole, tool: DefinedTool): ToolDefinition {
  const definition: ToolDefinition = roleToolDefinitions[role][tool] ?? toolDefinitions[tool]
  const general: ToolDefinition = toolDefinitions[tool]
  if (role !== 'pm' || !general.projectScoped) return definition
  return { ...definition, input: { ...definition.input, project: z.string().min(1).optional().describe(general.projectHelp ?? PROJECT_HELP) } }
}

// The PM tools that take the optional `project` input
export function isProjectScopedTool(tool: string): boolean {
  return isDefinedTool(tool) && (toolDefinitions[tool] as ToolDefinition).projectScoped === true
}

export function isGatedTool(tool: string): boolean {
  return isDefinedTool(tool) && (toolDefinitions[tool] as ToolDefinition).gated === true
}

export type ProjectScopedPmTool = { [T in PmTool]: typeof toolDefinitions[T] extends { projectScoped: true } ? T : never }[PmTool]

type PmShape<T extends PmTool> = T extends keyof typeof pmRoleTools ? typeof pmRoleTools[T]['input'] : typeof toolDefinitions[T]['input']
type PmProject<T extends PmTool> = T extends ProjectScopedPmTool ? { project?: string | undefined } : unknown
// A PM call's input as the server reads it
export type PmToolInput<T extends PmTool> = z.output<z.ZodObject<PmShape<T>>> & PmProject<T>

// Strict, so a misspelt field is refused rather than ignored
export function parsePmToolInput<T extends PmTool>(tool: T, input: unknown): PmToolInput<T> {
  return z.object(toolDefinition('pm', tool).input).strict().parse(input) as PmToolInput<T>
}
