import { askQuestionInput, EVIDENCE_KINDS, type AgentTool } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
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
  developer: ['pr_opened', 'pr_updated', 'stuck', 'failed'],
  reviewer: ['approved', 'changes_requested', 'failed'],
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
    description: 'Attach a file as evidence that an acceptance criterion is met. Save the file outside the repository first (your scratch folder), then pass its path.',
    input: {
      criterionId: z.string().nullable().optional().describe('The acceptance criterion this proves, or null for the task as a whole'),
      kind: z.enum(EVIDENCE_KINDS).describe('screenshot, video, test_output, log, request, text or other'),
      note: z.string().optional().describe('What the file shows and how it was produced'),
      path: z.string().min(1).describe('Absolute path of the file to attach')
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
  report_outcome: {
    description: 'Finish your run by reporting what happened. Corral validates it; if something is missing, the call fails and tells you what to fix.',
    input: {
      outcome: z.string().describe('One of the outcomes listed for your role'),
      summary: z.string().min(1).describe('Plain-English summary of what you did, or your question when stuck'),
      criteria: z.array(z.object({
        criterionId: z.string(),
        met: z.boolean(),
        note: z.string().default('')
      })).optional().describe('Reviewer only: a verdict per acceptance criterion')
    }
  },
  list_tasks: {
    description: 'The project’s tasks with their status, so plans reflect the live board.',
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
    description: 'Propose a plan: epics and tasks with acceptance criteria and dependencies. Corral validates it and shows it to the human for approval. Use `epics` to group the tasks of a feature, and put each of those tasks in one with `epic`. A task without `epic` gets no epic, and a plan without `epics` creates none: leave them out for a lone small fix. A revision keeps the epic and task keys it reuses. To refine an existing Backlog task, read it with get_task and include it in the plan with its `ref`: the plan then revises that task instead of creating a new one, and the edits are applied when the human approves.',
    input: {
      title: z.string().min(1),
      summary: z.string().default(''),
      epics: z.array(z.object({
        key: z.string().describe('A short handle used by a task\'s epic, e.g. e1'),
        title: z.string().min(1),
        summary: z.string().default('')
      })).optional(),
      tasks: z.array(z.object({
        key: z.string().describe('A short handle used by dependsOn, e.g. t1'),
        ref: z.string().optional().describe('The ref of an existing Backlog task this revises, e.g. COR-4; leave out for a new task'),
        epic: z.string().optional().describe('The key of its epic in `epics`; leave it out for a task with no epic'),
        title: z.string().min(1),
        description: z.string().min(1),
        type: z.enum(['frontend', 'backend', 'full_stack', 'infrastructure']),
        priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
        humanReview: z.boolean().default(false),
        acceptanceCriteria: z.array(z.string().min(1)).min(1),
        dependsOn: z.array(z.string()).default([]).describe('Keys of tasks in this plan, or refs of existing tasks')
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

// Where a role's tool differs: the PM reads any task in the project by ref,
// while developers and reviewers only ever read their own
const roleToolDefinitions: Record<AgentRole, Partial<Record<AgentTool, ToolDefinition>>> = {
  developer: {},
  reviewer: {},
  pm: {
    get_task: {
      description: 'Read any task in this project by ref: title, description, acceptance criteria with their IDs, status, epic, dependencies and comments.',
      input: { taskRef: z.string().describe('e.g. COR-12') }
    }
  }
}

export const ROLE_TOOLS: Record<AgentRole, AgentTool[]> = {
  developer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'report_outcome'],
  reviewer: ['get_task', 'add_comment', 'get_evidence', 'get_attachment', 'report_outcome'],
  pm: ['list_tasks', 'get_task', 'get_run_outcomes', 'get_attachment', 'ask_question', 'propose_plan', 'approve_plan', 'flag_stale_docs']
}

interface Route {
  role: AgentRole
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

  // Exposes the role's tools at a secret path until the returned function is called
  register(secret: string, role: AgentRole, handler: ToolHandler): () => void {
    this.#routes.set(secret, { role, handler })
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
    for (const name of ROLE_TOOLS[route.role]) {
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
