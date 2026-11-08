// A no-progress stop on a task: the run it ended, the inputs it was judged
// against, its one PM triage session and the retry choices that question offered
export interface RetryStop {
  runId: string | null
  target: string | null
  human: string
  status: 'in_progress' | 'agent_review'
  capped: boolean
  sessionId: string | null
  retryQuestion?: { id: string, options: string[] }
}
