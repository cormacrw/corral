import type { PullRequestStatus } from '@corral/contracts'
import type { MergeGate } from '@corral/core'
import type { Color } from './labels'

// Labels for the Pull requests page (design/pull-requests.md). Every state is
// shown as words; colour is never the only signal.
export interface Cell {
  label: string
  color: Color
  // More detail, for a tooltip or the line under the label
  detail?: string
}

// Why a gate blocks the merge, in the order core checks them
export const MERGE_GATE: Record<MergeGate, string> = {
  approvalIsForHeadCommit: 'No approval for the head commit',
  requiredChecksPassed: 'Required checks haven’t passed',
  evidenceComplete: 'Evidence is incomplete',
  mergeable: 'Can’t merge into the base branch'
}

export function reviewCell(pr: Pick<PullRequestStatus, 'review'>): Cell {
  const { review } = pr
  if (!review) return { label: 'Not reviewed', color: 'neutral' }
  const label = review.verdict === 'approved' ? 'Approved' : 'Changes requested'
  if (!review.forHeadCommit) return { label, color: 'neutral', detail: `For an older commit (${review.headSha.slice(0, 7)})` }
  return { label, color: review.verdict === 'approved' ? 'success' : 'error' }
}

export function ciCell(pr: Pick<PullRequestStatus, 'ci'>): Cell {
  const { checks, status } = pr.ci
  if (checks.length === 0) return { label: 'No required checks', color: 'neutral' }
  const detail = checks.map(c => `${c.name}: ${c.conclusion}`).join(', ')
  if (status === 'passing') return { label: 'Passing', color: 'success', detail }
  if (status === 'failing') return { label: 'Failing', color: 'error', detail }
  return { label: 'Pending', color: 'warning', detail }
}

export function rebaseCell(pr: Pick<PullRequestStatus, 'branch'>): Cell {
  switch (pr.branch.rebase) {
    case 'needed': return { label: 'Behind base', color: 'warning', detail: 'The base branch moved on' }
    case 'requested': return { label: 'Updating', color: 'info', detail: 'Corral asked GitHub to update the branch' }
    case 'conflict': return { label: 'Conflicts', color: 'error', detail: 'The developer has to rebase' }
    default: return { label: 'Up to date', color: 'success' }
  }
}

export function evidenceCell(pr: Pick<PullRequestStatus, 'evidenceComplete'>): Cell {
  return pr.evidenceComplete ? { label: 'Complete', color: 'success' } : { label: 'Incomplete', color: 'warning' }
}

// Eligible, waiting on the human, or blocked by the first failing gate.
// `detail` lists the other failed gates.
export function mergeCell(pr: Pick<PullRequestStatus, 'merge' | 'humanReviewOutstanding'>): Cell {
  const { merge } = pr
  if (!merge.eligible) {
    const gate = merge.failingGate ?? merge.failedGates[0]
    const others = merge.failedGates.filter(g => g !== gate)
    return {
      label: gate ? MERGE_GATE[gate] : 'Not eligible',
      color: 'error',
      detail: others.length > 0 ? `Also: ${others.map(g => MERGE_GATE[g].toLowerCase()).join('; ')}` : undefined
    }
  }
  if (pr.humanReviewOutstanding) return { label: 'Waiting for human review', color: 'warning' }
  return { label: 'Eligible', color: 'success' }
}
