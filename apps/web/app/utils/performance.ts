import type { PerfVitals } from '@corral/contracts'

export type VitalRating = 'good' | 'needs-improvement' | 'poor'

// Google's Web Vitals thresholds: good up to the first, poor above the second
const VITAL_THRESHOLDS: Record<keyof PerfVitals, [good: number, poor: number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25]
}

export const VITAL_RATING: Record<VitalRating, { label: string, color: 'success' | 'warning' | 'error' }> = {
  'good': { label: 'Good', color: 'success' },
  'needs-improvement': { label: 'Needs improvement', color: 'warning' },
  'poor': { label: 'Poor', color: 'error' }
}

export function vitalRating(metric: keyof PerfVitals, value: number): VitalRating {
  const [good, poor] = VITAL_THRESHOLDS[metric]
  if (value <= good) return 'good'
  return value <= poor ? 'needs-improvement' : 'poor'
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '–'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${ms < 10 ? Number(ms.toFixed(1)) : Math.round(ms)} ms`
}

export function formatVital(metric: keyof PerfVitals, value: number): string {
  return metric === 'CLS' ? value.toFixed(2) : formatMs(value)
}
