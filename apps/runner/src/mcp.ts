import { askQuestionInput, EVIDENCE_KINDS, type AgentTool, type RunJob } from '@corral/contracts'
import { EPIC_REVIEW_MODES, TASK_TYPES, type AgentRole } from '@corral/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'

// The per-run MCP server (architecture.md, "Per-run MCP server for agent
// tools"). One HTTP listener on the loopback interface; each run gets a
// secret path. The agent only ever sees these tools, and every call is
// forwarded to the server with the run's lease epoch by the run manager.

export type ToolOutcome =
  | { ok: true, result: unknown }
  | { ok: false, error: string }

export type ToolHandler = (tool: AgentTool, input: Record<string, unknown>) => Promise<ToolOutcome>

// Tool results may carry images (evidence screenshots, task attachments)
interface ImageResult {
  images?: { mimeType: string, dataBase64: string }[]
}

const outcomes: Record<AgentRole, readonly string[]> = {
  developer: ['pr_opened', 'pr_updated', 'pr_rebased', 'findings_reported', 'design_submitted', 'stuck', 'failed'],
  reviewer: ['approved', 'changes_requested', 'blocked', 'failed'],
  pm: []
}

interface ToolDefinition {
  description: string
  input: z.ZodRawShape
}

const toolDefinitions = {
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
    input: {
      outcome: z.string().describe('One of the outcomes listed for your role'),
      summary: z.string().min(1).describe('Plain-English summary of what you did, or your question when stuck'),
      note: z.string().optional().describe('Developer only, required: one line of at most 200 characters saying what this run did, posted as a comment on the task, e.g. "Addressed review: dropped idle-thread fixture"'),
      criteria: z.array(z.object({
        criterionId: z.string(),
        met: z.boolean(),
        note: z.string().default('')
      })).optional().describe('Reviewer only: a verdict per acceptance criterion')
    }
  },
  list_tasks: {
    description: 'The project’s tasks with their status, and epics with dependsOn epic ids, so plans reflect the live board.',
    input: {}
  },
  get_run_outcomes: {
    description: 'Recent run outcomes for a task.',
    input: { taskRef: z.string().describe('e.g. COR-12') }
  },
  ask_question: {
    description: 'Ask the human a question in the Plan conversation. Add `recommendation` with the answer you suggest, and `options` (2–5 short choices) when the answer is one of a few.',
    input: askQuestionInput.shape
  },
  propose_plan: {
    description: 'Propose a plan: epics and tasks with acceptance criteria and dependencies. Corral validates it and shows it to the human for approval. Use `epics` to group the tasks of a feature, and put each of those tasks in one with `epic`. A task without `epic` gets no epic, and a plan without `epics` creates none: leave them out for a lone small fix. A revision keeps the epic and task keys it reuses. To refine an existing Backlog task, read it with get_task and include it in the plan with its `ref`: the plan then revises that task instead of creating a new one, and the edits are applied when the human approves. Set each epic’s dependsOn to epic keys in this plan or existing epic ids from list_tasks; omit it on revision to preserve dependencies, or use [] to clear them. Pin a task that builds part of an approved design with `design`; only an approved version can be pinned.',
    input: {
      title: z.string().min(1),
      summary: z.string().default(''),
      epics: z.array(z.object({
        key: z.string().describe('A short handle used by a task\'s epic, e.g. e1'),
        title: z.string().min(1),
        summary: z.string().default(''),
        dependsOn: z.array(z.string()).optional().describe('Epic keys in this plan or existing epic ids from list_tasks. Omit to keep dependencies in a revision; [] clears them. Tasks wait until prerequisite epics are done.'),
        reviewMode: z.enum(EPIC_REVIEW_MODES, { error: `reviewMode must be one of ${EPIC_REVIEW_MODES.join(', ')}` }).optional()
          .describe('How its tasks reach the target branch: epic = each task merges into an epic branch on review, and the human reviews the epic PR; each_task = the same, but the human also reviews every task; direct = each task merges straight into the target branch. Leave it out for the project\'s default.')
      })).optional(),
      tasks: z.array(z.object({
        key: z.string().describe('A short handle used by dependsOn, e.g. t1'),
        ref: z.string().optional().describe('The ref of an existing Backlog task this revises, e.g. COR-4; leave out for a new task'),
        epic: z.string().optional().describe('The key of its epic in `epics`; leave it out for a task with no epic'),
        title: z.string().min(1),
        description: z.string().min(1),
        type: z.enum(TASK_TYPES),
        priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
        humanReview: z.boolean().default(false),
        acceptanceCriteria: z.array(z.string().min(1)).min(1),
        dependsOn: z.array(z.string()).default([]).describe('Keys of tasks in this plan, or refs of existing tasks'),
        design: z.object({
          taskRef: z.string().describe('The design task, e.g. COR-70'),
          version: z.number().int().positive().describe('Its approved version'),
          screens: z.array(z.string().min(1)).min(1).describe('Ids of the screens in design.md this task builds')
        }).optional().describe('For a task that builds part of an approved design: the version and the screens it covers')
      })).min(1)
    }
  },
  approve_plan: {
    description: 'Approve the current plan on the human\'s behalf, only when their latest message explicitly asks you to (e.g. "looks good, add it to the board"). Never approve on your own initiative. "ready" adds the tasks to the board; "backlog" keeps them for later.',
    input: { to: z.enum(['ready', 'backlog']).describe('ready = add to the board; backlog = add to the Backlog') }
  },
  flag_stale_docs: {
    description: 'Create a documentation task when the wiki or CORRAL.md no longer matches the code.',
    input: { title: z.string().min(1), description: z.string().min(1) }
  }
} satisfies Record<AgentTool, ToolDefinition>

// Where a role's tool differs: the PM reads and comments on any task in the
// project by ref, while developers and reviewers only ever touch their own
const roleToolDefinitions: Record<AgentRole, Partial<Record<AgentTool, ToolDefinition>>> = {
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
  developer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'report_outcome'],
  reviewer: ['get_task', 'add_comment', 'get_evidence', 'get_attachment', 'get_design', 'report_outcome'],
  pm: ['attach_evidence', 'list_tasks', 'get_task', 'add_comment', 'get_run_outcomes', 'get_attachment', 'get_design', 'ask_question', 'propose_plan', 'approve_plan', 'flag_stale_docs']
}

// The tools a run gets: its role's, plus submit_design for a design task's
// developer (D20)
export function toolsFor(job: Pick<RunJob, 'role' | 'taskType'>): AgentTool[] {
  const tools = ROLE_TOOLS[job.role] ?? []
  if (job.role === 'developer' && job.taskType === 'design') return [...tools.slice(0, -1), 'submit_design', ...tools.slice(-1)]
  return tools
}

interface Route {
  role: AgentRole
  tools: readonly AgentTool[]
  handler: ToolHandler
}

export class ToolServer {
  #http: Server | null = null
  #routes = new Map<string, Route>()
  #port = 0

  async start(): Promise<void> {
    this.#http = createServer((req, res) => void this.#handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.#http!.once('error', reject)
      // Loopback only: the agent runs on this machine (D12)
      this.#http!.listen(0, '127.0.0.1', () => resolve())
    })
    this.#port = (this.#http.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.#http?.close(() => resolve()) ?? resolve())
  }

  url(secret: string): string {
    return `http://127.0.0.1:${this.#port}/runs/${secret}`
  }

  // Exposes the role's tools (or the given ones) at a secret path until the
  // returned function is called
  register(secret: string, role: AgentRole, handler: ToolHandler, tools: readonly AgentTool[] = ROLE_TOOLS[role]): () => void {
    this.#routes.set(secret, { role, tools, handler })
    return () => this.#routes.delete(secret)
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const secret = /^\/runs\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '')?.[1]
    const route = secret ? this.#routes.get(secret) : undefined
    if (!route) {
      res.writeHead(404).end()
      return
    }
    // Stateless: a fresh server per request, so a resumed agent process can
    // initialise again without a session clash
    const server = new McpServer({ name: 'corral', version: '1' })
    for (const name of route.tools) {
      const definition = roleToolDefinitions[route.role][name] ?? toolDefinitions[name]
      server.registerTool(name, { description: definition.description, inputSchema: definition.input }, async (input: Record<string, unknown>) => {
        const outcome = await route.handler(name, input).catch((error: unknown): ToolOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        return toContent(outcome)
      })
    }
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(error instanceof Error ? error.message : 'MCP error')
    }
  }
}

function toContent(outcome: ToolOutcome) {
  if (!outcome.ok) return { content: [{ type: 'text' as const, text: outcome.error }], isError: true }
  const images = (outcome.result as ImageResult | null)?.images ?? []
  const rest = images.length > 0 ? { ...(outcome.result as object), images: undefined } : outcome.result
  const text = typeof rest === 'string' ? rest : JSON.stringify(rest, null, 2)
  return {
    content: [
      { type: 'text' as const, text },
      ...images.map(image => ({ type: 'image' as const, data: image.dataBase64, mimeType: image.mimeType }))
    ]
  }
}

export function outcomesFor(role: AgentRole): readonly string[] {
  return outcomes[role]
}
