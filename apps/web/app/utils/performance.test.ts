import { describe, expect, it } from 'vitest'
import { formatLatency, formatVital, vitalRating } from './performance'

describe('vitalRating', () => {
  it.each([
    ['LCP', 2500, 'good'], ['LCP', 2501, 'needs-improvement'], ['LCP', 4000, 'needs-improvement'], ['LCP', 4001, 'poor'],
    ['INP', 200, 'good'], ['INP', 500, 'needs-improvement'], ['INP', 501, 'poor'],
    ['CLS', 0.1, 'good'], ['CLS', 0.25, 'needs-improvement'], ['CLS', 0.26, 'poor']
  ] as const)('rates %s %d as %s', (metric, value, rating) => {
    expect(vitalRating(metric, value)).toBe(rating)
  })
})

describe('formatting', () => {
  it('shows durations in milliseconds, then seconds', () => {
    expect(formatLatency(1.44)).toBe('1.4 ms')
    expect(formatLatency(212.4)).toBe('212 ms')
    expect(formatLatency(1240)).toBe('1.24 s')
    expect(formatLatency(null)).toBe('–')
  })

  it('shows CLS as a score', () => {
    expect(formatVital('CLS', 0.042)).toBe('0.04')
    expect(formatVital('LCP', 1840)).toBe('1.84 s')
  })
})
