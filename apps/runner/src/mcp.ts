import type { AgentTool, RunJob } from '@corral/contracts'
import { outcomesFor, ROLE_TOOLS, toolDefinition, toolDefinitions } from '@corral/contracts/agent-tools'
import type { AgentRole } from '@corral/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

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

// The tools a run gets: its role's alone. Only a designer submits designs (D23)
export function toolsFor(job: Pick<RunJob, 'role'> & Partial<Pick<RunJob, 'taskId'>>): AgentTool[] {
  // A developer on an epic has no task to comment on or attach evidence to (D29)
  if (job.role === 'developer' && job.taskId === null) return ['get_task', 'get_attachment', 'report_outcome']
  return ROLE_TOOLS[job.role] ?? []
}

export function toolRefusal(role: AgentRole, tool: string): string {
  return `The ${role} can't use ${tool}${tool === 'submit_design' ? ': only a designer submits a design' : ''}`
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
    try {
      await this.#serve(route, req, res)
    } catch (error) {
      // This runs detached, so nothing above catches it: a client that drops
      // mid-request must not take the runner down
      if (!res.headersSent) res.writeHead(500).end(error instanceof Error ? error.message : 'MCP error')
    }
  }

  async #serve(route: Route, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = req.method === 'POST' ? await readJson(req) : undefined
    if (body === null) {
      res.writeHead(400).end()
      return
    }
    // The SDK only says an unlisted tool wasn't found; name the role instead
    const call = body as { id?: unknown, method?: unknown, params?: { name?: unknown } } | undefined
    const name = call?.method === 'tools/call' ? String(call.params?.name) : null
    if (name && name in toolDefinitions && !route.tools.includes(name as AgentTool)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call!.id, result: toContent({ ok: false, error: toolRefusal(route.role, name) }, 2) }))
      return
    }
    // Stateless: a fresh server per request, so a resumed agent process can
    // initialise again without a session clash
    const server = new McpServer({ name: 'corral', version: '1' })
    for (const name of route.tools) {
      const definition = toolDefinition(route.role, name)
      server.registerTool(name, { description: definition.description, inputSchema: definition.input }, async (input: Record<string, unknown>) => {
        const outcome = await route.handler(name, input).catch((error: unknown): ToolOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        return toContent(outcome, name === 'list_tasks' ? undefined : 2)
      })
    }
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}

// Null when the body isn't JSON
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

// A board is read as data and can be long, so it goes out without indentation
function toContent(outcome: ToolOutcome, indent: number | undefined) {
  if (!outcome.ok) return { content: [{ type: 'text' as const, text: outcome.error }], isError: true }
  const images = (outcome.result as ImageResult | null)?.images ?? []
  const rest = images.length > 0 ? { ...(outcome.result as object), images: undefined } : outcome.result
  const text = typeof rest === 'string' ? rest : JSON.stringify(rest, null, indent)
  return {
    content: [
      { type: 'text' as const, text },
      ...images.map(image => ({ type: 'image' as const, data: image.dataBase64, mimeType: image.mimeType }))
    ]
  }
}

export { outcomesFor, ROLE_TOOLS }
