import { pmActionTools, pmDirectTools, proposedPlanInput, type AgentTool } from '@corral/contracts'
import { TASK_TYPES, type AgentRole } from '@corral/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { outcomesFor, ROLE_TOOLS, toolsFor, ToolServer } from './mcp.ts'

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

  it('uses the shared plan schema, including defaults, metadata and field errors', async () => {
    const { client, calls } = await connect('pm')
    const input = { title: ' Plan ', tasks: [{ key: 't', title: ' Task ', description: '', type: 'task', design: { taskRef: ' cor-8 ', version: 2 } }] }
    const result = await client.callTool({ name: 'propose_plan', arguments: input })
    expect(result.isError).not.toBe(true)
    expect(calls).toEqual([{ tool: 'propose_plan', input: proposedPlanInput.parse(input) }])
    const listed = (await client.listTools()).tools.find(t => t.name === 'propose_plan')!
    expect(JSON.stringify(listed.inputSchema)).toContain('The design task, e.g. COR-70')
    const invalid = { ...input, tasks: [{ ...input.tasks[0], design: { taskRef: 'COR-8', version: 0 } }] }
    const parsed = proposedPlanInput.safeParse(invalid)
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('Expected invalid version')
    const rejected = await client.callTool({ name: 'propose_plan', arguments: invalid })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain(parsed.error.issues[0]!.message)
    expect(JSON.stringify(rejected.content)).toContain('tasks[0].design.version')
    expect(calls).toHaveLength(1)
    await client.close()
  })

  it('exposes pr_rebased to developers and forwards it over MCP', async () => {
    const { client, calls } = await connect('developer')
    const input = { outcome: 'pr_rebased', review: 'needs_review', conflictedFiles: ['app.ts'], summary: 'Kept both changes in app.ts', note: 'app.ts: kept main validation and task flow' }
    const result = await client.callTool({ name: 'report_outcome', arguments: input })
    expect(result.isError).not.toBe(true)
    expect(calls).toEqual([{ tool: 'report_outcome', input }])
    await client.close()
  })

  it('rejects an unknown outcome before it reaches the server, naming the field', async () => {
    const { client, calls } = await connect('reviewer')
    const result = await client.callTool({ name: 'report_outcome', arguments: { outcome: 'looks_fine', summary: 'Looks good' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('outcome')
    expect(calls).toEqual([])
    await client.close()
  })

  // Claude's API refuses a tool whose input is a top-level union
  it('lists report_outcome with a plain object input', async () => {
    const { client } = await connect('reviewer')
    const { tools } = await client.listTools()
    const schema = tools.find(tool => tool.name === 'report_outcome')!.inputSchema
    expect(schema).toMatchObject({ type: 'object', properties: { outcome: { enum: expect.arrayContaining(['approved', 'pr_opened']) } } })
    expect(schema).not.toHaveProperty('oneOf')
    expect(schema).not.toHaveProperty('anyOf')
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

  it('gives the PM a list_tasks with optional filters and an unindented result', async () => {
    const { client, calls } = await connect('pm')
    const result = await client.callTool({ name: 'list_tasks', arguments: { status: ['ready', 'blocked'], query: 'login' } })
    expect(calls).toEqual([{ tool: 'list_tasks', input: { status: ['ready', 'blocked'], query: 'login', includeMerged: false } }])
    expect(result.content).toEqual([{ type: 'text', text: '{"ref":"own task"}' }])

    await client.callTool({ name: 'list_tasks', arguments: { status: 'merged' } })
    expect(calls.at(-1)?.input).toEqual({ status: 'merged', includeMerged: false })
    expect((await client.callTool({ name: 'list_tasks', arguments: { status: 'done' } })).isError).toBe(true)
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

  it('gives the PM an add_comment that takes a required taskRef and body and passes them through', async () => {
    const { client, calls } = await connect('pm')
    const addComment = (await client.listTools()).tools.find(t => t.name === 'add_comment')!
    expect(addComment.inputSchema).toMatchObject({ type: 'object', properties: { taskRef: { type: 'string' }, body: { type: 'string' } }, required: ['taskRef', 'body'] })

    await client.callTool({ name: 'add_comment', arguments: { taskRef: 'COR-4', body: 'COR-9 changes this' } })
    expect(calls).toEqual([{ tool: 'add_comment', input: { taskRef: 'COR-4', body: 'COR-9 changes this' } }])

    // Without a ref the call is refused before it reaches Corral
    const missing = await client.callTool({ name: 'add_comment', arguments: { body: 'Where?' } })
    expect(missing.isError).toBe(true)
    expect(calls).toHaveLength(1)
    await client.close()
  })

  it('gives the PM evidence uploads with an optional task ref', async () => {
    const { client, calls } = await connect('pm')
    const definition = (await client.listTools()).tools.find(t => t.name === 'attach_evidence')!
    expect(definition.inputSchema).toMatchObject({ properties: { taskRef: { type: 'string' }, path: { type: 'string' } } })
    for (const taskRef of [undefined, 'COR-4']) {
      const input = { kind: 'text', path: '/scratch/notes.txt', ...(taskRef && { taskRef }) }
      expect((await client.callTool({ name: 'attach_evidence', arguments: input })).isError).not.toBe(true)
      expect(calls.at(-1)).toEqual({ tool: 'attach_evidence', input })
    }
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
    expect(propose.description).toContain('To refine an existing Backlog task or an unclaimed Ready task (one no developer has picked up), read it with get_task and include it in the plan with its `ref`')
    expect(propose.inputSchema).toMatchObject({ properties: { tasks: { items: { properties: { ref: { type: 'string' } } } } } })

    const task = { key: 't1', ref: 'COR-4', title: 'Login', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'], dependsOn: ['COR-2'] }
    await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', tasks: [task] } })
    expect(calls).toEqual([{ tool: 'propose_plan', input: expect.objectContaining({ tasks: [expect.objectContaining({ ref: 'COR-4', dependsOn: ['COR-2'] })] }) }])
    await client.close()
  })

  it('lets propose_plan pin a task to a design version and its screens (D20)', async () => {
    const { client, calls } = await connect('pm')
    const propose = (await client.listTools()).tools.find(t => t.name === 'propose_plan')!
    expect(propose.inputSchema).toMatchObject({ properties: { tasks: { items: { properties: { design: { type: 'object', required: ['taskRef', 'version'] } } } } } })

    const task = { key: 't1', title: 'Login', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'] }
    const pin = { taskRef: 'COR-7', version: 2, screens: ['login'] }
    await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', tasks: [{ ...task, design: pin }] } })
    expect(calls).toEqual([{ tool: 'propose_plan', input: expect.objectContaining({ tasks: [expect.objectContaining({ design: pin })] }) }])

    // Structural validation matches the server; core rejects empty screen coverage.
    const empty = await client.callTool({ name: 'propose_plan', arguments: { title: 'Login', tasks: [{ ...task, design: { ...pin, screens: [] } }] } })
    expect(empty.isError).not.toBe(true)
    expect(calls).toHaveLength(2)
    await client.close()
  })

  it('takes an optional review mode per epic in propose_plan and names the allowed values for an unknown one (D27)', async () => {
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

// A subprocess, because the failure is an uncaught exception that ends Node
const ABORTED_REQUEST = `
import { request } from 'node:http'
import { ToolServer } from './src/mcp.ts'

const server = new ToolServer()
await server.start()
server.register('agent', 'developer', async () => ({ ok: true, result: {} }))
const url = new URL(server.url('agent'))

await new Promise((resolve) => {
  const aborted = request(url, { method: 'POST', headers: { 'content-length': '1000' } })
  aborted.on('error', () => {})
  aborted.on('close', resolve)
  aborted.write('{')
  setTimeout(() => aborted.destroy(), 100)
})
await new Promise(resolve => setTimeout(resolve, 100))

const next = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
})
const listed = await next.json()
console.log(listed.result.tools.some(tool => tool.name === 'get_task') ? 'still serving' : 'no tools')
process.exit(0)
`

describe('ToolServer aborted requests', () => {
  it('stays alive and serves the next request when a client drops mid-POST', async () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', ABORTED_REQUEST], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15_000 })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout.trim()).toBe('still serving')
  }, 20_000)
})

// D23: only a designer gets submit_design
describe('toolsFor', () => {
  it('gives a designer the developer\'s tools plus submit_design, before report_outcome', () => {
    const tools = toolsFor({ role: 'designer' })
    expect(tools).toEqual(expect.arrayContaining([...ROLE_TOOLS.developer, 'get_design', 'submit_design']))
    expect(tools).toHaveLength(ROLE_TOOLS.developer.length + 1)
    expect(tools.at(-1)).toBe('report_outcome')
  })

  it('leaves every other role with no submit_design', () => {
    for (const role of ['developer', 'reviewer', 'pm'] as const) {
      expect(toolsFor({ role })).toEqual(ROLE_TOOLS[role])
      expect(toolsFor({ role })).not.toContain('submit_design')
    }
  })

  it('gives the run diagnostics to the PM alone', () => {
    expect(toolsFor({ role: 'pm' })).toEqual(expect.arrayContaining(['get_agent_activity', 'list_runs', 'get_run']))
    for (const role of ['developer', 'designer', 'reviewer'] as const) {
      for (const tool of ['get_agent_activity', 'list_runs', 'get_run'] as const) expect(toolsFor({ role })).not.toContain(tool)
    }
  })

  it('advertises the run diagnostics over MCP to the PM, and refuses them to other roles by name', async () => {
    const server = new ToolServer()
    await server.start()
    try {
      const calls: string[] = []
      server.register('pm', 'pm', async (tool) => {
        calls.push(tool)
        return { ok: true, result: {} }
      })
      const client = new Client({ name: 'test', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url('pm'))))
      const tools = (await client.listTools()).tools
      expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['get_agent_activity', 'list_runs', 'get_run']))
      // Claude's API refuses a tool whose input is a top-level union
      for (const tool of tools) expect(tool.inputSchema.type).toBe('object')
      await client.callTool({ name: 'get_run', arguments: { runNumber: 2857 } })
      await client.callTool({ name: 'list_runs', arguments: { role: 'reviewer', status: 'failed' } })
      expect(calls).toEqual(['get_run', 'list_runs'])
      await client.close()

      for (const role of ['developer', 'designer', 'reviewer'] as const) {
        server.register(role, role, async () => ({ ok: true, result: {} }))
        const other = new Client({ name: 'test', version: '1' })
        await other.connect(new StreamableHTTPClientTransport(new URL(server.url(role))))
        expect((await other.listTools()).tools.map(t => t.name)).not.toContain('get_run')
        expect(await other.callTool({ name: 'get_run', arguments: { runNumber: 1 } })).toEqual({ isError: true, content: [{ type: 'text', text: `The ${role} can't use get_run` }] })
        await other.close()
      }
    } finally {
      // Not awaited: the SDK client keeps its connection open a while
      void server.close()
    }
  })

  it('serves submit_design over MCP only to a designer, and refuses a call naming the role', async () => {
    const server = new ToolServer()
    await server.start()
    try {
      server.register('designer', 'designer', async () => ({ ok: true, result: {} }))
      server.register('developer', 'developer', async () => ({ ok: true, result: {} }))
      const connect = async (secret: string) => {
        const client = new Client({ name: 'test', version: '1' })
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url(secret))))
        return client
      }
      const designer = await connect('designer')
      const developer = await connect('developer')
      expect((await designer.listTools()).tools.map(t => t.name)).toContain('submit_design')
      expect((await developer.listTools()).tools.map(t => t.name)).not.toContain('submit_design')
      expect(await developer.callTool({ name: 'submit_design', arguments: {} })).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'The developer can\'t use submit_design: only a designer submits a design' }]
      })
      await designer.close()
      await developer.close()
    } finally {
      // Not awaited: the SDK client keeps its connection open a while
      void server.close()
    }
  })
})

describe('outcomesFor', () => {
  it('lets a designer report design_submitted and stuck but never a PR outcome', () => {
    expect(outcomesFor('designer')).toEqual(expect.arrayContaining(['design_submitted', 'stuck']))
    for (const outcome of ['pr_opened', 'pr_updated', 'pr_rebased', 'findings_reported']) expect(outcomesFor('designer')).not.toContain(outcome)
  })

  it('leaves design_submitted to designers', () => {
    expect(outcomesFor('developer')).not.toContain('design_submitted')
  })
})
