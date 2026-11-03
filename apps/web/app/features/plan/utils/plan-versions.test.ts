import type { Plan } from '@corral/contracts'
import { expect, it } from 'vitest'
import { currentTasks, latestPlan, previousPlan } from './plan-versions'

const plan = (version: number) => ({ id: `v${version}`, version, tasks: [] }) as unknown as Plan

it('finds the newest version and the one before it, in any order', () => {
  const plans = [plan(2), plan(3), plan(1)]
  expect(latestPlan(plans)?.id).toBe('v3')
  expect(previousPlan(plans, plans[1]!)?.id).toBe('v2')
  expect(previousPlan(plans, plans[2]!)).toBeNull()
  expect(latestPlan([])).toBeNull()
  expect(previousPlan(plans, null)).toBeNull()
})

it('leaves removed tasks out of the plan as it stands', () => {
  const tasks = [{ key: 'a', change: 'added' }, { key: 'b', change: 'removed' }]
  expect(currentTasks({ tasks } as unknown as Plan).map(t => t.key)).toEqual(['a'])
})
