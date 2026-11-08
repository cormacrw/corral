import { CORRAL_MCP_SERVER, outcomesFor, SPIKE_OPENS_NO_PR, TOOL_CALL_TIMEOUT_MS, toolsForJob, type AgentTool, type DesignForAgent, type RunJob, type RunnerMessage, type ServerMessage } from '@corral/contracts'
import { isAuthoringRole, isCommitOutcome, shortSha } from '@corral/core'
import { randomBytes, randomUUID } from 'node:crypto'
import type { McpServer } from './agent-runtime.ts'
import { packDesign, saveDesign } from './designs.ts'
import { readEvidence } from './evidence.ts'
import type { ToolOutcome, ToolServer } from './mcp.ts'
import type { Run } from './run.ts'
import type { RunConnection } from './run-outbox.ts'
import { pinnedDesignNote } from './run-prompt.ts'
import { headSha, mergeBase, pushBranch } from './workspace.ts'

// The agent's Corral tools (architecture.md, "Per-run MCP server for agent
// tools"). Calls are forwarded to the server with the run's lease epoch; a few
// need the runner's own work first: evidence files are read, designs are saved
// and packed, and a report that carries a commit pushes it (D8).

const UNREACHABLE = 'Corral is unreachable right now. Wait a moment and try again.'
const RUN_OVER = 'This run is over. Stop working.'

type Pushed = { ok: true, result: string } | { ok: false, error: string }

export class RunTools {
  #connection: RunConnection
  #server: ToolServer
  #pendingCalls = new Map<string, { resolve: (o: ToolOutcome) => void, timer: NodeJS.Timeout }>()

  constructor(connection: RunConnection, server: ToolServer) {
    this.#connection = connection
    this.#server = server
  }

  // Serves the job's tools at a new secret path until unregistered. Each call
  // goes to the run `current` names; a warm process outlives its runs.
  serve(job: RunJob, current: () => Run | null): { mcpServers: Record<string, McpServer>, unregister: () => void } {
    const secret = randomBytes(24).toString('base64url')
    const unregister = this.#server.register(secret, job.role, (tool, input) => {
      const run = current()
      return run ? this.#call(run, tool, input) : Promise.resolve({ ok: false, error: RUN_OVER })
    }, toolsForJob(job))
    return { mcpServers: { [CORRAL_MCP_SERVER]: { type: 'http', url: this.#server.url(secret) } }, unregister }
  }

  // The server's answer to a forwarded call
  answered(message: Extract<ServerMessage, { type: 'tool.result' }>): void {
    const pending = this.#pendingCalls.get(message.callId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pendingCalls.delete(message.callId)
    pending.resolve(message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error })
  }

  // A tool.result can't come back on the next socket, so nothing waits for one
  connectionLost(): void {
    for (const [callId, pending] of this.#pendingCalls) {
      clearTimeout(pending.timer)
      this.#pendingCalls.delete(callId)
      pending.resolve({ ok: false, error: UNREACHABLE })
    }
  }

  // D20: a build task's developer and reviewer get the pinned design version
  // as read-only files in the scratch folder, outside the worktree, before
  // the agent starts. Returns the note naming them, or why they're missing.
  async savePinnedDesign(run: Run): Promise<string> {
    const fetched = await this.#forward(run, 'get_design', { taskRef: run.job.taskRef })
    const saved = fetched.ok ? await saveDesign(run.scratchDir, fetched.result as DesignForAgent) : fetched
    if (!saved.ok) {
      run.outbox.note(`Could not save the pinned design: ${saved.error}`)
      return pinnedDesignNote(run.job, saved)
    }
    const design = saved.result
    run.outbox.note(`Saved design v${design.version} of ${design.taskRef} in ${design.dir}`)
    return pinnedDesignNote(run.job, { ok: true, design })
  }

  async #call(run: Run, tool: AgentTool, input: Record<string, unknown>): Promise<ToolOutcome> {
    if (run.ended || run.tools.outcomeAccepted) return { ok: false, error: RUN_OVER }
    switch (tool) {
      case 'attach_evidence': {
        // No path: a note on its own, which the server checks (D21)
        if (input.path === undefined) return this.#forward(run, tool, input)
        const file = await readEvidence(run.scratchDir, String(input.path ?? ''), text => run.outbox.note(text))
        if (!file.ok) return file
        return this.#forward(run, tool, { ...input, ...(file.result as object) })
      }
      case 'get_design':
        return run.timer.during('design_save', async () => {
          const design = await this.#forward(run, tool, input)
          if (!design.ok) return design
          return saveDesign(run.scratchDir, design.result as DesignForAgent)
        })
      // D20: pack the bundle, push the design branch, then the server records
      // a new version at the pushed commit
      case 'submit_design': {
        const packed = await run.timer.during('design_pack', () => packDesign(run.worktree!, input))
        if (!packed.ok) return packed
        const pushed = await this.#push(run)
        if (!pushed.ok) return pushed
        return this.#forward(run, tool, { ...packed.result, headSha: pushed.result })
      }
      // An agent that gave up waiting calls again while the first call runs:
      // a second push and report would race it
      case 'report_outcome':
        run.tools.outcomeCall ??= this.#reportOutcome(run, input).finally(() => {
          run.tools.outcomeCall = null
        })
        return run.tools.outcomeCall
      default:
        return this.#forward(run, tool, input)
    }
  }

  async #reportOutcome(run: Run, input: Record<string, unknown>): Promise<ToolOutcome> {
    const { job } = run
    const outcome = outcomesFor(job.role).find(name => name === input.outcome)
    if (!outcome) {
      return { ok: false, error: `A ${job.role} reports one of: ${outcomesFor(job.role).join(', ')}` }
    }
    let payload: Record<string, unknown> = input
    if (isAuthoringRole(job.role) && isCommitOutcome(outcome)) {
      // A spike has no branch to push (D19)
      if (!job.branch) return { ok: false, error: SPIKE_OPENS_NO_PR }
      // The runner pushes, not the agent (D8); the commit goes with the report
      const pushed = await this.#push(run)
      if (!pushed.ok) return pushed
      payload = { ...input, headSha: pushed.result }
      if (outcome === 'commit_submitted') {
        const baseSha = await mergeBase(run.worktree!, `origin/${job.baseBranch ?? job.defaultBranch}`)
        if (!baseSha) return { ok: false, error: `Corral could not find where your branch forked from ${job.baseBranch ?? job.defaultBranch}. Rebase onto it and try again.` }
        payload = { ...payload, baseSha }
      }
    } else if (outcome === 'failed' && run.worktree) {
      payload = { ...input, headSha: await headSha(run.worktree) ?? undefined }
    } else if (job.role === 'reviewer' && job.headSha) {
      // What the verdict actually judged, so the server can refuse a moved head
      payload = { ...input, headSha: await headSha(run.worktree!) ?? 'unknown' }
    }
    const reporting = this.#forward(run, 'report_outcome', payload).then((result) => {
      if (result.ok) run.tools.outcomeAccepted = true
      return result
    })
    run.tools.reporting = reporting
    try {
      return await reporting
    } finally {
      if (run.tools.reporting === reporting) run.tools.reporting = null
    }
  }

  // Kept apart from `reporting`: a human's stop waits for the server's
  // answer, but not for a push that can take minutes
  async #push(run: Run): Promise<Pushed> {
    if (!run.job.branch) return { ok: false, error: 'This run has no branch to push' }
    const branch = run.job.branch
    run.tools.pushes += 1
    const pushed = await run.timer.during('push', () => pushBranch(run.worktree!, branch)).finally(() => {
      run.tools.pushes -= 1
    })
    if (pushed.sha === null) return { ok: false, error: `Corral could not push your branch: ${pushed.error}. Commit your work and try again.` }
    // The run can end during a push; what follows would reach the server after run.ended
    if (run.ended) return { ok: false, error: RUN_OVER }
    run.outbox.note(`Pushed ${shortSha(pushed.sha)} to ${branch}`)
    return { ok: true, result: pushed.sha }
  }

  #forward(run: Run, tool: AgentTool, input: unknown): Promise<ToolOutcome> {
    const callId = randomUUID()
    const message: RunnerMessage = { type: 'tool.call', callId, runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, tool, input }
    if (!this.#connection.send(message)) return Promise.resolve({ ok: false, error: UNREACHABLE })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingCalls.delete(callId)
        resolve({ ok: false, error: 'Corral did not answer in time. Try again.' })
      }, TOOL_CALL_TIMEOUT_MS)
      this.#pendingCalls.set(callId, { resolve, timer })
    })
  }
}
