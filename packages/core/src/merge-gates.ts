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

// The order gates are checked and reported in; the first failure is the one
// the PR page leads with
export const MERGE_GATES = [
  'approvalIsForHeadCommit',
  'requiredChecksPassed',
  'evidenceComplete',
  'mergeable'
] as const satisfies readonly MergeGate[]

// Stops compiling when a fact in MergeGateFacts has no place in MERGE_GATES
type MustBeEmpty<Gates extends never> = Gates
export type UnorderedMergeGate = MustBeEmpty<Exclude<MergeGate, (typeof MERGE_GATES)[number]>>

// Returns the gates that failed, in MERGE_GATES order whatever the key order
// of `facts`; an empty list means all passed
export function failedMergeGates(facts: MergeGateFacts): MergeGate[] {
  return MERGE_GATES.filter(gate => !facts[gate])
}
