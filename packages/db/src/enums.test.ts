import { DEFAULT_LIMITS, DESIGN_VERSION_STATUSES, EVIDENCE_KINDS, PLAN_CHANGES, PLAN_STATUSES, REVIEW_VERDICTS, TASK_KINDS, TASK_PRIORITIES } from '@corral/core'
import { describe, expect, it } from 'vitest'
import { designVersionStatus, evidenceKind, planChange, planStatus, projects, reviewVerdict, taskKind, taskPriority } from './schema.ts'

describe('database vocabularies', () => {
  it.each([
    ['plan_status', planStatus, PLAN_STATUSES],
    ['plan_change', planChange, PLAN_CHANGES],
    ['review_verdict', reviewVerdict, REVIEW_VERDICTS],
    ['evidence_kind', evidenceKind, EVIDENCE_KINDS],
    ['design_version_status', designVersionStatus, DESIGN_VERSION_STATUSES],
    ['task_kind', taskKind, TASK_KINDS],
    ['task_priority', taskPriority, TASK_PRIORITIES]
  ])('%s takes its values from core', (name, pgEnum, values) => {
    expect(pgEnum.enumName).toBe(name)
    expect(pgEnum.enumValues).toEqual([...values])
  })

  it('defaults project limits to DEFAULT_LIMITS', () => {
    expect(projects.reviewRoundCap.default).toBe(DEFAULT_LIMITS.reviewRoundCap)
    expect(projects.failedRunCap.default).toBe(DEFAULT_LIMITS.failedRunCap)
  })
})
