import type { AgentTool } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolServer } from './mcp.ts'

// The tools each role sees over MCP, through the SDK client the agent uses
describe('ToolServer', () => {
  const tools = new ToolServer()
  beforeAll(() => tools.start())
  afterAll(() => tools.close())

  async function connect(role: AgentRole) {
    const calls: { tool: AgentTool, input: Record<string, unknown> }[] = []
    const secret = `test-${role}`
    tools.register(secret, role, async (tool, input) => {
      calls.push({ tool, input })
      return { ok: true, result: { ref: input.taskRef ?? 'own task' } }
    })
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(tools.url(secret))))
    return { client, calls }
  }

  it('gives the PM a get_task that takes a required taskRef and passes it through', async () => {
    const { client, calls } = await connect('pm')
    const { tools: listed } = await client.listTools()
    const getTask = listed.find(t => t.name === 'get_task')!
    expect(getTask.description).toContain('Read any task in this project by ref')
    expect(getTask.inputSchema).toMatchObject({ type: 'object', properties: { taskRef: { type: 'string' } }, required: ['taskRef'] })

    const result = await client.callTool({ name: 'get_task', arguments: { taskRef: 'COR-4' } })
    expect(calls).toEqual([{ tool: 'get_task', input: { taskRef: 'COR-4' } }])
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ ref: 'COR-4' }, null, 2) }])

    // Without a ref the call is refused before it reaches Corral
    const missing = await client.callTool({ name: 'get_task', arguments: {} })
    expect(missing.isError).toBe(true)
    expect(calls).toHaveLength(1)
    await client.close()
  })

  it.each(['developer', 'reviewer'] as const)('keeps the %s get_task for its own task, with no input', async (role) => {
    const { client, calls } = await connect(role)
    const getTask = (await client.listTools()).tools.find(t => t.name === 'get_task')!
    expect(getTask.description).toMatch(/^The task you are working on/)
    expect(getTask.inputSchema.properties ?? {}).toEqual({})
    expect(getTask.inputSchema.required ?? []).toEqual([])
    await client.callTool({ name: 'get_task', arguments: {} })
    expect(calls).toEqual([{ tool: 'get_task', input: {} }])
    await client.close()
  })
})
