import type { Plan } from '@corral/contracts'

// The flyout always shows the newest version; the chat only links to it
export const latestPlan = (plans: Plan[]): Plan | null =>
  plans.reduce<Plan | null>((a, p) => !a || p.version > a.version ? p : a, null)

export const previousPlan = (plans: Plan[], plan: Plan | null): Plan | null =>
  plan ? plans.find(p => p.version === plan.version - 1) ?? null : null

// Removed tasks only matter to the diff, not to the plan as it stands
export const currentTasks = (plan: Plan): Plan['tasks'] =>
  plan.tasks.filter(t => t.change !== 'removed')
