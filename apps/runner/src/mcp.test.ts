import { pmActionTools, pmDirectTools, type AgentTool } from '@corral/contracts'
import { TASK_TYPES, type AgentRole } from '@corral/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROLE_TOOLS, toolsFor, ToolServer } from './mcp.ts'

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

  it('exposes pr_rebased to developers and forwards it over MCP', async () => {
    const { client, calls } = await connect('developer')
    const input = { outcome: 'pr_rebased', summary: 'Kept both changes in app.ts', note: 'app.ts: kept main validation and task flow' }
    const result = await client.callTool({ name: 'report_outcome', arguments: input })
    expect(result.isError).not.toBe(true)
    expect(calls).toEqual([{ tool: 'report_outcome', input }])
    await client.close()
  })

  it('exposes blocked to reviewers and forwards it over MCP', async () => {
    const { client, calls } = await connect('reviewer')
    const input = { outcome: 'blocked', summary: 'main changed a binding decision used by the criteria' }
    const result = await client.callTool({ name: 'report_outcome', arguments: input })
    expect(result.isError).not.toBe(true)
    expect(calls).toEqual([{ tool: 'report_outcome', input }])
    await client.close()
  })

  it('exposes typed PM mutations and forwards their inputs', async () => {
    const { client, calls } = await connect('pm')
    const listed = (await client.listTools()).tools
    for (const name of ['create_task', 'update_task', 'move_task', 'approve_task', 'delete_task', 'update_epic']) {
      expect(listed.some(t => t.name === name)).toBe(true)
      expect(ROLE_TOOLS.developer).not.toContain(name)
      expect(ROLE_TOOLS.reviewer).not.toContain(name)
    }
    const update = listed.find(t => t.name === 'update_task')!
    expect(update.inputSchema).toMatchObject({ required: ['taskRef'], properties: { paused: { type: 'boolean' }, acceptanceCriteria: { type: 'array' } } })
    const input = { taskRef: 'COR-4', title: 'New title', priority: 'high', paused: true }
    expect((await client.callTool({ name: 'update_task', arguments: input })).isError).not.toBe(true)
    expect(calls).toEqual([{ tool: 'update_task', input }])
    expect(listed.find(t => t.name === 'approve_task')!.description).toContain('confirmation')
    await client.close()
  })

  it('registers thread tools only for the PM and validates their inputs over MCP', async () => {
    const { client, calls } = await connect('pm')
    const listed = (await client.listTools()).tools
    for (const name of ['start_thread', 'list_threads', 'read_thread', 'message_thread', 'close_thread']) {
      expect(listed.some(t => t.name === name)).toBe(true)
      expect(ROLE_TOOLS.developer).not.toContain(name)
      expect(ROLE_TOOLS.reviewer).not.toContain(name)
    }
    const input = { title: 'Inspect code', message: 'Read the entry point', project: 'test-app', runtime: 'codex' }
    expect((await client.callTool({ name: 'start_thread', arguments: input })).isError).not.toBe(true)
    expect(calls).toEqual([{ tool: 'start_thread', input }])
    expect((await client.callTool({ name: 'start_thread', arguments: { title: 'Missing message' } })).isError).toBe(true)
    expect((await client.callTool({ name: 'read_thread', arguments: { threadId: attachmentId, limit: 101 } })).isError).toBe(true)
    expect(calls).toHaveLength(1)
    await client.close()
  })

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

  it('passes project slugs through every project-scoped PM tool', async () => {
    const { client, calls } = await connect('pm')
    const tools = (await client.listTools()).tools
    const scoped = ['list_tasks', 'get_task', 'get_run_outcomes', 'get_attachment', 'get_design', 'propose_plan', 'flag_stale_docs', 'create_task', 'update_task', 'move_task', 'approve_task', 'delete_task', 'update_epic']
    for (const name of scoped) {
      expect(tools.find(t => t.name === name)?.inputSchema.properties, name).toHaveProperty('project')
    }
    // The server's inputs are strict: an advertised `project` it doesn't take is refused
    for (const [name, { input }] of Object.entries({ ...pmActionTools, ...pmDirectTools })) {
      if (scoped.includes(name) || 'project' in input) continue
      expect(tools.find(t => t.name === name)?.inputSchema.properties ?? {}, name).not.toHaveProperty('project')
    }
    expect(tools.find(t => t.name === 'set_update_hold')?.inputSchema.properties ?? {}).not.toHaveProperty('project')
    expect(tools.find(t => t.name === 'ask_question')?.inputSchema.properties).not.toHaveProperty('project')
    expect((tools.find(t => t.name === 'delete_project')?.inputSchema as { required?: string[] }).required).toContain('project')
    expect(tools.find(t => t.name === 'list_projects')?.inputSchema.properties).not.toHaveProperty('project')
    await client.callTool({ name: 'list_tasks', arguments: { project: 'another-project' } })
    await client.callTool({ name: 'get_task', arguments: { project: 'another-project', taskRef: 'OTH-1' } })
    expect(calls).toEqual([
      { tool: 'list_tasks', input: { project: 'another-project' } },
      { tool: 'get_task', input: { project: 'another-project', taskRef: 'OTH-1' } }
    ])
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

  it('lets propose_plan pin a task to a design version and its screens (D20)', async () => {
    const { client, calls } = await connect('pm')
    const propose = (await client.listTools()).tools.find(t => t.name === 'propose_plan')!
    expect(propose.inputSchema).toMatchObject({ properties: { tasks: { items: { properties: { design: { type: 'object', required: ['taskRef', 'version', 'screens'] } } } } } })

    const task = { key: 't1', title: 'Login', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'] }
    const pin = { taskRef: 'COR-7', version: 2, screens: ['login'] }
    await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', tasks: [{ ...task, design: pin }] } })
    expect(calls).toEqual([{ tool: 'propose_plan', input: expect.objectContaining({ tasks: [expect.objectContaining({ design: pin })] }) }])

    // A pin without screens is refused before it reaches Corral
    const empty = await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', tasks: [{ ...task, design: { ...pin, screens: [] } }] } })
    expect(empty.isError).toBe(true)
    expect(calls).toHaveLength(1)
    await client.close()
  })

  it('takes an optional review mode per epic in propose_plan and names the allowed values for an unknown one (D23)', async () => {
    const { client, calls } = await connect('pm')
    const propose = (await client.listTools()).tools.find(t => t.name === 'propose_plan')!
    expect(propose.inputSchema).toMatchObject({ properties: { epics: { items: { properties: { reviewMode: { enum: ['epic', 'each_task', 'direct'] } } } } } })

    const task = { key: 't1', epic: 'e1', title: 'Login', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'] }
    await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', epics: [{ key: 'e1', title: 'Login', reviewMode: 'each_task' }], tasks: [task] } })
    expect(calls).toEqual([{ tool: 'propose_plan', input: expect.objectContaining({ epics: [expect.objectContaining({ reviewMode: 'each_task' })] }) }])

    const unknown = await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', epics: [{ key: 'e1', title: 'Login', reviewMode: 'later' }], tasks: [task] } })
    expect(unknown.isError).toBe(true)
    expect(JSON.stringify(unknown.content)).toContain('reviewMode must be one of epic, each_task, direct')
    expect(calls).toHaveLength(1)
    await client.close()
  })

  it('gives the PM get_design with an optional version', async () => {
    const { client, calls } = await connect('pm')
    const getDesign = (await client.listTools()).tools.find(t => t.name === 'get_design')!
    expect(getDesign.inputSchema).toMatchObject({ properties: { taskRef: { type: 'string' }, version: { type: 'integer' } }, required: ['taskRef'] })
    await client.callTool({ name: 'get_design', arguments: { taskRef: 'COR-7' } })
    expect(calls).toEqual([{ tool: 'get_design', input: { taskRef: 'COR-7' } }])
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

// D20: only a design task's developer gets submit_design
describe('toolsFor', () => {
  it('adds submit_design for a design task\'s developer, before report_outcome', () => {
    const tools = toolsFor({ role: 'developer', taskType: 'design' })
    expect(tools).toContain('submit_design')
    expect(tools.at(-1)).toBe('report_outcome')
  })

  it('leaves every other run with its role\'s tools', () => {
    for (const taskType of ['task', 'bug', 'spike', null, undefined] as const) {
      expect(toolsFor({ role: 'developer', taskType })).toEqual(ROLE_TOOLS.developer)
    }
    expect(toolsFor({ role: 'reviewer', taskType: 'design' })).toEqual(ROLE_TOOLS.reviewer)
    expect(ROLE_TOOLS.developer).not.toContain('submit_design')
  })

  it('serves submit_design over MCP only where it was registered', async () => {
    const server = new ToolServer()
    await server.start()
    try {
      server.register('design-dev', 'developer', async () => ({ ok: true, result: {} }), toolsFor({ role: 'developer', taskType: 'design' }))
      server.register('task-dev', 'developer', async () => ({ ok: true, result: {} }))
      const names = async (secret: string) => {
        const client = new Client({ name: 'test', version: '1' })
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url(secret))))
        const listed = (await client.listTools()).tools.map(t => t.name)
        await client.close()
        return listed
      }
      expect(await names('design-dev')).toContain('submit_design')
      expect(await names('task-dev')).not.toContain('submit_design')
    } finally {
      // Not awaited: the SDK client keeps its connection open a while
      void server.close()
    }
  })
})
