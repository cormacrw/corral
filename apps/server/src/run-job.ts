import type { PmRunJob } from '@corral/contracts'

const RUN_TIMEOUT_SECONDS = 60 * 60
const PM_TURN_TIMEOUT_SECONDS = 20 * 60

// A PM turn's job before it has a run to go out on
export type PendingPmJob = Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch'>

interface JobProject { id: string, repository: string, defaultBranch: string }

// What every developer, designer and reviewer job carries: the run it is
// fenced by, where it works, and a fresh session with the run time limit
export function workerJob(run: { id: string, number: number, leaseEpoch: number | null }, runtime: string, project: JobProject) {
  return {
    runId: run.id, runNumber: run.number, leaseEpoch: run.leaseEpoch!, runtime,
    projectId: project.id, repository: project.repository, defaultBranch: project.defaultBranch,
    planSessionId: null, agentSessionId: null, fallbackPrompt: null, model: null, timeoutSeconds: RUN_TIMEOUT_SECONDS
  }
}

// A turn in a Plan session, on the session's runtime (D18). A global session
// has no project and so no checkout.
export function pmJob(session: { id: string, agentSessionId: string | null, runtime: string }, project: JobProject | null, prompts: { prompt: string, fallbackPrompt: string | null }): PendingPmJob {
  return {
    role: 'pm', runtime: session.runtime, projectId: project?.id ?? null, repository: project?.repository ?? '', defaultBranch: project?.defaultBranch ?? '',
    taskId: null, taskRef: null, branch: null, headSha: null, planSessionId: session.id, agentSessionId: session.agentSessionId,
    model: null, timeoutSeconds: PM_TURN_TIMEOUT_SECONDS, ...prompts
  }
}
