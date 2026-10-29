import type { AgentTool, RunEvent, RunExit, RunJob, RunnerMessage, ServerMessage } from '@corral/contracts'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { createRuntimeRegistry, STOP_GRACE_MS, type AgentExit, type AgentProcess, type AgentRuntime, type AgentSession, type ParsedLine, type RuntimeRegistry } from './agent-runtime.ts'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import { outcomesFor, ROLE_TOOLS, type ToolOutcome, type ToolServer } from './mcp.ts'
import { headSha, prepareWorkspace, pushBranch, readProjectBrief, readRoleInstructions } from './workspace.ts'

// Runs on this runner (flows.md §2 steps 3–5, PRD §8.6). Each run gets a
// worktree, a secret MCP path, and an agent process in its own process
// group, started by the adapter for the job's runtime (D15). Events stream
// to the server in batches; raw lines go to the spool.
// A PM turn is still one run, but its process can outlive the run: it stays
// warm for the session's next message until the idle timeout (D9).

const EVENT_BATCH_MS = 500
const TOOL_CALL_TIMEOUT_MS = 120_000
const OUTCOME_EXIT_GRACE_MS = 20_000
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.har': 'application/json'
}

interface SpawnOptions {
  prompt: string
  systemPrompt: string
  mcpConfigPath: string
  resume: string | null
}

type StopReason = Extract<RunExit, { kind: 'stopped' | 'timed_out' }>['kind']

interface ActiveRun {
  job: RunJob
  // Null when the runner has no adapter for job.runtime; the run ends at once
  runtime: AgentRuntime | null
  worktree: string | null
  scratchDir: string
  process: AgentProcess | null
  sessionId: string | null
  started: boolean
  // Set once the server accepted report_outcome; the run is over
  outcomeAccepted: boolean
  // Set when the server or the timeout asked for the process to die
  stopping: StopReason | null
  rateLimit: { resetsAt: string | null } | null
  resumed: boolean
  // The init line arrived, so the CLI really started (a failed --resume never gets there)
  sawInit: boolean
  resumeFailed: boolean
  ended: boolean
  // The last agent exit code, or the turn's when a warm PM process answered it
  exitCode: number | null
  events: RunEvent[]
  flushTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
  spool: WriteStream | null
  unregisterTools: (() => void) | null
}

// A PM session's agent process kept alive between turns (D9). It holds no
// concurrency slot while idle (D13): the slot belongs to the run, which ended.
interface WarmSession {
  planSessionId: string
  session: AgentSession
  runtime: string
  model: string | null
  // The agent session it holds, known once the init line arrives
  sessionId: string | null
  // The turn it is answering; null while idle
  run: ActiveRun | null
  alive: boolean
  idleTimer: NodeJS.Timeout | null
  unregisterTools: () => void
}

export class RunManager {
  #config: RunnerConfig
  #runtimes: RuntimeRegistry
  #connection: ServerConnection
  #tools: ToolServer
  #runs = new Map<string, ActiveRun>()
  // Keyed by planSessionId
  #warm = new Map<string, WarmSession>()
  #pendingCalls = new Map<string, { resolve: (o: ToolOutcome) => void, timer: NodeJS.Timeout }>()

  constructor(config: RunnerConfig, connection: ServerConnection, tools: ToolServer, runtimes: RuntimeRegistry = createRuntimeRegistry(config)) {
    this.#config = config
    this.#runtimes = runtimes
    this.#connection = connection
    this.#tools = tools
  }

  // Sent with hello and every heartbeat, so the server can renew leases and
  // tell this runner about runs it no longer recognises
  activeRuns(): { runId: string, leaseEpoch: number }[] {
    return [...this.#runs.values()].filter(r => !r.ended).map(r => ({ runId: r.job.runId, leaseEpoch: r.job.leaseEpoch }))
  }

  handle(message: ServerMessage): void {
    switch (message.type) {
      case 'run.assign':
        this.assign(message.job)
        return
      case 'run.stop':
        this.stop(message.runId, 'stopped', message.reason)
        return
      case 'tool.result': {
        const pending = this.#pendingCalls.get(message.callId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#pendingCalls.delete(message.callId)
        pending.resolve(message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error })
        return
      }
      default:
        return
    }
  }

  assign(job: RunJob): void {
    if (this.#runs.has(job.runId)) return
    const run: ActiveRun = {
      job,
      runtime: this.#runtimes.get(job.runtime) ?? null,
      worktree: null,
      // A warm process's system prompt names its scratch dir, so it can't be per run
      scratchDir: join(this.#config.dataDir, 'scratch', this.#keepsWarm(job) ? `pm-${job.projectId}-${job.planSessionId}` : job.runId),
      process: null,
      sessionId: job.agentSessionId,
      started: false,
      outcomeAccepted: false,
      stopping: null,
      rateLimit: null,
      resumed: false,
      sawInit: false,
      resumeFailed: false,
      ended: false,
      exitCode: null,
      events: [],
      flushTimer: null,
      timeoutTimer: null,
      spool: null,
      unregisterTools: null
    }
    this.#runs.set(job.runId, run)
    this.#start(run).catch((error: unknown) => {
      this.#end(run, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  stop(runId: string, reason: StopReason, detail: string): void {
    const run = this.#runs.get(runId)
    if (!run || run.ended) return
    this.#note(run, `${reason === 'timed_out' ? 'Time limit reached' : 'Stopping'}: ${detail}`)
    if (!run.process) {
      // Still setting up: the start path checks `stopping` before spawning
      run.stopping = reason
      return
    }
    run.stopping ??= reason
    const process = run.process
    // After an accepted outcome the agent is just finishing its last reply;
    // let it see the tool result and exit on its own before signalling
    const delay = run.outcomeAccepted && reason === 'stopped' ? OUTCOME_EXIT_GRACE_MS : 0
    const soft = setTimeout(() => process.kill('SIGTERM'), delay)
    const hard = setTimeout(() => process.kill('SIGKILL'), delay + STOP_GRACE_MS)
    void process.exited.then(() => {
      clearTimeout(soft)
      clearTimeout(hard)
    })
  }

  // Runner shutdown (PRD §9.3): stop every agent, wait for the grace period,
  // and tell the server the runs were interrupted
  async shutdown(): Promise<void> {
    const live = [...this.#runs.values()].filter(r => !r.ended)
    for (const run of live) this.stop(run.job.runId, 'stopped', 'The runner is shutting down')
    await Promise.all([
      ...live.map(run => run.process?.exited ?? Promise.resolve()),
      ...[...this.#warm.values()].map(warm => this.#killWarm(warm))
    ])
    for (const run of live) {
      if (!run.ended) this.#end(run, { kind: 'stopped' })
    }
  }

  async #start(run: ActiveRun): Promise<void> {
    const { job } = run
    if (!run.runtime) {
      this.#end(run, { kind: 'error', message: `This runner has no agent runtime "${job.runtime}". It knows: ${[...this.#runtimes.keys()].join(', ')}` })
      return
    }
    await mkdir(join(this.#config.dataDir, 'spool'), { recursive: true })
    await mkdir(run.scratchDir, { recursive: true })
    run.spool = createWriteStream(join(this.#config.dataDir, 'spool', `${job.runId}.jsonl`), { flags: 'a' })

    // A PM follow-up turn reuses its session's checkout; the note is noise there
    if (!(job.role === 'pm' && job.agentSessionId)) this.#note(run, `Preparing a worktree for ${job.repository}${job.branch ? ` on ${job.branch}` : ''}`)
    const prepared = await prepareWorkspace(this.#config.dataDir, job)
    if (prepared.workspace === null) {
      this.#end(run, { kind: 'error', message: prepared.error })
      return
    }
    run.worktree = prepared.workspace.path
    if (run.stopping) {
      this.#end(run, { kind: run.stopping })
      return
    }

    // The session's warm process takes the message, in the checkout just reset to fresh code
    const warm = this.#keepsWarm(job) ? await this.#takeWarm(job) : null
    if (warm) {
      run.timeoutTimer = setTimeout(() => this.stop(job.runId, 'timed_out', `${job.timeoutSeconds} s`), job.timeoutSeconds * 1000)
      run.sessionId = warm.sessionId
      run.sawInit = true
      this.#started(run)
      await this.#warmTurn(run, warm, job.prompt)
      this.#flush(run)
    } else {
      await this.#coldStart(run, prepared.workspace.path)
    }

    if (run.ended) return
    if (run.stopping) this.#end(run, { kind: run.stopping })
    else if (run.rateLimit) this.#end(run, { kind: 'rate_limited', resetsAt: run.rateLimit.resetsAt })
    else this.#end(run, { kind: 'exited', code: run.exitCode })
  }

  async #coldStart(run: ActiveRun, worktree: string): Promise<void> {
    const { job } = run
    const mcpConfigPath = join(run.scratchDir, 'mcp.json')
    // A warm process registers its own tools, since it outlives this run
    if (!this.#keepsWarm(job)) run.unregisterTools = await this.#registerTools(mcpConfigPath, job, (tool, input) => this.#toolCall(run, tool, input))

    const instructions = await readRoleInstructions(worktree, job.role)
    // Only the PM gets the brief; other roles' prompts are unchanged
    const brief = job.role === 'pm' ? await readProjectBrief(worktree) : ''
    const systemPrompt = `${instructions}\n\n${brief ? `${brief}\n\n` : ''}${runnerNotes(run, job)}`

    run.timeoutTimer = setTimeout(() => this.stop(job.runId, 'timed_out', `${job.timeoutSeconds} s`), job.timeoutSeconds * 1000)

    await this.#spawn(run, { prompt: job.prompt, systemPrompt, mcpConfigPath, resume: job.agentSessionId })

    // D9: a lost agent session isn't fatal; the server's prompt carries the record
    if (job.agentSessionId && job.fallbackPrompt && !run.sawInit && !run.stopping && !run.ended) {
      this.#note(run, 'The previous agent session could not be resumed; starting a fresh one from the saved conversation')
      run.sessionId = null
      run.rateLimit = null
      await this.#spawn(run, { prompt: job.fallbackPrompt, systemPrompt, mcpConfigPath, resume: null })
    }
    if (!run.started) this.#started(run)

    // PRD §8.6: an agent that exits without an outcome gets one chance to report
    if (this.#needsAnotherTurn(run)) {
      run.resumed = true
      this.#note(run, 'The agent exited without reporting an outcome; resuming it once to report')
      await this.#spawn(run, {
        prompt: 'Your session ended without calling report_outcome. Check the state of your work and call report_outcome now with the right outcome. Do not start new work.',
        systemPrompt,
        mcpConfigPath,
        resume: run.sessionId
      })
    }
  }

  async #registerTools(mcpConfigPath: string, job: RunJob, handler: (tool: AgentTool, input: Record<string, unknown>) => Promise<ToolOutcome>): Promise<() => void> {
    const secret = randomBytes(24).toString('base64url')
    const unregister = this.#tools.register(secret, job.role, handler)
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { corral: { type: 'http', url: this.#tools.url(secret) } } }))
    return unregister
  }

  #needsAnotherTurn(run: ActiveRun): boolean {
    return !run.outcomeAccepted && !run.stopping && !run.rateLimit && !run.ended && !run.resumed && run.sessionId !== null && run.job.role !== 'pm'
  }

  async #spawn(run: ActiveRun, options: SpawnOptions): Promise<void> {
    if (run.stopping || run.ended) return
    const exit = this.#keepsWarm(run.job)
      ? await this.#warmTurn(run, await this.#spawnWarm(run, options), options.prompt)
      : await this.#spawnOnce(run, options)
    this.#flush(run)
    // A failed --resume waits: the fresh session that replaces it is the one
    // the server must record, or the next turn tries the dead one again
    if (!run.started && !(options.resume && !run.sawInit)) this.#started(run)
    if (exit?.signal && !run.stopping && !run.outcomeAccepted) this.#note(run, `The agent was killed by ${exit.signal}`)
  }

  async #spawnOnce(run: ActiveRun, options: SpawnOptions): Promise<AgentExit> {
    const process = run.runtime!.spawn({
      cwd: run.worktree!,
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      mcpConfigPath: options.mcpConfigPath,
      model: run.job.model,
      resumeSessionId: options.resume,
      quietResume: run.job.role === 'pm',
      gitAuthor: this.#config.gitAuthor,
      onLine: (raw, parsed) => this.#onLine(run, raw, parsed)
    })
    run.process = process
    const exit = await process.exited
    run.exitCode = exit.code
    return exit
  }

  // ── Warm PM sessions (D9) ──────────────────────────────────────────────────

  // Only runtimes with a streaming session can keep one warm
  #keepsWarm(job: RunJob): boolean {
    return job.role === 'pm' && job.planSessionId !== null && this.#config.pmWarmSeconds > 0 && this.#runtimes.get(job.runtime)?.spawnSession !== undefined
  }

  // The session's warm process, if it can take this turn. One that can't
  // (dead, busy, another agent session, runtime or model) is killed, and the
  // turn cold-starts with --resume as usual.
  async #takeWarm(job: RunJob): Promise<WarmSession | null> {
    const warm = this.#warm.get(job.planSessionId!)
    if (!warm) return null
    if (warm.alive && warm.run === null && warm.sessionId !== null && warm.sessionId === job.agentSessionId && warm.runtime === job.runtime && warm.model === job.model) return warm
    await this.#killWarm(warm)
    return null
  }

  async #spawnWarm(run: ActiveRun, options: SpawnOptions): Promise<WarmSession> {
    const { job } = run
    // Tool calls go to whichever turn the process is answering
    const unregisterTools = await this.#registerTools(options.mcpConfigPath, job, (tool, input) =>
      warm.run ? this.#toolCall(warm.run, tool, input) : Promise.resolve({ ok: false, error: 'This run is over. Stop working.' }))
    const warm: WarmSession = {
      planSessionId: job.planSessionId!,
      session: run.runtime!.spawnSession!({
        cwd: run.worktree!,
        systemPrompt: options.systemPrompt,
        mcpConfigPath: options.mcpConfigPath,
        model: job.model,
        resumeSessionId: options.resume,
        quietResume: true,
        gitAuthor: this.#config.gitAuthor,
        onLine: (raw, parsed) => {
          if (warm.run) this.#onLine(warm.run, raw, parsed)
        }
      }),
      runtime: job.runtime,
      model: job.model,
      sessionId: null,
      run: null,
      alive: true,
      idleTimer: null,
      unregisterTools
    }
    this.#warm.set(warm.planSessionId, warm)
    void warm.session.exited.then(() => {
      warm.alive = false
      this.#dropWarm(warm)
    })
    return warm
  }

  // Sends one turn and waits for its result line. Returns null when the
  // process answered and stays warm, or its exit when it ended instead.
  async #warmTurn(run: ActiveRun, warm: WarmSession, prompt: string): Promise<AgentExit | null> {
    if (warm.idleTimer) clearTimeout(warm.idleTimer)
    warm.idleTimer = null
    warm.run = run
    run.process = warm.session
    // A stop that arrived while the turn was setting up
    if (run.stopping) warm.session.kill('SIGTERM')
    else warm.session.send(prompt)
    const result = await warm.session.nextResult()
    warm.run = null
    if (result === null) {
      const exit = await warm.session.exited
      run.exitCode = exit.code
      return exit
    }
    run.exitCode = result.isError ? 1 : 0
    warm.sessionId = run.sessionId
    // A stopped turn already took its process down
    if (!run.stopping) warm.idleTimer = setTimeout(() => void this.#killWarm(warm), this.#config.pmWarmSeconds * 1000)
    return null
  }

  // Kills the process group, gracefully first (architecture.md, runner rule 2)
  async #killWarm(warm: WarmSession): Promise<void> {
    this.#dropWarm(warm)
    warm.session.kill('SIGTERM')
    const hard = setTimeout(() => warm.session.kill('SIGKILL'), STOP_GRACE_MS)
    await warm.session.exited
    clearTimeout(hard)
    // Anything the agent started that outlived it goes too
    warm.session.kill('SIGKILL')
  }

  #dropWarm(warm: WarmSession): void {
    if (warm.idleTimer) clearTimeout(warm.idleTimer)
    warm.idleTimer = null
    warm.unregisterTools()
    if (this.#warm.get(warm.planSessionId) === warm) this.#warm.delete(warm.planSessionId)
  }

  #onLine(run: ActiveRun, raw: string, parsed: ParsedLine): void {
    if (raw) run.spool?.write(raw + '\n')
    if (parsed.sessionId) {
      run.sawInit = true
      run.sessionId = parsed.sessionId
    }
    if (parsed.sessionId && !run.started) this.#started(run)
    if (parsed.rateLimit) run.rateLimit = parsed.rateLimit
    this.#queue(run, parsed.events)
  }

  #started(run: ActiveRun): void {
    run.started = true
    this.#connection.send({ type: 'run.started', runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, agentSessionId: run.sessionId })
  }

  #note(run: ActiveRun, text: string): void {
    this.#queue(run, [{ type: 'system', text }])
  }

  #queue(run: ActiveRun, events: RunEvent[]): void {
    if (events.length === 0 || run.ended) return
    run.events.push(...events)
    run.flushTimer ??= setTimeout(() => this.#flush(run), EVENT_BATCH_MS)
  }

  #flush(run: ActiveRun): void {
    if (run.flushTimer) clearTimeout(run.flushTimer)
    run.flushTimer = null
    if (run.events.length === 0) return
    const events = run.events
    run.events = []
    this.#connection.send({ type: 'run.events', runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, events })
  }

  #end(run: ActiveRun, exit: RunExit): void {
    if (run.ended) return
    run.ended = true
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
    this.#flush(run)
    run.unregisterTools?.()
    run.spool?.end()
    const finish = (sha: string | null) => {
      this.#connection.send({ type: 'run.ended', runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, exit, headSha: sha })
      this.#runs.delete(run.job.runId)
    }
    if (run.worktree && run.job.role === 'developer') void headSha(run.worktree).then(finish, () => finish(null))
    else finish(null)
  }

  // ── Agent tools ────────────────────────────────────────────────────────────

  async #toolCall(run: ActiveRun, tool: AgentTool, input: Record<string, unknown>): Promise<ToolOutcome> {
    if (run.ended || run.outcomeAccepted) return { ok: false, error: 'This run is over. Stop working.' }
    if (!ROLE_TOOLS[run.job.role]?.includes(tool)) return { ok: false, error: `The ${run.job.role} can't use ${tool}` }

    if (tool === 'attach_evidence') {
      const file = await this.#readEvidence(run, input)
      if (!file.ok) return file
      return this.#forward(run, tool, { ...input, ...(file.result as object) })
    }

    if (tool === 'report_outcome') {
      const outcome = String(input.outcome ?? '')
      if (!outcomesFor(run.job.role).includes(outcome)) {
        return { ok: false, error: `A ${run.job.role} reports one of: ${outcomesFor(run.job.role).join(', ')}` }
      }
      let payload: Record<string, unknown> = input
      if (run.job.role === 'developer' && (outcome === 'pr_opened' || outcome === 'pr_updated')) {
        // The runner pushes, not the agent (D8); the commit goes with the report
        const pushed = await pushBranch(run.worktree!, run.job.branch!)
        if (pushed.sha === null) return { ok: false, error: `Corral could not push your branch: ${pushed.error}. Commit your work and report again.` }
        this.#note(run, `Pushed ${pushed.sha.slice(0, 10)} to ${run.job.branch}`)
        payload = { ...input, headSha: pushed.sha }
      }
      const result = await this.#forward(run, tool, payload)
      if (result.ok) run.outcomeAccepted = true
      return result
    }

    return this.#forward(run, tool, input)
  }

  #forward(run: ActiveRun, tool: AgentTool, input: unknown): Promise<ToolOutcome> {
    const callId = randomUUID()
    const message: RunnerMessage = { type: 'tool.call', callId, runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, tool, input }
    if (!this.#connection.send(message)) {
      return Promise.resolve({ ok: false, error: 'Corral is unreachable right now. Wait a moment and try again.' })
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingCalls.delete(callId)
        resolve({ ok: false, error: 'Corral did not answer in time. Try again.' })
      }, TOOL_CALL_TIMEOUT_MS)
      this.#pendingCalls.set(callId, { resolve, timer })
    })
  }

  // Reads the file the agent attached and sends it as base64. Files must
  // live outside the repository: the scratch folder is the usual place.
  async #readEvidence(run: ActiveRun, input: Record<string, unknown>): Promise<ToolOutcome> {
    const given = String(input.path ?? '')
    if (!given) return { ok: false, error: 'Pass the path of the file to attach' }
    const path = isAbsolute(given) ? given : resolve(run.scratchDir, given)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return { ok: false, error: `No file at ${path}` }
    if (info.size > MAX_EVIDENCE_BYTES) return { ok: false, error: 'Evidence files are limited to 25 MB' }
    const data = await readFile(path)
    const extension = extname(path).toLowerCase()
    return {
      ok: true,
      result: {
        fileName: basename(path),
        contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
        dataBase64: data.toString('base64'),
        path: undefined
      }
    }
  }
}

// Machine-specific details the agent needs, kept out of RunJob (PRD §8.5)
function runnerNotes(run: ActiveRun, job: RunJob): string {
  return [
    '## Corral runner notes',
    '',
    `- Your Corral tools are on the MCP server "corral": ${(ROLE_TOOLS[job.role] ?? []).join(', ')}.`,
    `- Save evidence files and other scratch output under ${run.scratchDir} (outside the repository), then attach them with attach_evidence using the absolute path.`,
    job.role === 'developer' ? `- You are in a git worktree on branch ${job.branch}. Pushing is disabled; Corral pushes when you report.` : '',
    `- This run has a time limit of ${Math.round(job.timeoutSeconds / 60)} minutes.`
  ].filter(Boolean).join('\n')
}
