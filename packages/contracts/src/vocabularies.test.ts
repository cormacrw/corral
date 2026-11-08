import { describe, expect, it, vi } from 'vitest'

describe('shared vocabularies', () => {
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
      const { reviewVerdict } = await import('./tasks.ts')
      const { epicReviewReportSchema, outcomeReportSchema, rebaseReviewReportSchema, reportOutcomeInput } = await import('./outcome-report.ts')
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
