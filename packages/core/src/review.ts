// What a reviewer decides about a round (flows.md step 6)
export const REVIEW_VERDICTS = ['approved', 'changes_requested'] as const
export type ReviewVerdict = typeof REVIEW_VERDICTS[number]

// What a developer attaches to prove a criterion. A `note` is written
// evidence with no file (D21).
export const EVIDENCE_KINDS = ['screenshot', 'video', 'test_output', 'log', 'request', 'text', 'other', 'note'] as const
export type EvidenceKind = typeof EVIDENCE_KINDS[number]
