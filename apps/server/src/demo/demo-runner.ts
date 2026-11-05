import { RUNNER_HEARTBEAT_MS } from '@corral/contracts'
import { FakeRunner } from '../test-runner.ts'
import { demoGuideAnswer } from './demo-guide.ts'

const PM_REPLY = 'This is a demo instance (`pnpm dev:demo`), so I don\'t run here and nothing you send reaches an agent. Run `pnpm dev` with a runner to plan for real.'

// The runner a demo instance connects to itself, so pages don't show the
// runner as offline. It only takes PM turns, answering each with a note that
// this is a demo, and answers setup jobs from canned data. Developers,
// designers and reviewers are never offered to it, so no agent ever starts.
export async function startDemoRunner(serverUrl: string, repositories: () => Promise<string[]>): Promise<() => void> {
  const runner = await FakeRunner.connect(serverUrl, [], 'demo-runner', { slots: 4, roles: ['pm'], runtimes: ['claude-code', 'codex'] })
  const active = new Map<string, number>()
  runner.onJob = async (job) => {
    switch (job.kind) {
      case 'detect_clis': return { kind: 'detect_clis', clis: [{ id: 'claude', version: '2.1.0', signedIn: true }, { id: 'codex', version: '0.52.0', signedIn: true }] }
      case 'list_repos': return { kind: 'list_repos', signedIn: true, repos: (await repositories()).map(nameWithOwner => ({ nameWithOwner, description: null, isPrivate: true, defaultBranch: 'main', canPush: true, updatedAt: new Date().toISOString() })) }
      case 'cleanup_worktrees': return { kind: 'cleanup_worktrees', removed: [], kept: [] }
      case 'sweep_worktrees': return { kind: 'sweep_worktrees', removed: [], kept: [] }
      // The server keeps its fallback for these
      case 'session_title': throw new Error('No titles in the demo')
      case 'inbox_message': throw new Error('No Inbox messages in the demo')
      case 'release_notes': throw new Error('No release notes in the demo')
      // A guide takes a few seconds for real, so the generating state shows
      case 'pr_guide':
        await new Promise(resolve => setTimeout(resolve, 3000))
        return { kind: 'pr_guide', text: demoGuideAnswer(job.prompt) }
      default: throw new Error(`The demo runner can't do ${job.kind}`)
    }
  }
  runner.socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as { type: string, job?: { runId: string, leaseEpoch: number, role: string }, runId?: string }
    if (message.type === 'run.assign' && message.job) {
      const { runId, leaseEpoch } = message.job
      active.set(runId, leaseEpoch)
      runner.send({ type: 'run.started', runId, leaseEpoch, agentSessionId: null })
      runner.send({ type: 'run.events', runId, leaseEpoch, events: [{ type: 'message', text: PM_REPLY }] })
      setTimeout(() => {
        active.delete(runId)
        runner.send({ type: 'run.ended', runId, leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
      }, 300)
    }
    if (message.type === 'run.stop' && message.runId && active.has(message.runId)) {
      const leaseEpoch = active.get(message.runId)!
      active.delete(message.runId)
      runner.send({ type: 'run.ended', runId: message.runId, leaseEpoch, exit: { kind: 'stopped' }, headSha: null })
    }
    // Nothing else is kept, so a long-running server doesn't collect messages
    runner.received.length = 0
  })
  const heartbeat = setInterval(() => {
    runner.send({ type: 'heartbeat', sentAt: Date.now(), activeRuns: [...active].map(([runId, leaseEpoch]) => ({ runId, leaseEpoch })) })
  }, RUNNER_HEARTBEAT_MS)
  return () => {
    clearInterval(heartbeat)
    runner.close()
  }
}
