import { isGlobalPmJob, type RunExit, type RunJob, type ServerMessage } from '@corral/contracts'
import { errorText, isAuthoringRole, roleTakesMessages, shortSha } from '@corral/core'
import { mkdir } from 'node:fs/promises'
import { constants } from 'node:os'
import type { AgentExit, AgentProcess, McpServer, ParsedLineHandler, RuntimeOptions, RuntimeRegistry } from './agent-runtime.ts'
import type { ParsedLine } from './parsed-line.ts'
import { terminate } from './agent-process.ts'
import { SAVE_WORK_TIMEOUT_MS } from './budgets.ts'
import type { RunnerConfig } from './config.ts'
import { removeScratch } from './designs.ts'
import { scratchPath, spoolDir, spoolPath, turboCachePath, workspaceKey } from './layout.ts'
import type { ToolServer } from './mcp.ts'
import { newAgentState, runUsage, type Run, type StopReason } from './run.ts'
import { RunOutbox, type RunConnection } from './run-outbox.ts'
import { readProjectText, RESUME_TO_REPORT_PROMPT, systemPrompt, wipMessage } from './run-prompt.ts'
import { RunSpool } from './run-spool.ts'
import { RunTimer } from './run-timings.ts'
import { RunTools } from './run-tools.ts'
import { WarmSessions, type WarmSession } from './warm-sessions.ts'
import { headSha, prepareWorkspace, saveStoppedWork } from './workspace.ts'

// Runs on this runner (flows.md §2 steps 3–5, PRD §8.6): assign, start,
// spawn, stop and end. Each run gets a worktree, a secret MCP path, and an
// agent process in its own process group, started by the adapter for the
// job's runtime (D15). A PM turn is still one run, but its process can outlive
// the run: it stays warm for the session's next message (D9). A runtime with a
// streaming session takes a developer's or reviewer's input mid-run too
// (run.message); the run still ends when the agent has reported and finished
// its turn. A developer run stopped before it reported saves its uncommitted
// work as a WIP commit on the task branch, after the agent is gone and before
// the server hears the run ended, so the retry continues from it.

const OUTCOME_EXIT_GRACE_MS = 20_000

interface SpawnOptions {
  prompt: string
  systemPrompt: string
  // The run's tools; a warm process serves its own
  mcpServers: Record<string, McpServer>
  resume: string | null
}

export class RunManager {
  #config: RunnerConfig
  #runtimes: RuntimeRegistry
  #connection: RunConnection
  #tools: RunTools
  #warm: WarmSessions
  #runs = new Map<string, Run>()

  constructor(config: RunnerConfig, connection: RunConnection, tools: ToolServer, runtimes: RuntimeRegistry) {
    this.#config = config
    this.#runtimes = runtimes
    this.#connection = connection
    this.#tools = new RunTools(connection, tools)
    this.#warm = new WarmSessions(config.pmWarmSeconds)
  }

  // Sent with hello and every heartbeat, so the server can renew leases and
  // tell this runner about runs it no longer recognises. A run that ended but
  // hasn't said so is still listed: without it, a reconnect would call the run
  // lost and replace its real exit.
  activeRuns(): { runId: string, leaseEpoch: number }[] {
    return [...this.#runs.values()].map(r => ({ runId: r.job.runId, leaseEpoch: r.job.leaseEpoch }))
  }

  activeRunCount(): number {
    return this.#runs.size
  }

  hasRun(runId: string): boolean {
    return this.#runs.has(runId)
  }

  // Any run of the project, from assign until it's forgotten
  projectRunning(projectId: string): boolean {
    return [...this.#runs.values()].some(r => r.job.projectId === projectId)
  }

  // Set from assign on, so a turn still preparing its checkout counts
  pmTurnRunning(planSessionId: string): boolean {
    return [...this.#runs.values()].some(r => !r.ended && r.job.role === 'pm' && r.job.planSessionId === planSessionId)
  }

  handle(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        for (const run of [...this.#runs.values()]) run.outbox.drain()
        return
      case 'run.assign':
        this.assign(message.job)
        return
      case 'run.lease': {
        const run = this.#runs.get(message.runId)
        if (run && !run.lease.revoked && run.job.leaseEpoch === message.leaseEpoch) run.lease.confirmedUntil = Date.parse(message.validUntil)
        return
      }
      case 'run.stop':
        this.stop(message.runId, 'stopped', message.reason, message.keepWork === true)
        return
      case 'run.message':
        this.message(message.runId, message.leaseEpoch, message.text)
        return
      case 'tool.result':
        this.#tools.answered(message)
        return
      default:
        return
    }
  }

  assign(job: RunJob): void {
    if (this.#runs.has(job.runId)) return
    const runtime = this.#runtimes.get(job.runtime) ?? null
    const warm = this.#warm.keeps(job, runtime)
    const run: Run = {
      job,
      runtime,
      warm,
      scratchDir: scratchPath(this.#config.dataDir, job, warm),
      worktree: null,
      initialHeadSha: null,
      outbox: new RunOutbox(this.#connection, job, () => this.#finished(run)),
      spool: null,
      timer: new RunTimer(),
      tools: { outcomeAccepted: false, reporting: null, outcomeCall: null, pushes: 0 },
      stop: null,
      lease: { confirmedUntil: 0, revoked: false },
      process: null,
      session: null,
      queuedMessages: [],
      agent: newAgentState(job.agentSessionId),
      ended: false,
      closing: Promise.resolve(),
      closed: Promise.withResolvers<void>(),
      timeoutTimer: null,
      unregisterTools: null
    }
    this.#runs.set(job.runId, run)
    this.#start(run).catch((error: unknown) => {
      this.#end(run, { kind: 'error', message: errorText(error) })
    })
  }

  stop(runId: string, reason: StopReason, detail: string, keepWork = true): void {
    const run = this.#runs.get(runId)
    if (!run) return
    if (!keepWork) run.lease = { confirmedUntil: 0, revoked: true }
    if (run.ended) return
    run.outbox.note(`${reason === 'timed_out' ? 'Time limit reached' : 'Stopping'}: ${detail}`)
    run.stop ??= { reason, detail, keepWork }
    // Still setting up: the start path checks `stop` before spawning
    if (!run.process) return
    // The server stops the run as it accepts report_outcome, so the stop can
    // arrive before the tool result: wait for the answer before signalling
    const process = run.process
    const reporting = run.tools.reporting
    if (reporting && reason === 'stopped') void reporting.then(() => this.#signal(run, process, reason))
    else this.#signal(run, process, reason)
  }

  #signal(run: Run, process: AgentProcess, reason: StopReason): void {
    // After an accepted outcome the agent is just finishing its last reply;
    // let it see the tool result and exit on its own before signalling. The
    // time limit and a runner shutdown don't wait (runner rule 2).
    terminate(process, { delayMs: run.tools.outcomeAccepted && reason === 'stopped' ? OUTCOME_EXIT_GRACE_MS : 0 })
  }

  #stopExit(run: Run): RunExit {
    switch (run.stop?.reason) {
      case 'timed_out': return { kind: 'timed_out', limitSeconds: run.job.timeoutSeconds }
      case 'runner_shutdown': return { kind: 'runner_shutdown' }
      default: return { kind: 'stopped', reason: run.stop?.detail ?? '' }
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
      this.#reject(run ?? null, { runId, leaseEpoch }, text, refusal)
      return
    }
    if (run!.session) this.#deliver(run!, text)
    else run!.queuedMessages.push(text)
  }

  #messageRefusal(run: Run): string | null {
    const { job } = run
    if (run.ended || run.stop) return 'The run has ended'
    if (run.tools.outcomeAccepted) return 'The agent has already reported its outcome'
    if (!roleTakesMessages(job.role)) return `A ${job.role} run doesn't take messages`
    if (this.#runtimes.get(job.runtime)?.spawnSession === undefined) return `A ${job.runtime} run can't take input while it runs`
    return null
  }

  #takesMessages(job: RunJob): boolean {
    return roleTakesMessages(job.role) && this.#runtimes.get(job.runtime)?.spawnSession !== undefined
  }

  #reject(run: Run | null, { runId, leaseEpoch }: { runId: string, leaseEpoch: number }, text: string, error: string): void {
    run?.outbox.note(`A message was not delivered: ${error}`)
    this.#connection.send({ type: 'run.message.rejected', runId, leaseEpoch, text, error })
  }

  #deliver(run: Run, text: string): void {
    if (!run.session?.message(text)) {
      run.queuedMessages.push(text)
      return
    }
    // Shown at once, so whoever sent it sees it arrive
    run.outbox.events([{ type: 'message', text }])
    run.outbox.flush()
  }

  // Runner shutdown (PRD §9.3): stop every agent, wait for the grace period,
  // and tell the server the runs were interrupted
  async shutdown(): Promise<void> {
    const live = [...this.#runs.values()].filter(r => !r.ended)
    for (const run of live) this.stop(run.job.runId, 'runner_shutdown', 'The runner is shutting down')
    await Promise.all([
      ...live.map(run => run.process?.exited ?? Promise.resolve()),
      this.#warm.killAll()
    ])
    for (const run of live) {
      if (!run.ended) this.#end(run, this.#stopExit(run))
    }
    // The caller closes the connection next, and run.ended has to go out
    // first, including for a run that was already saving its work
    await Promise.all([...this.#runs.values()].map(run => run.closing))
  }

  connectionLost(): void {
    this.#tools.connectionLost()
  }

  async #start(run: Run): Promise<void> {
    const { job } = run
    const dataDir = this.#config.dataDir
    if (!run.runtime) {
      this.#end(run, { kind: 'error', message: `This runner has no agent runtime "${job.runtime}". It knows: ${[...this.#runtimes.keys()].join(', ')}` })
      return
    }
    // The worktree is shared: a stopped run on this task saves its work first
    await Promise.all([...this.#runs.values()].filter(other => other !== run && other.stop?.keepWork && isAuthoringRole(other.job.role) && workspaceKey(other.job) === workspaceKey(job)).map(other => other.closed.promise))
    await mkdir(spoolDir(dataDir), { recursive: true })
    await mkdir(run.scratchDir, { recursive: true })
    run.spool = new RunSpool(spoolPath(dataDir, job.runId), (error) => {
      run.outbox.note(`The runner stopped keeping a local copy of this transcript: ${error}`)
    })

    // A PM follow-up turn reuses its session's checkout; the note is noise there
    if (!(job.role === 'pm' && job.agentSessionId)) run.outbox.note(isGlobalPmJob(job) ? 'Preparing a global session without a repository checkout' : `Preparing a worktree for ${job.repository}${job.branch ? ` on ${job.branch}` : ''}`)
    const prepared = await run.timer.during('worktree_prepare', () => prepareWorkspace(dataDir, job))
    if (prepared.workspace === null) {
      this.#end(run, { kind: 'error', message: prepared.error })
      return
    }
    run.worktree = prepared.workspace.path
    if (job.role !== 'pm') run.initialHeadSha = await headSha(run.worktree)
    if (run.stop) {
      this.#end(run, this.#stopExit(run))
      return
    }

    // The session's warm process takes the message, in the checkout just reset to fresh code
    const warm = run.warm ? await this.#warm.take(job) : null
    if (warm) {
      this.#startTimeout(run)
      run.agent.sessionId = warm.sessionId
      run.agent.sawInit = true
      this.#started(run)
      this.#noteExit(run, await run.timer.during('agent_warm_turn', () => this.#warm.turn(run, warm, job.prompt)))
      run.outbox.flush()
    } else {
      await this.#coldStart(run, run.worktree)
    }

    if (run.ended) return
    const { agent } = run
    if (run.stop) this.#end(run, this.#stopExit(run))
    else if (agent.rateLimit) this.#end(run, { kind: 'rate_limited', resetsAt: agent.rateLimit.resetsAt })
    else if (agent.killedBy) this.#end(run, { kind: 'signalled', signal: agent.killedBy })
    else if (agent.runtimeError) this.#end(run, { kind: 'error', message: agent.runtimeError })
    else this.#end(run, { kind: 'exited', code: agent.exitCode })
  }

  #startTimeout(run: Run): void {
    run.timeoutTimer = setTimeout(() => this.stop(run.job.runId, 'timed_out', `${run.job.timeoutSeconds} s`), run.job.timeoutSeconds * 1000)
  }

  async #coldStart(run: Run, worktree: string): Promise<void> {
    const { job, agent } = run
    const { text, mcpServers } = await run.timer.during('session_setup', async () => ({
      // A warm process serves its own tools, since it outlives this run
      mcpServers: run.warm ? {} : this.#serveTools(run),
      text: await readProjectText(job, worktree)
    }))
    const design = job.designPinned ? await run.timer.during('design_save', () => this.#tools.savePinnedDesign(run)) : null
    const prompt = systemPrompt(text, job, run.scratchDir, design)

    this.#startTimeout(run)

    await this.#spawn(run, { prompt: job.prompt, systemPrompt: prompt, mcpServers, resume: job.agentSessionId })

    // D9: a lost agent session isn't fatal; the server's prompt carries the record
    if (job.agentSessionId && job.fallbackPrompt && !agent.sawInit && !run.stop && !run.ended) {
      run.outbox.note('The previous agent session could not be resumed; starting a fresh one from the saved conversation')
      agent.sessionId = null
      agent.rateLimit = null
      agent.resumeFailed = true
      await this.#spawn(run, { prompt: job.fallbackPrompt, systemPrompt: prompt, mcpServers, resume: null })
    }
    if (!agent.started) this.#started(run)

    // PRD §8.6: an agent that exits without an outcome gets one chance to report
    if (this.#needsAnotherTurn(run)) {
      agent.resumed = true
      run.outbox.note(`The agent exited (code ${agent.exitCode}) without reporting an outcome; resuming it once to report`)
      await this.#spawn(run, { prompt: RESUME_TO_REPORT_PROMPT, systemPrompt: prompt, mcpServers, resume: agent.sessionId })
      // A stop, a usage limit or an outside signal has its own note
      if (run.tools.outcomeAccepted) run.outbox.note('The resumed agent reported its outcome')
      else if (!run.stop && !agent.rateLimit && !agent.killedBy) run.outbox.note(`The resumed agent exited (code ${agent.exitCode}) without reporting an outcome`)
    }
  }

  #needsAnotherTurn(run: Run): boolean {
    return !run.tools.outcomeAccepted && !run.stop && !run.agent.rateLimit && !run.ended && !run.agent.resumed && run.agent.sessionId !== null && run.job.role !== 'pm'
  }

  #serveTools(run: Run): Record<string, McpServer> {
    const served = this.#tools.serve(run.job, () => run)
    run.unregisterTools = served.unregister
    return served.mcpServers
  }

  // What every agent start of a job gets, one-shot, session or warm
  async #options(run: Run, spawn: SpawnOptions, onLine: ParsedLineHandler): Promise<RuntimeOptions> {
    const { job } = run
    const { dataDir, gitAuthor } = this.#config
    const options: RuntimeOptions = {
      cwd: run.worktree!,
      scratchDir: run.scratchDir,
      noRepository: isGlobalPmJob(job),
      systemPrompt: spawn.systemPrompt,
      mcpServers: spawn.mcpServers,
      model: job.model,
      resumeSessionId: spawn.resume,
      quietResume: job.role === 'pm',
      gitAuthor,
      checkScope: job.role === 'developer' ? job.checkScope ?? null : null,
      turboCacheDir: job.projectId ? turboCachePath(dataDir, job.projectId) : null,
      onLine,
      prompt: spawn.prompt
    }
    return await run.runtime!.prepare?.(options) ?? options
  }

  async #spawn(run: Run, spawn: SpawnOptions): Promise<void> {
    if (run.stop || run.ended) return
    const { agent } = run
    agent.signalledByCorral = false
    agent.usageBase = agent.usage
    const exit = await run.timer.during(spawn.resume ? 'agent_resume' : 'agent_cold_start', async () => run.warm
      ? await this.#warm.turn(run, await this.#spawnWarm(run, spawn), spawn.prompt)
      : this.#takesMessages(run.job)
        ? await this.#spawnSession(run, spawn)
        : await this.#spawnOnce(run, spawn))
    run.outbox.flush()
    // A failed --resume waits: the fresh session that replaces it is the one
    // the server must record, or the next turn tries the dead one again
    if (!agent.started && !(spawn.resume && !agent.sawInit)) this.#started(run)
    this.#noteExit(run, exit)
  }

  #noteExit(run: Run, exit: AgentExit | null): void {
    const signal = exit && !run.stop && !run.tools.outcomeAccepted && !run.agent.signalledByCorral ? exitSignal(exit) : null
    if (signal) {
      run.agent.killedBy = signal
      run.outbox.note(`The agent was killed by ${signal}, which Corral did not send`)
    }
  }

  async #spawnOnce(run: Run, spawn: SpawnOptions): Promise<AgentExit> {
    const options = await this.#options(run, spawn, (raw, parsed) => this.#onLine(run, raw, parsed))
    // A stop that came during that wait found no process to signal
    if (run.stop || run.ended) return { code: null, signal: null }
    const process = run.runtime!.spawn(options)
    run.process = process
    const exit = await process.exited
    run.agent.exitCode = exit.code
    return exit
  }

  // A developer or reviewer agent that reads its input from stdin, so
  // messages reach it mid-run. Once it has answered everything it was sent,
  // stdin closes and the CLI exits as a one-shot run would. The run then ends
  // if it has reported its outcome, or resumes once to report as before.
  async #spawnSession(run: Run, spawn: SpawnOptions): Promise<AgentExit> {
    const options = await this.#options(run, spawn, (raw, parsed) => this.#onLine(run, raw, parsed))
    if (run.stop || run.ended) return { code: null, signal: null }
    const session = run.runtime!.spawnSession!(options)
    run.process = session
    session.send(spawn.prompt)
    run.session = session
    for (const text of run.queuedMessages.splice(0)) this.#deliver(run, text)

    const result = await session.nextIdle()
    run.session = null
    session.close()
    // A CLI that doesn't exit once stdin closes is stopped as usual
    terminate(session, {
      delayMs: OUTCOME_EXIT_GRACE_MS,
      onTerm: () => {
        run.agent.signalledByCorral = true
        if (!run.tools.outcomeAccepted && !run.stop) run.outbox.note(`The agent ended its turn but was still running ${OUTCOME_EXIT_GRACE_MS / 1000} s later, usually because of a background command, so Corral stopped it`)
      }
    })
    const exit = await session.exited
    run.agent.exitCode = exit.code === 0 && result?.isError ? 1 : exit.code
    return exit
  }

  // A PM session's process, kept warm for its next turns (D9). Tool calls and
  // output go to whichever turn it is answering.
  async #spawnWarm(run: Run, spawn: SpawnOptions): Promise<WarmSession> {
    let warm: WarmSession | null = null
    const tools = this.#tools.serve(run.job, () => warm?.run ?? null)
    try {
      const options = await this.#options(run, { ...spawn, mcpServers: tools.mcpServers }, (raw, parsed) => {
        if (warm?.run) this.#onLine(warm.run, raw, parsed)
      })
      warm = this.#warm.add(run.job, run.runtime!.spawnSession!(options), tools.unregister)
      return warm
    } catch (error) {
      // The route belongs to a process that never started
      tools.unregister()
      throw error
    }
  }

  #onLine(run: Run, raw: string, parsed: ParsedLine): void {
    const { agent } = run
    if (raw) run.spool?.write(raw)
    if (parsed.sessionId) {
      agent.sawInit = true
      agent.sessionId = parsed.sessionId
    }
    if (parsed.sessionId && !agent.started) this.#started(run)
    if (parsed.rateLimit) agent.rateLimit = parsed.rateLimit
    if (parsed.result) agent.runtimeError = parsed.result.isError ? parsed.result.text || 'The agent runtime ended with an error' : null
    if (raw || parsed.events.length > 0) agent.lastActivityAt = new Date().toISOString()
    run.timer.observe(parsed.events)
    if (!run.ended) run.outbox.events(parsed.events.map(event => event.type === 'usage' ? runUsage(agent, event) : event))
  }

  #started(run: Run): void {
    run.agent.started = true
    run.outbox.post({ type: 'run.started', initialHeadSha: run.initialHeadSha, sentAt: Date.now(), runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, agentSessionId: run.agent.sessionId, ...(run.agent.resumeFailed ? { resumeFailed: true } : {}) })
  }

  // The server has been told, or as told as it can be without an ack
  #finished(run: Run): void {
    this.#runs.delete(run.job.runId)
    void this.#connection.refreshUpdateStatus()
    void this.#removeRunFiles(run)
  }

  // Evidence and designs are on the server by now, and the transcript is the
  // server's own, built from run.events; the sweep retries what fails here. A
  // warm session's scratch folder is the session's, and its process still uses it.
  async #removeRunFiles(run: Run): Promise<void> {
    await Promise.all([
      run.spool?.remove(),
      run.warm ? null : removeScratch(run.scratchDir)
    ]).catch((error: unknown) => {
      console.warn(`Run ${run.job.runId}: could not remove its files: ${errorText(error)}`)
    })
  }

  #end(run: Run, exit: RunExit): void {
    if (run.ended) return
    for (const text of run.queuedMessages.splice(0)) this.#reject(run, run.job, text, 'The run has ended')
    run.ended = true
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
    run.outbox.close()
    run.unregisterTools?.()
    run.spool?.close()
    const finish = (sha: string | null, wipSha: string | null = null) => {
      run.outbox.post({ type: 'run.ended', runId: run.job.runId, leaseEpoch: run.job.leaseEpoch, exit, headSha: sha, lastActivityAt: run.agent.lastActivityAt, wipSha, timings: run.timer.finish() })
      // A retry waits for the saved work, not for the server to hear about it
      run.closed.resolve()
    }
    const worktree = run.worktree
    if (worktree && isAuthoringRole(run.job.role)) {
      run.closing = run.timer.during('finish', () => this.#saveWork(run, worktree, exit).then(wipSha => headSha(worktree, SAVE_WORK_TIMEOUT_MS).then(sha => ({ sha, wipSha })))).then(({ sha, wipSha }) => finish(sha, wipSha), () => finish(null))
    } else {
      finish(null)
    }
  }

  // Returns the WIP commit once it's on the remote. An outcome in flight has
  // already pushed what it reports, and a new commit would move the branch
  // from under it.
  async #saveWork(run: Run, worktree: string, exit: RunExit): Promise<string | null> {
    const { job } = run
    const stopped = run.stop?.keepWork === true || exit.kind === 'signalled'
    if (!stopped || !job.branch || run.tools.outcomeAccepted || run.tools.reporting || run.tools.pushes > 0) return null
    const saved = await saveStoppedWork(worktree, job.branch, wipMessage(job, exit, run.stop?.detail ?? ''), this.#config.gitAuthor, SAVE_WORK_TIMEOUT_MS, () => this.#connection.connected && run.lease.confirmedUntil > Date.now() + SAVE_WORK_TIMEOUT_MS)
    const short = shortSha(saved.sha)
    const note = saved.pushed
      ? `Saved the uncommitted work as WIP commit ${short} and pushed it to ${job.branch}`
      : saved.sha
        ? `Saved the uncommitted work as WIP commit ${short} in the worktree, but could not push it: ${saved.error}`
        : saved.error ? `Could not save the uncommitted work: ${saved.error}` : null
    // The run has ended, so this goes straight out, ahead of run.ended
    if (note) run.outbox.post({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'system', text: note }] })
    return saved.pushed ? saved.sha : null
  }
}

// The signal that killed the agent. A CLI that handles the signal, or a shell
// in front of it, exits with 128 + the signal number instead of dying by it.
export function exitSignal(exit: AgentExit): string | null {
  if (exit.signal) return exit.signal
  if (exit.code === null || exit.code <= 128) return null
  return Object.entries(constants.signals).find(([, number]) => number === exit.code! - 128)?.[0] ?? null
}
