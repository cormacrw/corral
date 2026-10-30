import { DEFAULT_LIMITS, EVIDENCE_KINDS, PLAN_CHANGES, PLAN_STATUSES, REVIEW_VERDICTS, TASK_PRIORITIES } from '@corral/core'
import { describe, expect, it, vi } from 'vitest'
import { createTaskInput, evidenceKind, planChange, planStatus, reviewVerdict } from './api.ts'

describe('shared vocabularies', () => {
  it.each([
    ['plan status', planStatus, PLAN_STATUSES],
    ['plan change', planChange, PLAN_CHANGES],
    ['review verdict', reviewVerdict, REVIEW_VERDICTS],
    ['evidence kind', evidenceKind, EVIDENCE_KINDS]
  ])('takes its %s values from core', (_, schema, values) => {
    expect(schema.options).toEqual([...values])
  })

  // The wire values, spelled out: these are stored and must not change
  it.each([
    ['proposed', planStatus], ['approved', planStatus], ['superseded', planStatus], ['discarded', planStatus],
    ['added', planChange], ['changed', planChange], ['unchanged', planChange], ['removed', planChange],
    ['approved', reviewVerdict], ['changes_requested', reviewVerdict],
    ['screenshot', evidenceKind], ['video', evidenceKind], ['test_output', evidenceKind], ['log', evidenceKind],
    ['request', evidenceKind], ['text', evidenceKind], ['other', evidenceKind], ['note', evidenceKind]
  ])('accepts %s', (value, schema) => {
    expect(schema.safeParse(value).success).toBe(true)
    expect(schema.safeParse(`${value}x`).success).toBe(false)
  })

  it('accepts every priority on a new task', () => {
    expect([...TASK_PRIORITIES]).toEqual(['urgent', 'high', 'medium', 'low'])
    for (const priority of TASK_PRIORITIES) {
      expect(createTaskInput.parse({ title: 'A task', type: 'task', priority }).priority).toBe(priority)
    }
  })

  it('keeps the default limits', () => {
    expect(DEFAULT_LIMITS).toEqual({ reviewRoundCap: 5, failedRunCap: 3 })
  })

  it('carries a verdict added only in core through to the report validators', async () => {
    const summary = 'Checked'
    const criteria = [{ criterionId: 'c1', met: true }]
    vi.resetModules()
    vi.doMock('@corral/core', async (importOriginal) => {
      const core = await importOriginal<typeof import('@corral/core')>()
      const REVIEW_VERDICTS = [...core.REVIEW_VERDICTS, 'probe_verdict']
      return { ...core, REVIEW_VERDICTS, RUN_OUTCOMES: [...core.RUN_OUTCOMES, 'probe_verdict'] }
    })
    try {
      const { reviewVerdict } = await import('./api.ts')
      const { epicReviewReportSchema, outcomeReportSchema, rebaseReviewReportSchema, reportOutcomeInput } = await import('./runner.ts')
      const outcome = 'probe_verdict'

      expect(reviewVerdict.safeParse(outcome).success).toBe(true)
      expect(reportOutcomeInput.safeParse({ outcome, summary }).success).toBe(true)
      expect(epicReviewReportSchema.safeParse({ outcome, summary }).success).toBe(true)

      for (const schema of [outcomeReportSchema, rebaseReviewReportSchema]) {
        expect(schema.safeParse({ outcome, summary, criteria }).success).toBe(true)
        expect(schema.safeParse({ outcome, summary }).error?.issues).toMatchObject([{ path: ['criteria'] }])
      }
      expect(rebaseReviewReportSchema.safeParse({ outcome: 'approved', summary }).success).toBe(true)
      expect(outcomeReportSchema.safeParse({ outcome: 'approved', summary }).success).toBe(false)
    } finally {
      vi.doUnmock('@corral/core')
      vi.resetModules()
    }
  })
})
