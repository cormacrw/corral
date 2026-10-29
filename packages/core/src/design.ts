// Design versions (D20). Each submission to a design task is a new,
// immutable version, numbered 1..n per task. Only its status changes.
export const DESIGN_VERSION_STATUSES = ['submitted', 'changes_requested', 'approved', 'superseded'] as const
export type DesignVersionStatus = typeof DESIGN_VERSION_STATUSES[number]

export interface DesignVersionState {
  version: number
  status: DesignVersionStatus
}

export type DesignApprovalResult<V extends DesignVersionState> =
  | { ok: true, versions: V[] }
  | { ok: false, error: string }

// The number the next submission gets
export function nextDesignVersion(versions: readonly DesignVersionState[]): number {
  return versions.reduce((max, v) => Math.max(max, v.version), 0) + 1
}

// Approving a version marks it approved and supersedes every earlier one.
// Later versions are left alone. Returns every version with its new status.
export function approveDesignVersion<V extends DesignVersionState>(versions: readonly V[], version: number): DesignApprovalResult<V> {
  const target = versions.find(v => v.version === version)
  if (!target) return { ok: false, error: `Design version v${version} doesn't exist` }
  if (target.status === 'superseded') return { ok: false, error: `Design version v${version} has been superseded` }
  return {
    ok: true,
    versions: versions.map((v) => {
      if (v.version === version) return { ...v, status: 'approved' }
      if (v.version < version) return { ...v, status: 'superseded' }
      return v
    })
  }
}
