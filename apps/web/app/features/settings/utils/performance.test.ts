import { describe, expect, it } from 'vitest'
import { vitalRating } from '~/features/settings/utils/performance'

describe('vitalRating', () => {
  it.each([
    ['LCP', 2500, 'good'], ['LCP', 2501, 'needs-improvement'], ['LCP', 4000, 'needs-improvement'], ['LCP', 4001, 'poor'],
    ['INP', 200, 'good'], ['INP', 500, 'needs-improvement'], ['INP', 501, 'poor'],
    ['CLS', 0.1, 'good'], ['CLS', 0.25, 'needs-improvement'], ['CLS', 0.26, 'poor']
  ] as const)('rates %s %d as %s', (metric, value, rating) => {
    expect(vitalRating(metric, value)).toBe(rating)
  })
})
