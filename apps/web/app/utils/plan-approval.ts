import type { Plan } from '@corral/contracts'

// Approving a plan from its session (design/plan.md)

export type ApproveTo = 'ready' | 'backlog'

// The tasks an approval adds, as the PM tells it: all but the removed ones
export function approvedMessage(plan: Plan, to: ApproveTo): string {
  const count = plan.tasks.filter(t => t.change !== 'removed').length
  return `${count} task${count === 1 ? '' : 's'} added to the ${to === 'ready' ? 'board' : 'Backlog'}`
}

interface Toast {
  add: (toast: { title: string, description?: string, color?: 'success' | 'error' }) => unknown
}

export interface ApproveDeps {
  approve: (planId: string, to: ApproveTo) => Promise<Plan>
  toast: Toast
  mobile: boolean
  // Clears ?plan, closing the plan sheet
  closeSheet: () => unknown
  // Goes to the new-thread Plan page
  push: (path: string) => unknown
}

// On a phone a successful approval closes the sheet and goes to a new Plan
// thread, with a toast confirming it, so the next request is a tap away.
// Desktop stays on the session, where the flyout shows the approved plan.
// A failed approval stays put with the sheet open.
export async function approvePlan(plan: Plan, to: ApproveTo, deps: ApproveDeps): Promise<boolean> {
  let approved: Plan
  try {
    approved = await deps.approve(plan.id, to)
  } catch (e) {
    deps.toast.add({ title: 'Could not approve', description: e instanceof Error ? e.message : String(e), color: 'error' })
    return false
  }
  if (deps.mobile) {
    deps.toast.add({ title: 'Plan approved', description: approvedMessage(approved, to), color: 'success' })
    await deps.closeSheet()
    await deps.push('/plan')
  }
  return true
}
