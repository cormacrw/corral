import type { AgentTool, RunEvent, RunExit, RunJob, RunnerMessage, ServerMessage } from '@corral/contracts'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { createRuntimeRegistry, STOP_GRACE_MS, type AgentExit, type AgentProcess, type AgentRuntime, type AgentSession, type ParsedLine, type RuntimeRegistry } from './agent-runtime.ts'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import { packDesign, saveDesign } from './designs.ts'
import { outcomesFor, toolsFor, type ToolOutcome, type ToolServer } from './mcp.ts'
import { headSha, prepareWorkspace, pushBranch, readProjectBrief, readRoleInstructions, saveStoppedWork } from './workspace.ts'

// Runs on this runner (flows.md §2 steps 3–5, PRD §8.6). Each run gets a
// worktree, a secret MCP path, and an agent process in its own process
// group, started by the adapter for the job's runtime (D15). Events stream
// to the server in batches; raw lines go to the spool.
// A PM turn is still one run, but its process can outlive the run: it stays
// warm for the session's next message until the idle timeout (D9).
// A Claude Code developer or reviewer run streams its input too, so a human
// can message it mid-run (run.message); it still ends when the agent has
// reported and finished its turn.
// A developer run stopped before it reported saves its uncommitted work as a
// WIP commit on the task branch, after the agent is gone and before the server
// hears the run ended, so the retry continues from it.

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

type StopReason = Extract<RunExit, { kind: 'stopped' | 'timed_out' | 'runner_shutdown' }>['kind']

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
  // Settles when the server answers a report_outcome call that is still open
  reportingOutcome: Promise<unknown> | null
  // Set when the server, the timeout or a runner shutdown asked for the process
  // to die. The first one wins: it's what cut the run off.
  stopping: StopReason | null
  stopDetail: string
  // The stop asked for uncommitted work to be saved
  keepWork: boolean
  leaseConfirmedUntil: number
  leaseRevoked: boolean
  // Corral signalled the process outside a stop, so its signal isn't a stranger's
  signalledByCorral: boolean
  // A signal Corral didn't send killed the agent, even if a resume came after
  killedBy: string | null
  lastActivityAt: string | null
  rateLimit: { resetsAt: string | null } | null
  resumed: boolean
  // The init line arrived, so the CLI really started (a failed --resume never gets there)
  sawInit: boolean
  resumeFailed: boolean
  ended: boolean
  // Settles once the server has been told the run ended
  closing: Promise<void>
  // Resolves with the same moment, but exists from the start of the run
  closed: PromiseWithResolvers<void>
  // The last agent exit code, or the turn's when a warm PM process answered it
  exitCode: number | null
  events: RunEvent[]
  flushTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
  spool: WriteStream | null
  unregisterTools: (() => void) | null
  // The live session taking messages; null between processes and once it closes
  session: AgentSession | null
  // Messages that arrived while there was no live session to take them
  queuedMessages: string[]
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

  activeRunCount(): number {
    return this.#runs.size
  }

  handle(message: ServerMessage): void {
    switch (message.type) {
      case 'run.assign':
        this.assign(message.job)
        return
      case 'run.lease': {
        const run = this.#runs.get(message.runId)
        if (run && !run.leaseRevoked && run.job.leaseEpoch === message.leaseEpoch) run.leaseConfirmedUntil = Date.parse(message.validUntil)
        return
      }
      case 'run.stop':
        this.stop(message.runId, 'stopped', message.reason, message.keepWork === true)
        return
      case 'run.message':
        this.message(message.runId, message.leaseEpoch, message.text)
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
      reportingOutcome: null,
      stopping: null,
      stopDetail: '',
      keepWork: false,
      leaseConfirmedUntil: 0,
      leaseRevoked: false,
      signalledByCorral: false,
      killedBy: null,
      lastActivityAt: null,
      rateLimit: null,
      resumed: false,
      sawInit: false,
      resumeFailed: false,
      ended: false,
      closing: Promise.resolve(),
      closed: Promise.withResolvers<void>(),
      exitCode: null,
      events: [],
      flushTimer: null,
      timeoutTimer: null,
      spool: null,
      unregisterTools: null,
      session: null,
      queuedMessages: []
    }
    this.#runs.set(job.runId, run)
    this.#start(run).catch((error: unknown) => {
      this.#end(run, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  stop(runId: string, reason: StopReason, detail: string, keepWork = true): void {
    const run = this.#runs.get(runId)
    if (!run) return
    if (!keepWork) {
      run.leaseRevoked = true
      run.leaseConfirmedUntil = 0
    }
    if (run.ended) return
    this.#note(run, `${reason === 'timed_out' ? 'Time limit reached' : 'Stopping'}: ${detail}`)
    if (!run.stopping) {
      run.stopping = reason
      run.stopDetail = detail
      run.keepWork = keepWork
    }
    // Still setting up: the start path checks `stopping` before spawning
    if (!run.process) return
    // The server stops the run as it accepts report_outcome, so the stop can
    // arrive before the tool result: wait for the answer before signalling
    const process = run.process
    const reporting = run.reportingOutcome
    if (reporting && reason !== 'timed_out') void reporting.then(() => this.#signal(run, process, reason))
    else this.#signal(run, process, reason)
  }

  #signal(run: ActiveRun, process: AgentProcess, reason: StopReason): void {
    // After an accepted outcome the agent is just finishing its last reply;
    // let it see the tool result and exit on its own before signalling
    const delay = run.outcomeAccepted && reason !== 'timed_out' ? OUTCOME_EXIT_GRACE_MS : 0
    const soft = setTimeout(() => process.kill('SIGTERM'), delay)
    const hard = setTimeout(() => process.kill('SIGKILL'), delay + STOP_GRACE_MS)
    void process.exited.then(() => {
      clearTimeout(soft)
      clearTimeout(hard)
    })
  }

  #stopExit(run: ActiveRun): RunExit {
    switch (run.stopping) {
      case 'timed_out': return { kind: 'timed_out', limitSeconds: run.job.timeoutSeconds }
      case 'runner_shutdown': return { kind: 'runner_shutdown' }
      default: return { kind: 'stopped', reason: run.stopDetail }
    }
  }

  // A human's message for a live developer or reviewer run. A stale lease
  // epoch is ignored (stale-runners-and-fencing.md); anything else that can't
  // be delivered is rejected out loud, never dropped.
  message(runId: string, leaseEpoch: number, text: string): void {
    const run = this.#runs.get(runId)
    if (run && run.job.leaseEpoch !== leaseEpoch) return
    const refusal = run ? this.#messageRefusal(run) : 'The run has ended'
    if (refusal) {
      if (run) this.#note(run, `A message was not delivered: ${refusal}`)
      this.#connection.send({ type: 'run.message.rejected', runId, leaseEpoch, text, error: refusal })
      return
    }
    if (run!.session) this.#deliver(run!, text)
    else run!.queuedMessages.push(text)
  }

  #messageRefusal(run: ActiveRun): string | null {
    const { job } = run
    if (run.ended || run.stopping) return 'The run has ended'
    if (run.outcomeAccepted) return 'The agent has already reported its outcome'
    if (job.role !== 'developer' && job.role !== 'designer' && job.role !== 'reviewer') return `A ${job.role} run doesn't take messages`
    if (!this.#takesMessages(job)) return `A ${job.runtime} run can't take input while it runs`
    return null
  }

  #takesMessages(job: RunJob): boolean {
    return (job.role === 'developer' || job.role === 'designer' || job.role === 'reviewer') && this.#runtimes.get(job.runtime)?.spawnSession !== undefined
  }

  #deliver(run: ActiveRun, text: string): void {
    if (!run.session?.message(text)) {
      run.queuedMessages.push(text)
      return
    }
    // Shown at once, so whoever sent it sees it arrive
    this.#queue(run, [{ type: 'message', text }])
    this.#flush(run)
  }

  // Runner shutdown (PRD §9.3): stop every agent, wait for the grace period,
  // and tell the server the runs were interrupted
  async shutdown(): Promise<void> {
    const live = [...this.#runs.values()].filter(r => !r.ended)
    for (const run of live) this.stop(run.job.runId, 'runner_shutdown', 'The runner is shutting down')
    await Promise.all([
      ...live.map(run => run.process?.exited ?? Promise.resolve()),
      ...[...this.#warm.values()].map(warm => this.#killWarm(warm))
    ])
    for (const run of live) {
      if (!run.ended) this.#end(run, this.#stopExit(run))
    }
    // The caller closes the connection next, and run.ended has to go out first
    await Promise.all(live.map(run => run.closing))
  }

  async #start(run: ActiveRun): Promise<void> {
    const { job } = run
    if (!run.runtime) {
      this.#end(run, { kind: 'error', message: `This runner has no agent runtime "${job.runtime}". It knows: ${[...this.#runtimes.keys()].join(', ')}` })
      return
    }
    // The worktree is shared: a stopped run on this task saves its work first
    await Promise.all([...this.#runs.values()].filter(other => other !== run && other.keepWork && (other.job.role === 'developer' || other.job.role === 'designer') && other.job.taskId === job.taskId).map(other => other.closed.promise))
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
      this.#end(run, this.#stopExit(run))
      return
    }

    // The session's warm process takes the message, in the checkout just reset to fresh code
    const warm = this.#keepsWarm(job) ? await this.#takeWarm(job) : null
    if (warm) {
      run.timeoutTimer = setTimeout(() => this.stop(job.runId, 'timed_out', `${job.timeoutSeconds} s`), job.timeoutSeconds * 1000)
      run.sessionId = warm.sessionId
      run.sawInit = true
      this.#started(run)
      this.#noteExit(run, await this.#warmTurn(run, warm, job.prompt))
      this.#flush(run)
    } else {
      await this.#coldStart(run, prepared.workspace.path)
    }

    if (run.ended) return
    if (run.stopping) this.#end(run, this.#stopExit(run))
    else if (run.rateLimit) this.#end(run, { kind: 'rate_limited', resetsAt: run.rateLimit.resetsAt })
    else if (run.killedBy) this.#end(run, { kind: 'signalled', signal: run.killedBy })
    else this.#end(run, { kind: 'exited', code: run.exitCode })
  }

  async #coldStart(run: ActiveRun, worktree: string): Promise<void> {
    const { job } = run
    const mcpConfigPath = join(run.scratchDir, 'mcp.json')
    // A warm process registers its own tools, since it outlives this run
    if (!this.#keepsWarm(job)) run.unregisterTools = await this.#registerTools(mcpConfigPath, job, (tool, input) => this.#toolCall(run, tool, input))

    const instructions = await readRoleInstructions(worktree, job.role)
    const brief = await readProjectBrief(worktree)
    const design = job.designPinned ? await this.#savePinnedDesign(run) : null
    const systemPrompt = `${instructions}\n\n${brief ? `${brief}\n\n` : ''}${runnerNotes(run, job, design)}`

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
    const unregister = this.#tools.register(secret, job.role, handler, toolsFor(job))
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { corral: { type: 'http', url: this.#tools.url(secret) } } }))
    return unregister
  }

  #needsAnotherTurn(run: ActiveRun): boolean {
    return !run.outcomeAccepted && !run.stopping && !run.rateLimit && !run.ended && !run.resumed && run.sessionId !== null && run.job.role !== 'pm'
  }

  async #spawn(run: ActiveRun, options: SpawnOptions): Promise<void> {
    if (run.stopping || run.ended) return
    run.signalledByCorral = false
    const exit = this.#keepsWarm(run.job)
      ? await this.#warmTurn(run, await this.#spawnWarm(run, options), options.prompt)
      : this.#takesMessages(run.job)
        ? await this.#spawnSession(run, options)
        : await this.#spawnOnce(run, options)
    this.#flush(run)
    // A failed --resume waits: the fresh session that replaces it is the one
    // the server must record, or the next turn tries the dead one again
    if (!run.started && !(options.resume && !run.sawInit)) this.#started(run)
    this.#noteExit(run, exit)
  }

  #noteExit(run: ActiveRun, exit: AgentExit | null): void {
    const signal = exit && !run.stopping && !run.outcomeAccepted && !run.signalledByCorral ? exitSignal(exit) : null
    if (signal) {
      run.killedBy = signal
      this.#note(run, `The agent was killed by ${signal}, which Corral did not send`)
    }
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

  // A developer or reviewer agent that reads its input from stdin, so
  // messages reach it mid-run. Once it has answered everything it was sent,
  // stdin closes and the CLI exits as -p would. The run then ends if it has
  // reported its outcome, or resumes once to report as before.
  async #spawnSession(run: ActiveRun, options: SpawnOptions): Promise<AgentExit> {
    const session = run.runtime!.spawnSession!({
      cwd: run.worktree!,
      systemPrompt: options.systemPrompt,
      mcpConfigPath: options.mcpConfigPath,
      model: run.job.model,
      resumeSessionId: options.resume,
      gitAuthor: this.#config.gitAuthor,
      onLine: (raw, parsed) => this.#onLine(run, raw, parsed)
    })
    run.process = session
    session.send(options.prompt)
    run.session = session
    for (const text of run.queuedMessages.splice(0)) this.#deliver(run, text)

    const result = await session.nextIdle()
    run.session = null
    session.close()
    // A CLI that doesn't exit once stdin closes is stopped as usual
    const soft = setTimeout(() => {
      run.signalledByCorral = true
      session.kill('SIGTERM')
    }, OUTCOME_EXIT_GRACE_MS)
    const hard = setTimeout(() => session.kill('SIGKILL'), OUTCOME_EXIT_GRACE_MS + STOP_GRACE_MS)
    const exit = await session.exited
    clearTimeout(soft)
    clearTimeout(hard)
    run.exitCode = exit.code === 0 && result?.isError ? 1 : exit.code
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
    if (warm.run) warm.run.signalledByCorral = true
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
    if (raw || parsed.events.length > 0) run.lastActivityAt = new Date().toISOString()
    this.#queue(run, parsed.events)
  }

  #started(run: ActiveRun): void {
    run.started = true
    this.#connection.send({ type: 'run.started', sentAt: Date.now(), runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, agentSessionId: run.sessionId })
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
    for (const text of run.queuedMessages.splice(0)) {
      this.#note(run, 'A message was not delivered: The run has ended')
      this.#connection.send({ type: 'run.message.rejected', runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, text, error: 'The run has ended' })
    }
    run.ended = true
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
    this.#flush(run)
    run.unregisterTools?.()
    run.spool?.end()
    const finish = (sha: string | null, wipSha: string | null = null) => {
      this.#connection.send({ type: 'run.ended', runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, exit, headSha: sha, lastActivityAt: run.lastActivityAt, wipSha })
      this.#runs.delete(run.job.runId)
      this.#connection.refreshUpdateStatus?.()
      run.closed.resolve()
    }
    const worktree = run.worktree
    if (worktree && (run.job.role === 'developer' || run.job.role === 'designer')) {
      run.closing = this.#saveWork(run, worktree, exit).then(wipSha => headSha(worktree).then(sha => finish(sha, wipSha)), () => finish(null))
    } else {
      finish(null)
    }
  }

  // Returns the WIP commit once it's on the remote. An outcome in flight has
  // already pushed what it reports, and a new commit would move the branch
  // from under it.
  async #saveWork(run: ActiveRun, worktree: string, exit: RunExit): Promise<string | null> {
    const { job } = run
    const stopped = run.keepWork || exit.kind === 'signalled'
    if (!stopped || !job.branch || run.outcomeAccepted || run.reportingOutcome) return null
    const saved = await saveStoppedWork(worktree, job.branch, wipMessage(job, exit, run.stopDetail), this.#config.gitAuthor, STOP_GRACE_MS, () => this.#connection.connected && run.leaseConfirmedUntil > Date.now() + STOP_GRACE_MS)
    const short = saved.sha?.slice(0, 10)
    const note = saved.pushed
      ? `Saved the uncommitted work as WIP commit ${short} and pushed it to ${job.branch}`
      : saved.sha
        ? `Saved the uncommitted work as WIP commit ${short} in the worktree, but could not push it: ${saved.error}`
        : saved.error ? `Could not save the uncommitted work: ${saved.error}` : null
    // The run has ended, so this goes straight out, ahead of run.ended
    if (note) this.#connection.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'system', text: note }] })
    return saved.pushed ? saved.sha : null
  }

  // ── Agent tools ────────────────────────────────────────────────────────────

  async #toolCall(run: ActiveRun, tool: AgentTool, input: Record<string, unknown>): Promise<ToolOutcome> {
    if (run.ended || run.outcomeAccepted) return { ok: false, error: 'This run is over. Stop working.' }
    if (!toolsFor(run.job).includes(tool)) return { ok: false, error: `The ${run.job.role} can't use ${tool}${tool === 'submit_design' ? ' on a task that isn\'t a design' : ''}` }

    if (tool === 'attach_evidence') {
      // No path: a note on its own, which the server checks (D21)
      if (input.path === undefined) return this.#forward(run, tool, input)
      const file = await this.#readEvidence(run, input)
      if (!file.ok) return file
      return this.#forward(run, tool, { ...input, ...(file.result as object) })
    }

    if (tool === 'get_design') {
      const design = await this.#forward(run, tool, input)
      if (!design.ok) return design
      return saveDesign(run.scratchDir, design.result as Parameters<typeof saveDesign>[1])
    }

    // D20: pack the bundle, push the design branch, then the server records
    // a new version at the pushed commit
    if (tool === 'submit_design') {
      const packed = await packDesign(run.worktree!, input)
      if (!packed.ok) return packed
      const pushed = await this.#push(run)
      if (!pushed.ok) return pushed
      return this.#forward(run, tool, { ...packed.result, headSha: pushed.result })
    }

    if (tool === 'report_outcome') {
      const outcome = String(input.outcome ?? '')
      if (!outcomesFor(run.job.role).includes(outcome)) {
        return { ok: false, error: `A ${run.job.role} reports one of: ${outcomesFor(run.job.role).join(', ')}` }
      }
      let payload: Record<string, unknown> = input
      if ((run.job.role === 'developer' || run.job.role === 'designer') && (outcome === 'pr_opened' || outcome === 'pr_updated' || outcome === 'pr_rebased' || outcome === 'design_submitted')) {
        // A spike has no branch to push (D19)
        if (!run.job.branch) return { ok: false, error: 'A spike opens no PR: report your findings with outcome findings_reported.' }
        // The runner pushes, not the agent (D8); the commit goes with the report
        const pushed = await this.#push(run)
        if (!pushed.ok) return pushed
        payload = { ...input, headSha: pushed.result }
      }
      const reporting = this.#forward(run, tool, payload).then((result) => {
        if (result.ok) run.outcomeAccepted = true
        return result
      })
      run.reportingOutcome = reporting
      try {
        return await reporting
      } finally {
        if (run.reportingOutcome === reporting) run.reportingOutcome = null
      }
    }

    return this.#forward(run, tool, input)
  }

  async #push(run: ActiveRun): Promise<{ ok: true, result: string } | { ok: false, error: string }> {
    if (!run.job.branch) return { ok: false, error: 'This run has no branch to push' }
    const pushed = await pushBranch(run.worktree!, run.job.branch)
    if (pushed.sha === null) return { ok: false, error: `Corral could not push your branch: ${pushed.error}. Commit your work and try again.` }
    this.#note(run, `Pushed ${pushed.sha.slice(0, 10)} to ${run.job.branch}`)
    return { ok: true, result: pushed.sha }
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

  // D20: a build task's developer and reviewer get the pinned design version
  // as read-only files in the scratch folder, outside the worktree, before
  // the agent starts. Returns the note naming them, or why they're missing.
  async #savePinnedDesign(run: ActiveRun): Promise<string> {
    const fetched = await this.#forward(run, 'get_design', { taskRef: run.job.taskRef })
    const saved = fetched.ok ? await saveDesign(run.scratchDir, fetched.result as Parameters<typeof saveDesign>[1]) : fetched
    if (!saved.ok) {
      this.#note(run, `Could not save the pinned design: ${saved.error}`)
      return `- The pinned design could not be saved (${saved.error}). Fetch it with get_design and taskRef "${run.job.taskRef}".`
    }
    const design = saved.result as { taskRef: string, version: number, branch: string, dir: string, specPath: string, bundle: { index: string } }
    this.#note(run, `Saved design v${design.version} of ${design.taskRef} in ${design.dir}`)
    return `- The pinned design, v${design.version} of ${design.taskRef}, is saved read-only in ${design.dir}, outside the repository: the spec at ${design.specPath}, the screenshots in ${join(design.dir, 'screenshots')} and the prototype's bundle at ${design.bundle.index}. It was built on branch ${design.branch}, for reference only.`
  }

  // Reads the file the agent attached and sends it as base64. Files must
  // live outside the repository: the scratch folder is the usual place.
  async #readEvidence(run: ActiveRun, input: Record<string, unknown>): Promise<ToolOutcome> {
    const given = String(input.path ?? '')
    if (!given) return { ok: false, error: 'Pass the path of the file to attach, or leave out path and use kind "note" for a written explanation' }
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

// The signal that killed the agent. A CLI that handles the signal, or a shell
// in front of it, exits with 128 + the signal number instead of dying by it.
export function exitSignal(exit: AgentExit): string | null {
  if (exit.signal) return exit.signal
  if (exit.code === null || exit.code <= 128) return null
  return Object.entries(constants.signals).find(([, number]) => number === exit.code! - 128)?.[0] ?? null
}

function wipMessage(job: RunJob, exit: RunExit, stopDetail: string): string {
  const reason = exit.kind === 'timed_out'
    ? 'Time limit reached'
    : exit.kind === 'runner_shutdown'
      ? 'The runner shut down'
      : exit.kind === 'signalled' ? exit.signal : stopDetail
  return `WIP: ${job.taskRef} run #${job.runNumber} stopped: ${reason}\n\nCorral saved this unfinished work when the run stopped. It may not build.`
}

// Machine-specific details the agent needs, kept out of RunJob (PRD §8.5)
function runnerNotes(run: ActiveRun, job: RunJob, design: string | null = null): string {
  return [
    '## Corral runner notes',
    '',
    `- Your Corral tools are on the MCP server "corral": ${toolsFor(job).join(', ')}.`,
    `- Save evidence files and other scratch output under ${run.scratchDir} (outside the repository), then attach them with attach_evidence using the absolute path.`,
    (job.role === 'developer' || job.role === 'designer') && job.branch ? `- You are in a git worktree on branch ${job.branch}. Pushing is disabled; Corral pushes when you ${job.taskType === 'design' ? 'call submit_design' : 'report'}.` : '',
    // A spike (D19): findings, not commits
    job.role === 'developer' && !job.branch ? '- You are in a detached checkout of the default branch for a spike. Don\'t commit or push; report your findings.' : '',
    design ?? '',
    `- This run has a time limit of ${Math.round(job.timeoutSeconds / 60)} minutes.`
  ].filter(Boolean).join('\n')
}
