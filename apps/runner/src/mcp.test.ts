import type { AgentTool } from '@corral/contracts'
import { TASK_TYPES, type AgentRole } from '@corral/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolServer } from './mcp.ts'

// The tools each role sees over MCP, through the SDK client the agent uses
describe('ToolServer', () => {
  const tools = new ToolServer()
  beforeAll(() => tools.start())
  afterAll(() => tools.close())

  // A 1×1 PNG, as the server returns it for a valid attachment id
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const attachmentId = '0b7c2a8e-6f1d-4c3a-9e5b-2d4f6a8c0e1f'

  async function connect(role: AgentRole) {
    const calls: { tool: AgentTool, input: Record<string, unknown> }[] = []
    const secret = `test-${role}`
    tools.register(secret, role, async (tool, input) => {
      calls.push({ tool, input })
      if (tool === 'get_attachment') {
        return input.attachmentId === attachmentId
          ? { ok: true, result: { id: attachmentId, fileName: 'login.png', mimeType: 'image/png', byteSize: 70, images: [{ mimeType: 'image/png', dataBase64: png }] } }
          : { ok: false, error: `${String(input.attachmentId)} isn't an attachment in this project` }
      }
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

  it('tells the PM to refine a Backlog task by ref in propose_plan, and passes the ref through', async () => {
    const { client, calls } = await connect('pm')
    const propose = (await client.listTools()).tools.find(t => t.name === 'propose_plan')!
    expect(propose.description).toContain('To refine an existing Backlog task, read it with get_task and include it in the plan with its `ref`')
    expect(propose.inputSchema).toMatchObject({ properties: { tasks: { items: { properties: { ref: { type: 'string' } } } } } })

    const task = { key: 't1', ref: 'COR-4', title: 'Login', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'], dependsOn: ['COR-2'] }
    await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', tasks: [task] } })
    expect(calls).toEqual([{ tool: 'propose_plan', input: expect.objectContaining({ tasks: [expect.objectContaining({ ref: 'COR-4', dependsOn: ['COR-2'] })] }) }])
    await client.close()
  })

  it('builds the propose_plan task type from TASK_TYPES and rejects the old area types (D19)', async () => {
    const { client, calls } = await connect('pm')
    const propose = (await client.listTools()).tools.find(t => t.name === 'propose_plan')!
    expect(propose.inputSchema).toMatchObject({ properties: { tasks: { items: { properties: { type: { enum: [...TASK_TYPES] } } } } } })

    const task = (type: string) => ({ key: 't1', title: 'Login', description: 'Build it', type, acceptanceCriteria: ['It works'] })
    for (const type of TASK_TYPES) {
      const result = await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', tasks: [task(type)] } })
      expect(result.isError ?? false).toBe(false)
    }
    for (const type of ['frontend', 'backend', 'full_stack', 'infrastructure']) {
      const result = await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', tasks: [task(type)] } })
      expect(result.isError).toBe(true)
    }
    expect(calls.map(c => (c.input.tasks as { type: string }[])[0]!.type)).toEqual(['task', 'bug', 'spike', 'design'])
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

  it.each(['pm', 'developer', 'reviewer'] as const)('gives the %s get_attachment, returning the image with its file name and mime type', async (role) => {
    const { client, calls } = await connect(role)
    const tool = (await client.listTools()).tools.find(t => t.name === 'get_attachment')!
    expect(tool.inputSchema).toMatchObject({ properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'] })

    const result = await client.callTool({ name: 'get_attachment', arguments: { attachmentId } })
    expect(calls).toEqual([{ tool: 'get_attachment', input: { attachmentId } }])
    expect(result.isError).toBeFalsy()
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ id: attachmentId, fileName: 'login.png', mimeType: 'image/png', byteSize: 70 }, null, 2) },
      { type: 'image', data: png, mimeType: 'image/png' }
    ])

    // An id the server refuses (unknown, or another project's) is a tool error with no image
    const refused = await client.callTool({ name: 'get_attachment', arguments: { attachmentId: '00000000-0000-4000-8000-000000000000' } })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([{ type: 'text', text: '00000000-0000-4000-8000-000000000000 isn\'t an attachment in this project' }])
    await client.close()
  })
})
