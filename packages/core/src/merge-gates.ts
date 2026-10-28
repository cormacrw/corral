// The final gate check before a task can move to Human review or be merged
// (flows.md step 8, PRD §7.9). The server fills these in from live GitHub
// data and the database; it never relies only on cached PR/CI state.
export interface MergeGateFacts {
  // The reviewer's approval is for the PR's current head commit
  approvalIsForHeadCommit: boolean
  requiredChecksPassed: boolean
  evidenceComplete: boolean
  mergeable: boolean
}

export type MergeGate = keyof MergeGateFacts

// Returns the gates that failed; an empty list means all passed
export function failedMergeGates(facts: MergeGateFacts): MergeGate[] {
  return (Object.keys(facts) as MergeGate[]).filter(gate => !facts[gate])
}
