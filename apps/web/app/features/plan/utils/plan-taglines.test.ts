import { describe, expect, it } from 'vitest'
import { pickPlanTagline, planTaglines } from '~/features/plan/utils/plan-taglines'

describe('pickPlanTagline', () => {
  it('can pick every tagline, across the whole random range', () => {
    expect(planTaglines).toHaveLength(10)
    const picked = planTaglines.map((_, i) => pickPlanTagline(() => (i + 0.5) / planTaglines.length))
    expect(picked).toEqual([...planTaglines])
    expect(pickPlanTagline(() => 0)).toBe(planTaglines[0])
    expect(pickPlanTagline(() => 0.999999)).toBe(planTaglines[9])
  })
})
